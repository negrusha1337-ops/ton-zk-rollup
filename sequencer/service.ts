import { appendFileSync, copyFileSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { EvmBatchReport } from '../wrappers/evmProofs';
import { bridgeLeaves, expectedPublicValues, LogEntry, reportMismatches } from './block/expected';
import {
    blockTimestamp,
    buildRequest,
    BuildRequest,
    checkPayload,
    ExecutionPayload,
    filterPool,
    forcedToDrop,
    PoolTransaction,
} from './block/payload';
import { chooseSegment, creditsOf } from './block/segment';
import { blockInput, classifyForced, ProgramTools, RollupWitness, runProgram } from './program';
import { FORCED_TX_GAS_CAP, GAS_LIMIT, ZERO_HASH } from './protocol';
import { BatchProof, Prover, ProverJob } from './prover';
import { QueuedItem, QueueSource } from './queue/types';
import { NodeRpc } from './rpc';
import { checkGenesis } from './node';
import {
    BlockRecord,
    DEFAULT_STATE_DIR,
    deserialize,
    Pending,
    SequencerState,
    serialize,
    StateStore,
    writeAtomically,
} from './state';
import { BatchSubmitter } from './submitter';

// Сборщик блоков L2 как сервис (этап 2, шаг 1). Один шаг — одно продвижение:
//   1. батч проверенного блока ещё не принят → пруф (интерфейс Prover) и отправка (BatchSubmitter),
//      после приёма — финальность узла;
//   2. иначе кандидат следующего блока: отрезок очереди L1 → форма принудительных (программа) →
//      testing_buildBlockV1 → сверка ответа → engine_newPayloadV3 → временная голова →
//      свидетель (rsp) → нативный расчёт программы (хост) → сверка 11 слов с собственным
//      расчётом → только теперь блок «проверен»: safe узла, вершина сервиса, задание пруверу.
//
// Почему голова временная. В reth v2.2.0 блок, переданный newPayload, но не ставший
// каноническим, через RPC не виден ни по номеру, ни по хешу: debug_executionWitness (и
// debug_executionWitnessByBlockHash) отвечают «block not found», а rsp берёт блок по номеру.
// Поэтому кандидат делается головой (forkchoiceUpdated с head = кандидат, safe и finalized —
// прежние) ДО проверки программой. Откатить голову к предку forkchoiceUpdated не может (даже с
// --engine.allow-unwind-canonical-header — проверено), а перейти на соседа — может: отвергнутый
// кандидат вытесняется следующим кандидатом той же высоты от того же родителя. Гарантия
// сервиса: следующий блок строится только на ПРОВЕРЕННОМ, safe и finalized двигаются только
// после проверки (finalized — после приёма батча контрактом, PROTOCOL-V2.md, правка 0.3), батч
// и задание пруверу появляются только у проверенного блока. RPC узла наружу не открыт.

export type Phase = 'built' | 'inserted' | 'tentative' | 'checked' | 'proven';

/** Остановка сервиса: дальше без человека нельзя (текст — что случилось). */
export class SequencerStop extends Error {}
/** Только для тестов: искусственная остановка после фазы. */
export class Interrupted extends Error {
    constructor(readonly phase: Phase) {
        super(`прервано после фазы ${phase}`);
    }
}

export type SequencerConfig = {
    chainId: bigint;
    /** Получатель чаевых — адрес секвенсора на L2. */
    feeRecipient: string;
    /** Каталог состояния; по умолчанию — DEFAULT_STATE_DIR (.tools/sequencer/). */
    stateDir: string;
    /** HTTP JSON-RPC узла: им же ходит rsp. */
    rpcUrl: string;
    genesisPath: string;
    /** Брать транзакции секвенсора из пула узла. */
    includePool: boolean;
    tools: ProgramTools;
    /** Предел отрезка очереди — get-метод queueLimits контракта. */
    maxBatchQueueItems: number;
    now?: () => number;
};

export type SequencerDeps = {
    node: NodeRpc;
    queue: QueueSource;
    prover: Prover;
    submitter: BatchSubmitter;
    log?: (line: string) => void;
    /** Только для тестов: остановиться после фазы; подменить запрос к узлу на попытке. */
    faults?: { stopAfter?: Phase; tamper?: (request: BuildRequest, attempt: number) => BuildRequest };
};

export type StepResult =
    | { kind: 'accepted'; number: number; hash: string; alreadyAccepted: boolean }
    | {
          kind: 'checked';
          number: number;
          hash: string;
          attempts: number;
          queueItems: number;
          included: number;
          pool: number;
      }
    | { kind: 'idle' };

const hex = (value: bigint | number) => '0x' + BigInt(value).toString(16);
type RpcBlock = { hash: string; number: string; timestamp: string };

export class Sequencer {
    private readonly store: StateStore;
    private state!: SequencerState;
    private readonly now: () => number;

    constructor(
        private readonly config: SequencerConfig,
        private readonly deps: SequencerDeps,
    ) {
        if (!config.stateDir) throw new Error(`не задан каталог состояния (по умолчанию — ${DEFAULT_STATE_DIR})`);
        this.store = new StateStore(config.stateDir);
        this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
    }

    get snapshot(): SequencerState {
        return deserialize(serialize(this.state));
    }

    private log(line: string) {
        const stamped = `${new Date().toISOString()} ${line}`;
        mkdirSync(this.config.stateDir, { recursive: true });
        appendFileSync(path.join(this.config.stateDir, 'sequencer.log'), stamped + '\n');
        this.deps.log?.(line);
    }

    private save() {
        this.store.save(this.state);
    }

    private fault(phase: Phase) {
        if (this.deps.faults?.stopAfter === phase) throw new Interrupted(phase);
    }

    private fcu(head: string, safe: string, finalized: string) {
        return this.deps.node.engine<{ payloadStatus: { status: string } }>('engine_forkchoiceUpdatedV3', [
            { headBlockHash: head, safeBlockHash: safe, finalizedBlockHash: finalized },
            null,
        ]);
    }

    /** Загрузить состояние, сверить узел с ним и вернуть узел на проверенную цепочку. */
    async start(): Promise<void> {
        await checkGenesis(this.deps.node, this.config.chainId);
        this.state = this.store.load(this.config.chainId);
        const { tip, accepted } = this.state;
        let status = (await this.fcu(tip.hash, tip.hash, accepted.hash)).payloadStatus.status;
        if (status !== 'VALID') {
            // Узел не знает проверенной цепочки (база потеряна): блоки — из каталогов сервиса.
            this.log(`узел не знает блока ${tip.number} (${status}): блоки 1–${tip.number} отдаются заново`);
            for (const record of this.state.blocks) {
                const payload = deserialize<ExecutionPayload>(
                    readFileSync(path.join(record.dir, 'payload.json'), 'utf8'),
                );
                const inserted = await this.deps.node.engine<{ status: string }>('engine_newPayloadV3', [
                    payload,
                    [],
                    ZERO_HASH,
                ]);
                if (inserted.status !== 'VALID')
                    throw new SequencerStop(`узел не принял сохранённый блок ${record.number}: ${inserted.status}`);
            }
            status = (await this.fcu(tip.hash, tip.hash, accepted.hash)).payloadStatus.status;
        }
        if (status !== 'VALID') throw new SequencerStop(`узел не перешёл на проверенную цепочку: ${status}`);
        this.save();
        this.log(
            `старт: проверен блок ${tip.number} (${tip.hash}), принят батч ${accepted.number}, очередь до ${tip.queue.count}`,
        );
    }

    /** Одно продвижение. `allowEmpty` — собирать блок и без элементов очереди и транзакций пула. */
    async step(options: { allowEmpty?: boolean } = {}): Promise<StepResult> {
        const unaccepted = this.state.blocks.find((record) => record.status !== 'accepted');
        if (unaccepted) return this.proveAndSubmit(unaccepted);
        return this.nextBlock(options.allowEmpty ?? false);
    }

    // --- пруф и отправка ---

    private async proveAndSubmit(record: BlockRecord): Promise<StepResult> {
        const job = JSON.parse(readFileSync(path.join(record.dir, 'job.json'), 'utf8')) as ProverJob;
        let proof: BatchProof;
        if (record.status === 'checked') {
            proof = await this.deps.prover.prove(job);
            writeAtomically(path.join(record.dir, 'proof.json'), serialize(proof));
            record.status = 'proven';
            this.save();
            this.fault('proven');
        } else {
            proof = deserialize<BatchProof>(readFileSync(path.join(record.dir, 'proof.json'), 'utf8'));
        }
        const report = JSON.parse(readFileSync(job.report, 'utf8')) as EvmBatchReport;
        const outcome = await this.deps.submitter.submit({
            number: record.number,
            blockHash: record.hash,
            report,
            proof,
        });
        if (!outcome.accepted) throw new SequencerStop(`батч ${record.number} не принят: ${outcome.reason}`);
        record.status = 'accepted';
        this.state.accepted = { number: record.number, hash: record.hash };
        const { tip } = this.state;
        const status = (await this.fcu(tip.hash, tip.hash, record.hash)).payloadStatus.status;
        if (status !== 'VALID')
            throw new SequencerStop(`узел не сдвинул финальность на блок ${record.number}: ${status}`);
        this.save();
        this.log(
            `батч ${record.number} принят контрактом${outcome.alreadyAccepted ? ' (раньше)' : ''}; финальность — блок ${record.number}`,
        );
        return { kind: 'accepted', number: record.number, hash: record.hash, alreadyAccepted: outcome.alreadyAccepted };
    }

    // --- следующий блок ---

    private async nextBlock(allowEmpty: boolean): Promise<StepResult> {
        const number = this.state.tip.number + 1;
        let attempt = 1;
        // Кандидат, отданный узлу до остановки, не собирается заново: проверка продолжается с его фазы.
        const resumed = this.state.pending;
        if (resumed) {
            this.log(
                `блок ${resumed.number}: продолжается кандидат ${resumed.payload.blockHash} с фазы ${resumed.phase}`,
            );
            const result = await this.checkCandidate(resumed);
            if (result) return result;
            attempt = resumed.attempt + 1;
        }
        for (; attempt <= 2; attempt++) {
            const withPool = this.config.includePool && attempt === 1;
            const pending = await this.buildCandidate(number, attempt, withPool, allowEmpty);
            if (!pending) return { kind: 'idle' };
            const result = await this.checkCandidate(pending);
            if (result) return result;
        }
        throw new SequencerStop(`блок ${number}: программа отвергла и исправленного кандидата (без транзакций пула)`);
    }

    /** Кандидат: отрезок, форма, сборка до совпадения с запросом. Сохраняется в фазе built. */
    private async buildCandidate(
        number: number,
        attempt: number,
        withPool: boolean,
        allowEmpty: boolean,
    ): Promise<Pending | null> {
        const { tip } = this.state;
        const dir = this.store.candidateDir(number, attempt);
        const window = await this.deps.queue.read(tip.queue, tip.cursor, this.config.maxBatchQueueItems);
        const forcedWindow = window.items.filter(({ item }) => item.kind === 'forced');
        const verdicts = await classifyForced(
            this.config.tools,
            this.config.chainId,
            forcedWindow.map(({ item }) => (item.kind === 'forced' ? item.bytes : Buffer.alloc(0))),
            dir,
        );
        const signers = new Map<number, string>();
        verdicts.forEach((verdict, index) => {
            if (verdict.form === 'valid') signers.set(forcedWindow[index].item.number, verdict.signer);
        });
        const choice = chooseSegment(window.items, this.config.maxBatchQueueItems, signers);
        if (choice.cut) this.log(`блок ${number}: отрезок до ${tip.queue.count + choice.items.length} — ${choice.cut}`);
        const segment = choice.items;
        // Принудительные, годные по форме, — кандидаты в блок; остальные программа пропустит.
        let forced: QueuedItem[] = segment.filter(({ item }) => item.kind === 'forced' && signers.has(item.number));
        const pool = withPool ? await this.poolTransactions(forced.length) : [];
        if (segment.length === 0 && pool.length === 0 && !allowEmpty) return null;

        const parent = await this.deps.node.eth<RpcBlock>('eth_getBlockByNumber', [hex(tip.number), false]);
        if (parent.hash !== tip.hash)
            throw new SequencerStop(`узел хранит на высоте ${tip.number} другой блок: ${parent.hash}`);
        const credits = creditsOf(segment);
        for (let rebuild = 0; ; rebuild++) {
            const raw = forced.map(({ item }) => '0x' + (item.kind === 'forced' ? item.bytes.toString('hex') : ''));
            let request = buildRequest({
                parentHash: tip.hash,
                timestamp: blockTimestamp(Number(parent.timestamp), this.now()),
                feeRecipient: this.config.feeRecipient,
                credits,
                forced: raw,
                pool,
            });
            if (this.deps.faults?.tamper) request = this.deps.faults.tamper(request, attempt);
            const envelope = await this.deps.node.eth<{ executionPayload: ExecutionPayload }>('testing_buildBlockV1', [
                request,
            ]);
            const check = checkPayload(request, raw.length, envelope.executionPayload);
            if (check.problems.length > 0)
                throw new SequencerStop(`блок ${number}: узел собрал не то — ${check.problems.join('; ')}`);
            if (check.droppedForced.length === 0) {
                const pending: Pending = {
                    number,
                    attempt,
                    phase: 'built',
                    withPool,
                    request,
                    forcedCount: raw.length,
                    payload: envelope.executionPayload,
                    segment,
                    signers: [
                        ...new Set(
                            segment.flatMap(({ item }) =>
                                signers.has(item.number) ? [signers.get(item.number)!] : [],
                            ),
                        ),
                    ],
                    dir,
                };
                this.state.pending = pending;
                this.save();
                this.log(
                    `блок ${number}, попытка ${attempt}: кандидат ${pending.payload.blockHash} — элементов очереди ${segment.length}, ` +
                        `принудительных в блоке ${raw.length}, из пула ${check.poolIncluded}, сборок ${rebuild + 1}`,
                );
                this.fault('built');
                return pending;
            }
            // Узел отказал части принудительных тем же revm, что и программа: первую у каждого
            // отправителя программа пропустит; остальные того же отправителя — пробуются снова.
            const drop = new Set(
                forcedToDrop(
                    check.droppedForced,
                    forced.map(({ item }) => signers.get(item.number)!),
                ),
            );
            forced = forced.filter((_, index) => !drop.has(index));
            if (rebuild > this.config.maxBatchQueueItems)
                throw new SequencerStop(`блок ${number}: состав принудительных не сошёлся`);
        }
    }

    /** Транзакции пула после фильтра, байтами. */
    private async poolTransactions(forcedCount: number): Promise<string[]> {
        const content = await this.deps.node.eth<{ pending: Record<string, Record<string, PoolTransaction>> }>(
            'txpool_content',
            [],
        );
        const all = Object.values(content.pending ?? {}).flatMap((byNonce) => Object.values(byNonce));
        const budget = GAS_LIMIT - BigInt(forcedCount) * FORCED_TX_GAS_CAP;
        const chosen = filterPool(all, this.config.chainId, budget);
        const raw: string[] = [];
        for (const transaction of chosen)
            raw.push(await this.deps.node.eth<string>('eth_getRawTransactionByHash', [transaction.hash]));
        return raw;
    }

    /**
     * Проверка кандидата программой. null — отвергнут (причина в журнале и в state.rejections),
     * вершина не сдвинута. Возобновляется с записанной фазы.
     */
    private async checkCandidate(pending: Pending): Promise<StepResult | null> {
        const { tip, accepted } = this.state;
        const hash = pending.payload.blockHash;
        if (pending.phase === 'built') {
            const inserted = await this.deps.node.engine<{ status: string }>('engine_newPayloadV3', [
                pending.payload,
                [],
                ZERO_HASH,
            ]);
            if (inserted.status !== 'VALID')
                throw new SequencerStop(
                    `узел не принял собранный им же блок ${pending.number}: ${JSON.stringify(inserted)}`,
                );
            pending.phase = 'inserted';
            this.save();
            this.fault('inserted');
        }
        if (pending.phase === 'inserted' || (await this.canonicalHash(pending.number)) !== hash) {
            // Временная голова: без неё узел не отдаёт ни блок, ни свидетеля. safe и finalized — прежние.
            const status = (await this.fcu(hash, tip.hash, accepted.hash)).payloadStatus.status;
            if (status !== 'VALID')
                throw new SequencerStop(`узел не сделал кандидата ${pending.number} головой: ${status}`);
            pending.phase = 'tentative';
            this.save();
            this.fault('tentative');
        }
        if ((await this.canonicalHash(pending.number)) !== hash)
            throw new SequencerStop(`на высоте ${pending.number} у узла не кандидат`);

        const reject = (reason: string): null => {
            this.state.rejections.push({
                number: pending.number,
                attempt: pending.attempt,
                hash,
                reason,
                at: new Date().toISOString(),
            });
            this.state.pending = null;
            this.save();
            this.log(
                `блок ${pending.number}, попытка ${pending.attempt}: программа отвергла кандидата ${hash} — ${reason}; вершина остаётся ${tip.number}`,
            );
            return null;
        };

        // Свидетель: вход блока от узла (rsp) и доказательства счетов отправителей на родителе.
        const input = await blockInput(this.config.tools, {
            rpcUrl: this.config.rpcUrl,
            genesisPath: this.config.genesisPath,
            chainId: this.config.chainId,
            number: pending.number,
            workDir: pending.dir,
        });
        const accountProofs: RollupWitness['accountProofs'] = [];
        for (const address of pending.signers) {
            const proof = await this.deps.node.eth<{ accountProof: string[] }>('eth_getProof', [
                address,
                [],
                hex(tip.number),
            ]);
            const code = await this.deps.node.eth<string>('eth_getCode', [address, hex(tip.number)]);
            accountProofs.push({ address, accountProof: proof.accountProof, ...(code === '0x' ? {} : { code }) });
        }
        const witness: RollupWitness = {
            prevDepositHash: '0x' + tip.queue.hash.toString(16).padStart(64, '0'),
            queueProcessedFrom: tip.queue.count,
            queue: pending.segment.map(({ item }) =>
                item.kind === 'deposit'
                    ? { deposit: { l2Recipient: item.l2Recipient, amount: item.amount.toString() } }
                    : { forcedTransaction: '0x' + item.bytes.toString('hex') },
            ),
            withdrawalsFrontier: tip.tree.frontier.map((node) => '0x' + node.toString(16).padStart(64, '0')),
            withdrawalsCount: tip.tree.count.toString(),
            accountProofs,
        };
        const verdict = await runProgram(this.config.tools, {
            blockInput: input,
            chainId: this.config.chainId,
            witness,
            previousReport: tip.report,
            workDir: pending.dir,
            batchInput: path.join(pending.dir, 'batch.bin'),
            report: path.join(pending.dir, 'report.json'),
        });
        if (!verdict.accepted) return reject(verdict.reason);
        const report = verdict.report;

        // Собственный расчёт против программы.
        const receipts = await this.deps.node.eth<{ logs: LogEntry[] }[]>('eth_getBlockReceipts', [
            hex(pending.number),
        ]);
        const expected = expectedPublicValues({
            chainId: this.config.chainId,
            parentHash: tip.hash,
            candidateHash: hash,
            timestamp: Number(BigInt(pending.payload.timestamp)),
            queueFrom: tip.queue,
            segment: pending.segment,
            treeBefore: tip.tree,
            leaves: bridgeLeaves(receipts),
            dataChunks: report.dataChunksHex.map((chunk) => Buffer.from(chunk, 'hex')),
        });
        const mismatches = reportMismatches(report, expected, tip.queue);
        const rawBlock = await this.deps.node.eth<string>('debug_getRawBlock', [hash]);
        if (rawBlock.replace(/^0x/, '') !== report.dataChunksHex.join(''))
            mismatches.push('данные батча — не RLP блока со слов узла');
        // Судьба принудительных: включены ровно те, что стоят в блоке.
        const inBlock = new Set(pending.request.transactions.slice(0, pending.forcedCount));
        const segmentForced = pending.segment.filter(({ item }) => item.kind === 'forced');
        report.forced.forEach((outcome, index) => {
            const item = segmentForced[index]?.item;
            const raw = item && item.kind === 'forced' ? '0x' + item.bytes.toString('hex') : '';
            if ((outcome.outcome === 'included') !== inBlock.has(raw))
                mismatches.push(
                    `принудительная №${item?.number}: программа — ${outcome.outcome}, в блоке — ${inBlock.has(raw) ? 'есть' : 'нет'}`,
                );
        });
        if (report.forced.length !== segmentForced.length)
            mismatches.push('в отчёте программы не все принудительные отрезка');
        if (mismatches.length > 0) {
            reject(`расчёт сервиса не сошёлся с программой: ${mismatches.join('; ')}`);
            throw new SequencerStop(
                `блок ${pending.number}: расчёт сервиса не сошёлся с программой — ${mismatches.join('; ')}`,
            );
        }

        // Принят: блок проверен. Каталог блока — то, что нужно пруверу и отправщику.
        const blockDir = this.store.blockDir(pending.number);
        mkdirSync(blockDir, { recursive: true });
        writeAtomically(path.join(blockDir, 'payload.json'), serialize(pending.payload));
        copyFileSync(path.join(pending.dir, 'report.json'), path.join(blockDir, 'report.json'));
        copyFileSync(path.join(pending.dir, 'batch.bin'), path.join(blockDir, 'batch.bin'));
        const job: ProverJob = {
            number: pending.number,
            blockHash: hash,
            batchInput: path.join(blockDir, 'batch.bin'),
            report: path.join(blockDir, 'report.json'),
            publicValuesBytes: report.publicValuesBytes,
            programElfSha256: report.programElfSha256,
        };
        writeAtomically(path.join(blockDir, 'job.json'), JSON.stringify(job, null, 1) + '\n');
        const lastItem = pending.segment[pending.segment.length - 1];
        this.state.tip = {
            number: pending.number,
            hash,
            timestamp: Number(BigInt(pending.payload.timestamp)),
            queue: expected.queue,
            cursor: lastItem ? lastItem.message : tip.cursor,
            tree: expected.treeAfter,
            report: path.join(blockDir, 'report.json'),
        };
        this.state.blocks.push({ number: pending.number, hash, status: 'checked', dir: blockDir });
        this.state.pending = null;
        this.save();
        const status = (await this.fcu(hash, hash, accepted.hash)).payloadStatus.status;
        if (status !== 'VALID')
            throw new SequencerStop(`узел не сделал проверенный блок ${pending.number} safe: ${status}`);
        const included = report.forced.filter((outcome) => outcome.outcome === 'included').length;
        this.log(
            `блок ${pending.number} проверен программой: ${hash}, очередь ${tip.queue.count}..${expected.queue.count}, ` +
                `принудительных включено ${included} из ${segmentForced.length}, выводов ${report.withdrawals.length}`,
        );
        this.fault('checked');
        return {
            kind: 'checked',
            number: pending.number,
            hash,
            attempts: pending.attempt,
            queueItems: pending.segment.length,
            included,
            pool: pending.payload.transactions.length - pending.forcedCount,
        };
    }

    private async canonicalHash(number: number): Promise<string | null> {
        const block = await this.deps.node.eth<RpcBlock | null>('eth_getBlockByNumber', [hex(number), false]);
        return block?.hash ?? null;
    }
}
