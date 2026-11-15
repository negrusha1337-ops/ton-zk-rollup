import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs';
import path from 'path';
import { EvmBatchReport } from '../wrappers/evmProofs';
import { collectWitness, crossCheck } from './block/verify';
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
import { chooseSegment, creditsOf, rebuildSegmentProblem } from './block/segment';
import {
    blockInput,
    classifyForced,
    hostIdentity,
    identityMismatches,
    loadProgramKeys,
    ProgramKeys,
    ProgramTools,
    reportIdentityMismatches,
    runProgram,
    withToolRetries,
} from './program';
import { FORCED_TX_GAS_CAP, GAS_LIMIT, ZERO_HASH } from './protocol';
import { BatchProof, Prover, ProverJob } from './prover';
import { MessageCursor, QueuedItem, QueueLagError, QueueMark, QueueSource, QueueWindow } from './queue/types';
import { NodeRpc } from './rpc';
import { checkGenesis } from './node';
import {
    BlockRecord,
    DEFAULT_STATE_DIR,
    deserialize,
    lockStateDir,
    Pending,
    Rebuild,
    SequencerState,
    serialize,
    StateStore,
    writeAtomically,
} from './state';
import { BatchSubmitter } from './submitter';

// Сборщик блоков L2 как сервис (этап 2, шаг 1). Один шаг — одно продвижение:
//   1. батч проверенного блока ещё не принят → сначала контракт (принят ли), затем срок 0.3: не
//      успеть — пересборка блока той же высоты; иначе пруф (интерфейс Prover) и отправка
//      (BatchSubmitter), после приёма — финальность узла;
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

export type Phase = 'built' | 'inserted' | 'tentative' | 'checked' | 'proven' | 'submitted';

/** fixtures/evm_batches/program.json — что записано о сборке программы (пишет только --vkeys). */
export const DEFAULT_PROGRAM_KEYS = path.join(__dirname, '..', 'fixtures', 'evm_batches', 'program.json');
/** Бюджет газа транзакций пула на блок по умолчанию (принцип 0.1: цена блока для прувера известна). */
export const DEFAULT_POOL_GAS_BUDGET = 5_000_000n;
/** Ожидаемое время пруфа батча по умолчанию, с: Groth16 блока EVM — 15 минут на ноутбуке. */
export const DEFAULT_EXPECTED_PROOF_TIME = 1800;
/** Запас до конца срока приёма перед отправкой по умолчанию, с. */
export const DEFAULT_SUBMIT_MARGIN = 300;
/** Сколько терпеть отставание источника сообщений очереди по умолчанию, с. */
export const DEFAULT_QUEUE_LAG_LIMIT = 1800;

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
    /** Срок приёма батча после времени блока, с — get-метод deployment контракта (maxBlockAge). */
    maxBlockAge: number;
    /** program.json сборки программы; по умолчанию — DEFAULT_PROGRAM_KEYS. */
    programKeysPath?: string;
    /** Кандидат старше этого (с от его времени) после перезапуска не продолжается; по умолчанию maxBlockAge / 4. */
    staleCandidateAge?: number;
    /** Запас до конца срока приёма перед отправкой (и сверх времени пруфа — перед пруфом), с; по умолчанию 300. */
    submitMargin?: number;
    /**
     * Ожидаемое время пруфа батча, с; по умолчанию 1800. Перед пруфом блок, батч которого не
     * успеть (время пруфа + запас), пересобирается. Время пруфа + запас обязаны быть меньше maxBlockAge.
     */
    expectedProofTime?: number;
    /** Сколько терпеть отставание источника сообщений очереди (QueueLagError), с; по умолчанию 1800. */
    queueLagLimit?: number;
    /** Наибольшее расхождение часов машины с временем L1 при старте, с; по умолчанию 60. */
    clockSkewLimit?: number;
    /** Бюджет газа транзакций пула на блок; по умолчанию DEFAULT_POOL_GAS_BUDGET. */
    poolGasBudget?: bigint;
    /** Сколько раз повторять запуск хоста или rsp после сбоя инструмента; по умолчанию 2. */
    toolRetries?: number;
    now?: () => number;
};

export type SequencerDeps = {
    node: NodeRpc;
    queue: QueueSource;
    prover: Prover;
    submitter: BatchSubmitter;
    /** Время последнего блока L1 (TON), с: в Sandbox — blockchain.now, в сети — у провайдера. */
    l1Now: () => Promise<number>;
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
          /** Блок пересобран: хеш прежнего блока той же высоты, батч которого контракт не примет. */
          replaced?: string;
      }
    /** Ждать: блок из будущего L1 либо батч мог уйти, а срок ещё не истёк. */
    | { kind: 'waiting'; number: number; reason: string }
    /** Собирать нечего. `unverifiedHead` — голова узла осталась на непроверенном кандидате. */
    | { kind: 'idle'; unverifiedHead?: string };

const hex = (value: bigint | number) => '0x' + BigInt(value).toString(16);
type RpcBlock = { hash: string; number: string; timestamp: string };

export class Sequencer {
    private readonly store: StateStore;
    private state!: SequencerState;
    private readonly now: () => number;
    private programKeys!: ProgramKeys;
    private release: (() => void) | null = null;

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

    /**
     * Взять каталог состояния, сверить хост с program.json и часы с L1, загрузить состояние,
     * сверить узел с ним и вернуть узел на проверенную цепочку.
     */
    async start(): Promise<void> {
        this.release = lockStateDir(this.config.stateDir);
        try {
            await this.startLocked();
        } catch (error) {
            this.close();
            throw error;
        }
    }

    /** Снять блокировку каталога состояния. Экземпляр после этого не продвигается. */
    close(): void {
        this.release?.();
        this.release = null;
    }

    private async startLocked(): Promise<void> {
        const proofTime = this.config.expectedProofTime ?? DEFAULT_EXPECTED_PROOF_TIME;
        const margin = this.config.submitMargin ?? DEFAULT_SUBMIT_MARGIN;
        if (proofTime + margin >= this.config.maxBlockAge)
            throw new SequencerStop(
                `время пруфа ${proofTime} с + запас ${margin} с не меньше maxBlockAge ${this.config.maxBlockAge} с: ` +
                    'каждый блок пересобирался бы до пруфа; уменьшите expectedProofTime либо разверните контракт с большим maxBlockAge',
            );
        await checkGenesis(this.deps.node, this.config.chainId);
        this.programKeys = loadProgramKeys(this.config.programKeysPath ?? DEFAULT_PROGRAM_KEYS);
        const identity = identityMismatches(await hostIdentity(this.config.tools), this.programKeys);
        if (identity.length > 0)
            throw new SequencerStop(`хост программы не тот, под который выведен ключ контракта: ${identity.join('; ')}; пересоберите хост`);
        const l1 = await this.deps.l1Now();
        const skew = this.now() - l1;
        const limit = this.config.clockSkewLimit ?? 60;
        if (Math.abs(skew) > limit)
            throw new SequencerStop(
                `часы машины расходятся со временем L1 на ${skew} с (предел ${limit}): время блоков и срок приёма считались бы неверно`,
            );
        this.state = this.store.load(this.config.chainId);
        this.state.rebuild ??= null;
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
        if (!this.release) throw new Error('сервис не запущен (start) либо закрыт (close)');
        const unaccepted = this.state.blocks.find((record) => record.status !== 'accepted');
        if (unaccepted) return this.proveAndSubmit(unaccepted);
        return this.nextBlock(options.allowEmpty ?? false);
    }

    // --- пруф и отправка ---

    /** Окно приёма батча (0.3): контракт берёт его, пока `время блока ≤ время L1 ≤ время блока + maxBlockAge`. */
    private window(report: EvmBatchReport): { timestamp: number; deadline: number } {
        const timestamp = Number(report.publicValues.blockTimestamp);
        return { timestamp, deadline: timestamp + this.config.maxBlockAge };
    }

    private assertReportIdentity(report: EvmBatchReport): void {
        const mismatches = reportIdentityMismatches(report, this.programKeys);
        if (mismatches.length > 0)
            throw new SequencerStop(`хост устарел: ${mismatches.join('; ')}; пересоберите хост и запустите сервис снова`);
    }

    /** Принял ли контракт батч (до проверки срока: сервис мог упасть между приёмом и записью). Другим блоком — остановка. */
    private async acceptedByContract(record: BlockRecord): Promise<boolean> {
        const contract = await this.deps.submitter.contractState();
        if (contract.batchIndex < record.number) return false;
        if (contract.batchIndex === record.number && contract.stateRoot !== BigInt(record.hash))
            throw new SequencerStop(
                `контракт принял батч ${record.number} с другим блоком 0x${contract.stateRoot.toString(16).padStart(64, '0')}, а у сервиса ${record.hash}`,
            );
        return true;
    }

    private async proveAndSubmit(record: BlockRecord): Promise<StepResult> {
        const job = JSON.parse(readFileSync(path.join(record.dir, 'job.json'), 'utf8')) as ProverJob;
        const report = JSON.parse(readFileSync(job.report, 'utf8')) as EvmBatchReport;
        this.assertReportIdentity(report);
        const { timestamp, deadline } = this.window(report);
        const margin = this.config.submitMargin ?? DEFAULT_SUBMIT_MARGIN;
        // Время L1 — до вопроса контракту: «не принят» тогда верно и на этот момент L1.
        let l1 = await this.deps.l1Now();
        if (await this.acceptedByContract(record)) return this.markAccepted(record, true);
        let proof: BatchProof;
        if (record.status === 'checked') {
            const proofTime = this.config.expectedProofTime ?? DEFAULT_EXPECTED_PROOF_TIME;
            // Батч ещё никуда не уходил: не успеть с пруфом — пересборка сразу.
            if (deadline < l1 + proofTime + margin)
                return this.rebuild(
                    record,
                    job,
                    `батч не успеть принять до пруфа: время блока ${timestamp} + maxBlockAge ${this.config.maxBlockAge} = ${deadline}, ` +
                        `а время L1 ${l1} + время пруфа ${proofTime} + запас ${margin} = ${l1 + proofTime + margin}`,
                );
            proof = await this.deps.prover.prove(job);
            writeAtomically(path.join(record.dir, 'proof.json'), serialize(proof));
            record.status = 'proven';
            this.save();
            this.fault('proven');
            l1 = await this.deps.l1Now();
            if (await this.acceptedByContract(record)) return this.markAccepted(record, true);
        } else {
            proof = deserialize<BatchProof>(readFileSync(path.join(record.dir, 'proof.json'), 'utf8'));
        }
        // Блок из будущего L1 (7329): контракт возьмёт его, когда L1 догонит. Ждать.
        if (timestamp > l1) return this.waiting(record, `время блока ${timestamp} позже времени L1 ${l1}: ждём L1`);
        if (deadline < l1 + margin) {
            // Не уходил — пересобрать сразу. Мог уйти — только по истечении срока: до того он ещё
            // может быть принят, и пересобранный блок разошёлся бы с контрактом.
            if (!record.submitting || deadline < l1)
                return this.rebuild(
                    record,
                    job,
                    `батч не успеть принять до отправки: время блока ${timestamp} + maxBlockAge ${this.config.maxBlockAge} = ${deadline}, ` +
                        `а время L1 ${l1} + запас ${margin} = ${l1 + margin}`,
                );
            return this.waiting(
                record,
                `батч мог уйти контракту, а срок ${deadline} ближе запаса ${margin} с (время L1 ${l1}): ждём приёма либо конца срока`,
            );
        }
        if (!record.submitting) {
            record.submitting = true;
            this.save();
        }
        const outcome = await this.deps.submitter.submit({ number: record.number, blockHash: record.hash, report, proof });
        if (!outcome.accepted) throw new SequencerStop(`батч ${record.number} не принят: ${outcome.reason}`);
        this.fault('submitted');
        return this.markAccepted(record, outcome.alreadyAccepted);
    }

    private waiting(record: BlockRecord, reason: string): StepResult {
        return this.log(`батч ${record.number}: ${reason}`), { kind: 'waiting', number: record.number, reason };
    }

    /** Батч принят контрактом: запись, finalized узла. */
    private async markAccepted(record: BlockRecord, alreadyAccepted: boolean): Promise<StepResult> {
        record.status = 'accepted';
        delete record.parent;
        delete record.segment;
        delete record.submitting;
        this.state.accepted = { number: record.number, hash: record.hash };
        const { tip } = this.state;
        const status = (await this.fcu(tip.hash, tip.hash, record.hash)).payloadStatus.status;
        if (status !== 'VALID')
            throw new SequencerStop(`узел не сдвинул финальность на блок ${record.number}: ${status}`);
        this.save();
        this.log(
            `батч ${record.number} принят контрактом${alreadyAccepted ? ' (раньше)' : ''}; финальность — блок ${record.number}`,
        );
        return { kind: 'accepted', number: record.number, hash: record.hash, alreadyAccepted };
    }

    /**
     * Батч блока контракт не примет (0.3) — блок той же высоты заново: свежее время, тот же отрезок,
     * пул заново. Условие — контракт его не принял (спрошено перед вызовом, после времени L1).
     * Блок — последний и единственный непринятый (конвейера нет): родитель — принятый батч.
     */
    private async rebuild(record: BlockRecord, job: ProverJob, reason: string): Promise<StepResult> {
        const last = this.state.blocks[this.state.blocks.length - 1];
        if (last !== record || !record.parent || !record.segment || this.state.accepted.number !== record.number - 1)
            throw new SequencerStop(
                `батч ${record.number} нужно пересобрать (${reason}), но у сервиса нет записи о родителе и отрезке блока либо блок не последний`,
            );
        await this.deps.prover.cancel?.(job);
        const { parent } = record;
        this.state.rebuild = {
            number: record.number,
            segment: record.segment,
            cut: this.state.tip.cut ?? false,
            replaces: record.hash,
            reason,
        };
        this.state.blocks.pop();
        this.state.tip = parent;
        this.state.pending = null;
        this.save();
        // Каталог прежнего блока — в сторону (после записи состояния: оно на него больше не ссылается).
        const staleDir = `${record.dir}.stale-${record.hash.slice(2, 10)}`;
        rmSync(staleDir, { recursive: true, force: true });
        renameSync(record.dir, staleDir);
        // safe узла — назад на родителя; голова та же (её reth назад не отдаёт), её вытеснит новый блок.
        const status = (await this.fcu(record.hash, parent.hash, this.state.accepted.hash)).payloadStatus.status;
        if (status !== 'VALID') throw new SequencerStop(`узел не отвёл safe с блока ${record.number}: ${status}`);
        this.log(`блок ${record.number} (${record.hash}) пересобирается: ${reason}`);
        const result = await this.nextBlock(true);
        return result.kind === 'checked' ? { ...result, replaced: record.hash } : result;
    }

    // --- следующий блок ---

    private async nextBlock(allowEmptyAsked: boolean): Promise<StepResult> {
        const number = this.state.tip.number + 1;
        // Пересобираемый блок собирается и пустым: прежний той же высоты обязан быть вытеснен.
        const allowEmpty = allowEmptyAsked || this.state.rebuild?.number === number;
        let attempt = 1;
        // Кандидат, отданный узлу до остановки, не собирается заново: проверка продолжается с его фазы.
        const resumed = this.state.pending;
        const staleAge = this.config.staleCandidateAge ?? Math.floor(this.config.maxBlockAge / 4);
        if (resumed && this.now() - Number(BigInt(resumed.payload.timestamp)) > staleAge) {
            // Устаревший кандидат: его батч мог бы не успеть к контракту. Собирается новый той же
            // высоты от той же вершины — он и вытеснит прежнего у узла.
            this.log(
                `блок ${resumed.number}: кандидат ${resumed.payload.blockHash} (фаза ${resumed.phase}) старше ${staleAge} с — собирается заново`,
            );
            this.state.pending = null;
            this.save();
            attempt = resumed.attempt;
        } else if (resumed) {
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
            if (!pending) return this.idle();
            const result = await this.checkCandidate(pending);
            if (result) return result;
        }
        throw new SequencerStop(`блок ${number}: программа отвергла и исправленного кандидата (без транзакций пула)`);
    }

    /**
     * Собирать нечего; голова узла может остаться на непроверенном кандидате — попытка вернуть её на
     * вершину. Reth v2.2.0 на это отвечает VALID и не меняет НИЧЕГО (debug_setHead — пустышка;
     * README): голову вытеснит следующий кандидат, safe и finalized уже на проверенном, шаг её называет.
     */
    private async idle(): Promise<StepResult> {
        const { tip, accepted } = this.state;
        const head = await this.deps.node.eth<RpcBlock | null>('eth_getBlockByNumber', ['latest', false]);
        if (!head || head.hash === tip.hash) return { kind: 'idle' };
        await this.fcu(tip.hash, tip.hash, accepted.hash);
        const after = await this.deps.node.eth<RpcBlock | null>('eth_getBlockByNumber', ['latest', false]);
        if (!after || after.hash === tip.hash) return { kind: 'idle' };
        this.log(
            `голова узла — непроверенный блок ${Number(after.number)} (${after.hash}): к вершине ${tip.number} узел её не возвращает; ` +
                'вытеснит следующий кандидат той же высоты; наружу — только safe',
        );
        return { kind: 'idle', unverifiedHead: after.hash };
    }

    /** Окно очереди. Отставание источника (QueueLagError) терпится queueLagLimit с первого раза — и через перезапуск. */
    private async readQueue(from: QueueMark, cursor: MessageCursor | null, max: number): Promise<QueueWindow> {
        try {
            const window = await this.deps.queue.read(from, cursor, max);
            if (this.state.queueLagSince !== undefined) {
                delete this.state.queueLagSince;
                this.save();
            }
            return window;
        } catch (error) {
            if (!(error instanceof QueueLagError)) throw error;
            const limit = this.config.queueLagLimit ?? DEFAULT_QUEUE_LAG_LIMIT;
            const since = (this.state.queueLagSince ??= this.now());
            this.save();
            const lag = this.now() - since;
            if (lag > limit)
                throw new SequencerStop(
                    `источник сообщений очереди L1 отстаёт ${lag} с (предел ${limit}): ${error.message}; ` +
                        'индексатор стоит или потерял сообщение — нужен человек',
                );
            this.log(`очередь L1: ${error.message} — отстаёт ${lag} с из ${limit}, повтор следующим шагом`);
            throw error;
        }
    }

    /** Отрезок пересобираемого блока — прежний, сверенный с контрактом (`rebuildSegmentProblem`). */
    private async rebuildSegment(rebuild: Rebuild): Promise<QueuedItem[]> {
        const { tip } = this.state;
        const window = await this.readQueue(tip.queue, tip.cursor, rebuild.segment.length);
        const problem = rebuildSegmentProblem(window, tip.queue, rebuild.segment);
        if (problem) throw new SequencerStop(`блок ${rebuild.number}: пересборка — ${problem}`);
        return rebuild.segment;
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
        const rebuild = this.state.rebuild?.number === number ? this.state.rebuild : null;
        const fixed = rebuild ? await this.rebuildSegment(rebuild) : null;
        const window = fixed
            ? null
            : await this.readQueue(tip.queue, tip.cursor, this.config.maxBatchQueueItems);
        const items = fixed ?? window!.items;
        const forcedWindow = items.filter(({ item }) => item.kind === 'forced');
        const verdicts = await this.tool(`блок ${number}: форма принудительных`, () =>
            classifyForced(
                this.config.tools,
                this.config.chainId,
                forcedWindow.map(({ item }) => (item.kind === 'forced' ? item.bytes : Buffer.alloc(0))),
                dir,
            ),
        );
        const signers = new Map<number, string>();
        verdicts.forEach((verdict, index) => {
            if (verdict.form === 'valid') signers.set(forcedWindow[index].item.number, verdict.signer);
        });
        const choice = fixed
            ? { items: fixed, cut: null, depositCut: rebuild!.cut }
            : chooseSegment(items, this.config.maxBatchQueueItems, signers, {
                  pending: window!.head.count - tip.queue.count,
                  previousCut: tip.cut ?? false,
              });
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
                    cut: choice.depositCut,
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
        const room = GAS_LIMIT - BigInt(forcedCount) * FORCED_TX_GAS_CAP;
        const limit = this.config.poolGasBudget ?? DEFAULT_POOL_GAS_BUDGET;
        const budget = room < limit ? room : limit;
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
            await this.insert(pending);
            this.fault('inserted');
        }
        if (pending.phase === 'inserted' || (await this.canonicalHash(pending.number)) !== hash) {
            // Временная голова: без неё узел не отдаёт ни блок, ни свидетеля. safe и finalized — прежние.
            let status = (await this.fcu(hash, tip.hash, accepted.hash)).payloadStatus.status;
            if (status !== 'VALID') {
                // Узел не знает кандидата: перезапущен после newPayload (неканонический блок
                // в памяти, на диск не попал). Фаза — назад к built, блок — заново из сохранённого ответа.
                this.log(
                    `блок ${pending.number}: узел не знает кандидата ${hash} (${status}) — newPayload из сохранённого ответа`,
                );
                pending.phase = 'built';
                this.save();
                await this.insert(pending);
                status = (await this.fcu(hash, tip.hash, accepted.hash)).payloadStatus.status;
            }
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
        const input = await this.tool(`блок ${pending.number}: вход блока (rsp)`, () =>
            blockInput(this.config.tools, {
                rpcUrl: this.config.rpcUrl,
                genesisPath: this.config.genesisPath,
                chainId: this.config.chainId,
                number: pending.number,
                workDir: pending.dir,
            }),
        );
        const witness = await collectWitness(this.deps.node, pending, tip);
        const verdict = await this.tool(`блок ${pending.number}: программа (хост)`, () =>
            runProgram(this.config.tools, {
                blockInput: input,
                chainId: this.config.chainId,
                witness,
                previousReport: tip.report,
                workDir: pending.dir,
                batchInput: path.join(pending.dir, 'batch.bin'),
                report: path.join(pending.dir, 'report.json'),
            }),
        );
        if (!verdict.accepted) return reject(verdict.reason);
        const report = verdict.report;
        // Отчёт не от той программы — виноват хост, а не кандидат: кандидат остаётся в работе.
        this.assertReportIdentity(report);

        // Собственный расчёт против программы.
        const { expected, mismatches } = await crossCheck(this.deps.node, this.config.chainId, pending, tip, report);
        const segmentForced = pending.segment.filter(({ item }) => item.kind === 'forced');
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
        // Как state.json: временный файл, fsync, переименование, fsync каталога.
        writeAtomically(path.join(blockDir, 'report.json'), readFileSync(path.join(pending.dir, 'report.json')));
        writeAtomically(path.join(blockDir, 'batch.bin'), readFileSync(path.join(pending.dir, 'batch.bin')));
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
            ...(pending.cut ? { cut: true } : {}),
        };
        this.state.blocks.push({
            number: pending.number,
            hash,
            status: 'checked',
            dir: blockDir,
            parent: tip,
            segment: pending.segment,
        });
        this.state.pending = null;
        this.state.rebuild = null;
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

    /** newPayload из сохранённого ответа узла; не VALID — остановка. Фаза — inserted. */
    private async insert(pending: Pending): Promise<void> {
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
    }

    /** Запуск хоста или rsp с повтором после сбоя инструмента (`withToolRetries`). */
    private tool<T>(what: string, call: () => Promise<T>): Promise<T> {
        return withToolRetries(this.config.toolRetries ?? 2, what, call, (line) => this.log(line), (text) => new SequencerStop(text));
    }

    private async canonicalHash(number: number): Promise<string | null> {
        const block = await this.deps.node.eth<RpcBlock | null>('eth_getBlockByNumber', [hex(number), false]);
        return block?.hash ?? null;
    }
}
