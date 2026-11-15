import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { EvmBatchReport } from '../wrappers/evmProofs';
import { Rollup } from '../wrappers/Rollup';
import { forcedTransactionCell } from '../wrappers/rollupMath';
import { BuildRequest, ExecutionPayload } from '../sequencer/block/payload';
import { liveChildren } from '../sequencer/children';
import { NodeOptions, RunningNode, startNode } from '../sequencer/node';
import { randomChainId, usedChainIds } from '../sequencer/chainId';
import { BRIDGE_ADDRESS, GENESIS_HASH } from '../sequencer/protocol';
import { MockProver } from '../sequencer/prover';
import { SandboxFeed, SandboxQueueSource } from '../sequencer/queue/sandbox';
import { NodeRpc } from '../sequencer/rpc';
import { Interrupted, Phase, Sequencer, SequencerConfig, SequencerDeps, SequencerStop } from '../sequencer/service';
import { BatchSubmitter, SandboxSubmitter } from '../sequencer/submitter';
import { finalizeDummyKeys, ProtocolConstants, readProtocolConstants, testConfig } from './helpers/rollupSetup';

// Сборщик блоков (sequencer/) целиком: настоящий узел reth v2.2.0 с генезисом протокола, хост
// программы и rsp, двойник контракта в Sandbox (пруф — заглушка). Очередь L1 ставится
// сообщениями; сервис сам читает её, собирает блоки, проверяет каждый программой до того, как
// он станет проверенной вершиной, и отправляет батчи. Случаи: депозиты; принудительные — годная,
// мусор, негодная подпись, «nonce выше», две одинаковые в одном отрезке (H1); отрезок, обрезанный
// перед принудительной от счёта с депозитом; перезапуск сервиса и УЗЛА в фазах inserted,
// tentative, checked, proven (M1); кандидат, которого программа отвергает, — вершина и safe не
// двигаются; вторая попытка без пула и пул при выключенном флаге (T6); подменённые ответы узла и
// отчёт хоста (T2, T4) — остановка с точным текстом; finalized — только после приёма батча (T1).
//
// Нужны бинарники вне репозитория: .tools/reth/bin/reth, .tools/rsp/target/release/rsp и хост
// zkvm-evm/target/release/rollup-evm-host (PROVING.md). Без них набор — todo с причиной.
const ROOT = path.join(__dirname, '..');
const TOOLS = {
    reth: path.join(ROOT, '.tools', 'reth', 'bin', 'reth'),
    rsp: path.join(ROOT, '.tools', 'rsp', 'target', 'release', 'rsp'),
    host: path.join(ROOT, 'zkvm-evm', 'target', 'release', 'rollup-evm-host'),
};
const missing = Object.entries(TOOLS)
    .filter(([, file]) => !existsSync(file))
    .map(([name]) => name);
// chainId — случайный, как у нового развёртывания (круг 23, пункт 2): узел, rsp, хост и программа
// обязаны принимать любой, а генезис от него не зависит (checkGenesis при старте узла — GENESIS_HASH).
const CHAIN_ID = randomChainId(usedChainIds());
const GWEI = 1_000_000_000n;
// Каталог тестов — отдельно от каталога сервиса по умолчанию (.tools/sequencer).
const WORK = path.join(ROOT, '.tools', 'sequencer-test', 'reth');
const SUITE = 'сборщик блоков на узле Reth: очередь L1 → блоки, проверенные программой → батчи на двойнике';

type Wallet = { address: string; sign: (transactions: object[]) => string[] };
/** Счёт L2 с ключом в памяти; подпись — sequencer/testing/evm-wallet.mjs (jest не грузит @noble/curves). */
function wallet(): Wallet {
    const secret = randomBytes(32).toString('hex');
    const call = (transactions: object[]) =>
        JSON.parse(
            execFileSync('node', [path.join(ROOT, 'sequencer', 'testing', 'evm-wallet.mjs')], {
                input: JSON.stringify({ secret, transactions }),
            }).toString(),
        ) as {
            address: string;
            raw: string[];
        };
    const { address } = call([]);
    return {
        address,
        sign: (transactions) => call(transactions.map((fields) => ({ chainId: CHAIN_ID.toString(), ...fields }))).raw,
    };
}
const bytes = (raw: string) => Buffer.from(raw.replace(/^0x/, ''), 'hex');

/** Как хост портит отчёт (обёртка над настоящим хостом, T2). */
type ReportTamper = 'none' | 'word' | 'mark' | 'frontier' | 'forcedOutcome' | 'forcedLength';

/**
 * Скрипт на месте хоста: зовёт настоящий хост с теми же аргументами и, в режиме расчёта блока,
 * портит его отчёт так, как записано в файле режима. Форма принудительных и --identity — как есть.
 */
function hostWrapper(dir: string): { host: string; set: (mode: ReportTamper) => void } {
    mkdirSync(dir, { recursive: true });
    const modeFile = path.join(dir, 'tamper.txt');
    const host = path.join(dir, 'host-wrapper.js');
    writeFileSync(
        host,
        `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const args = process.argv.slice(2);
const run = spawnSync(${JSON.stringify(TOOLS.host)}, args, { stdio: 'inherit' });
if (run.status !== 0) process.exit(run.status ?? 1);
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();
if (!args.includes('--block-input') || mode === 'none') process.exit(0);
const file = args[args.indexOf('--report') + 1];
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
if (mode === 'word') report.publicValues.blockTimestamp = String(BigInt(report.publicValues.blockTimestamp) + 1n);
if (mode === 'mark') report.queueProcessedUpTo += 1;
if (mode === 'frontier') report.withdrawalsFrontierAfter[0] = '0x' + '01'.repeat(32);
if (mode === 'forcedOutcome') report.forced[0] = { ...report.forced[0], outcome: 'skipped', reason: 'Signature' };
if (mode === 'forcedLength') report.forced.pop();
fs.writeFileSync(file, JSON.stringify(report));
`,
    );
    chmodSync(host, 0o755);
    const set = (mode: ReportTamper) => writeFileSync(modeFile, mode);
    set('none');
    return { host, set };
}

if (missing.length > 0) {
    describe(SUITE, () => {
        it.todo(
            `ждёт бинарников ${missing.join(', ')} (PROVING.md: reth v2.2.0 в .tools/reth/bin, rsp и rollup-evm-host собраны)`,
        );
    });
} else {
    describe(SUITE, () => {
        let constants: ProtocolConstants;
        let blockchain: Blockchain;
        let owner: SandboxContract<TreasuryContract>;
        let rollup: SandboxContract<Rollup>;
        let feed: SandboxFeed;
        let node: RunningNode;
        let nodeOptions: NodeOptions;
        let config: SequencerConfig;
        let wrapper: ReturnType<typeof hostWrapper>;
        const open: Sequencer[] = [];
        const A = wallet();
        const S = wallet();
        const P = wallet();
        const Q = wallet();
        const recipientHash = '0x' + 'ab'.repeat(32);
        const lines: string[] = [];
        const feeRecipient = '0x' + randomBytes(20).toString('hex');

        const record = async <T extends Parameters<SandboxFeed['record']>[0]>(sending: Promise<T>): Promise<T> => {
            const result = await sending;
            feed.record(result);
            return result;
        };
        const deposit = async (to: string, amount: bigint) => {
            const fees = await rollup.getQueueFees();
            const result = await record(
                rollup.sendDeposit(owner.getSender(), {
                    l2Recipient: BigInt(to),
                    value: amount + fees.depositFee,
                    maxFee: fees.depositFee,
                }),
            );
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        };
        const force = async (raw: string | Buffer) => {
            const fees = await rollup.getQueueFees();
            const result = await record(
                rollup.sendForceTransaction(owner.getSender(), {
                    l2Transaction: forcedTransactionCell(typeof raw === 'string' ? bytes(raw) : raw),
                    value: fees.forceTransactionFee,
                }),
            );
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        };
        /** Сдвиг часов машины и L1 вперёд, с (блок 9: время L1 уходит за окно maxBlockAge). */
        let shift = 0;
        const wallClock = () => Math.floor(Date.now() / 1000) + shift;
        /** Время L1 идёт как часы машины: блок из будущего (время сборки — с запасом секунды) ждёт. */
        const l1Now = async () => {
            blockchain.now = Math.max(blockchain.now ?? 0, wallClock());
            return blockchain.now;
        };
        const submitter = (): BatchSubmitter =>
            new SandboxSubmitter(rollup, owner.getSender(), (result) => feed.record(result), () => blockchain.now!);
        /** Шаг, пережидающий «блок из будущего L1» (время блока — max(родитель + 1, сейчас)). */
        const settle = async (service: Sequencer) => {
            for (let attempt = 0; ; attempt++) {
                const result = await service.step();
                if (result.kind !== 'waiting' || attempt > 20) return result;
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        };
        /** Новый экземпляр сервиса; прежние закрываются (каталог состояния — под блокировкой). */
        const sequencer = (faults?: SequencerDeps['faults'], rpc?: NodeRpc) => {
            open.splice(0).forEach((instance) => instance.close());
            const instance = new Sequencer(config, {
                node: rpc ?? node.rpc,
                queue: new SandboxQueueSource(rollup, feed, constants),
                prover: new MockProver(),
                submitter: submitter(),
                l1Now,
                log: (line) => lines.push(line),
                faults,
            });
            open.push(instance);
            return instance;
        };
        /** Узел — тот же каталог и порты, новый процесс: неканонические блоки в памяти теряются. */
        const restartNode = async () => {
            await node.stop();
            node = await startNode(nodeOptions);
        };
        /** Обёртка над RPC узла, подменяющая ответ одного метода. */
        const tampered = (method: string, change: (answer: any, params: unknown[]) => unknown): NodeRpc => {
            const wrap =
                (call: NodeRpc['eth']) =>
                async (name: string, params: unknown[]) => {
                    const answer = await call(name, params);
                    return (name === method ? change(answer, params) : answer) as any;
                };
            return { eth: wrap(node.rpc.eth) as NodeRpc['eth'], engine: wrap(node.rpc.engine) as NodeRpc['engine'] };
        };
        const sendToPool = async (raw: string) => {
            try {
                await node.rpc.eth('eth_sendRawTransaction', [raw]);
            } catch (error) {
                // Узел перезапускали: транзакция могла пережить его в пуле — это не ошибка.
                if (!/already known/i.test(String(error))) throw error;
            }
        };
        const withdrawal = (nonce: number, value: bigint, extra: object = {}) => ({
            nonce,
            gas: 40_000,
            to: BRIDGE_ADDRESS,
            value: (value * GWEI).toString(),
            data: recipientHash,
            ...extra,
        });
        const block = (tag: string | number) =>
            node.rpc.eth<{ hash: string; number: string; parentHash: string; transactions: string[] } | null>(
                'eth_getBlockByNumber',
                [typeof tag === 'number' ? '0x' + tag.toString(16) : tag, false],
            );
        const reportOf = (service: Sequencer, number: number) =>
            JSON.parse(
                readFileSync(path.join(service.snapshot.blocks[number - 1].dir, 'report.json'), 'utf8'),
            ) as EvmBatchReport;
        /** Батч принят: состояние контракта — слова программы; finalized узла — этот блок. */
        const expectAccepted = async (service: Sequencer, checked: { number: number; hash: string }) => {
            const report = reportOf(service, checked.number);
            const state = await rollup.getRollupState();
            expect({ stateRoot: state.stateRoot, batchIndex: state.batchIndex }).toEqual({
                stateRoot: BigInt(checked.hash),
                batchIndex: checked.number,
            });
            expect((await rollup.getDepositQueue()).processed).toEqual({
                count: BigInt(report.queueProcessedUpTo),
                hash: BigInt(report.publicValues.newDepositHash),
            });
            expect(state.withdrawalsCount).toBe(BigInt(report.publicValues.withdrawalsCount));
            expect((await block('finalized'))!.hash).toBe(checked.hash);
            return report;
        };
        /**
         * Два шага: блок проверен программой, затем батч принят контрактом. После первого шага
         * safe — новый блок, а finalized — прежний (правило 0.3): двигается только после приёма.
         */
        const blockAndBatch = async (service: Sequencer) => {
            const finalizedBefore = (await block('finalized'))!.hash;
            const checked = await service.step();
            if (checked.kind !== 'checked') throw new Error(`ожидался проверенный блок, а шаг дал ${checked.kind}`);
            expect({ safe: (await block('safe'))!.hash, finalized: (await block('finalized'))!.hash }).toEqual({
                safe: checked.hash,
                finalized: finalizedBefore,
            });
            const accepted = await settle(service);
            expect(accepted).toEqual({
                kind: 'accepted',
                number: checked.number,
                hash: checked.hash,
                alreadyAccepted: false,
            });
            const report = await expectAccepted(service, checked);
            return { checked, report };
        };
        /** Остановка на этом шаге с точным текстом; вершина сервиса, safe и finalized — прежние. */
        const expectStop = async (service: Sequencer, text: string | RegExp) => {
            const before = {
                tip: service.snapshot.tip.number,
                safe: (await block('safe'))!.hash,
                finalized: (await block('finalized'))!.hash,
            };
            const error = await service.step().then(
                () => null,
                (caught: unknown) => caught,
            );
            expect(error).toBeInstanceOf(SequencerStop);
            const message = (error as Error).message;
            if (typeof text === 'string') expect(message).toBe(text);
            else expect(message).toMatch(text);
            expect({
                tip: service.snapshot.tip.number,
                safe: (await block('safe'))!.hash,
                finalized: (await block('finalized'))!.hash,
            }).toEqual(before);
        };
        /** Первый экземпляр останавливается после фазы, узел перезапускается, второй продолжает. */
        const interruptAndRestartNode = async (phase: Phase, faults: SequencerDeps['faults'] = {}) => {
            const first = sequencer({ ...faults, stopAfter: phase });
            await first.start();
            // Пруф — на шаге после проверки блока.
            if (phase === 'proven') expect(await first.step()).toMatchObject({ kind: 'checked' });
            await expect(first.step()).rejects.toThrow(new Interrupted(phase).message);
            const snapshot = first.snapshot;
            await restartNode();
            const second = sequencer();
            await second.start();
            return { snapshot, second };
        };

        beforeAll(async () => {
            rmSync(WORK, { recursive: true, force: true });
            const code = await compile('RollupMock');
            const nullifierCode = await compile('RollupNullifier');
            constants = await readProtocolConstants(code, nullifierCode);
            blockchain = await Blockchain.create();
            blockchain.now = Math.floor(Date.now() / 1000);
            owner = await blockchain.treasury('owner');
            rollup = blockchain.openContract(
                Rollup.createFromConfig(
                    testConfig(constants, {
                        owner: owner.address,
                        sequencer: owner.address,
                        nullifierCode,
                        chainId: CHAIN_ID,
                        escapeTimeout: 3600 * 12,
                    }),
                    code,
                ),
            );
            await rollup.sendDeploy(owner.getSender(), toNano('0.05'));
            await finalizeDummyKeys(rollup, owner);
            expect(await rollup.getGenesisHash()).toBe(BigInt(GENESIS_HASH));
            feed = new SandboxFeed(rollup.address);
            nodeOptions = {
                reth: TOOLS.reth,
                dir: path.join(WORK, 'node'),
                chainId: CHAIN_ID,
                httpPort: 8748,
                authPort: 8752,
                p2pPort: 30599,
            };
            node = await startNode(nodeOptions);
            wrapper = hostWrapper(path.join(WORK, 'tools'));
            config = {
                chainId: await rollup.getChainId(),
                feeRecipient,
                stateDir: path.join(WORK, 'state'),
                rpcUrl: node.rpcUrl,
                genesisPath: node.genesisPath,
                includePool: false,
                tools: { host: wrapper.host, rsp: TOOLS.rsp, executeInZkvm: false },
                // Пределы и срок — у контракта, не копией.
                maxBatchQueueItems: constants.maxBatchQueueItems,
                maxBlockAge: (await rollup.getDeployment()).maxBlockAge,
                // Пруф — заглушка; с наименьшим maxBlockAge (1800) время пруфа по умолчанию не помещается.
                expectedProofTime: 600,
                now: wallClock,
            };
        }, 300_000);

        afterAll(async () => {
            open.forEach((instance) => instance.close());
            await node?.stop();
        }, 60_000);

        it('блок 1: депозиты из очереди зачисляются с номерами от нуля; батч принят, публичный вход — 11 слов программы', async () => {
            await deposit(A.address, toNano('3'));
            await deposit('0x' + '33'.repeat(20), toNano('0.5'));
            await deposit(P.address, toNano('1'));
            const service = sequencer();
            await service.start();
            const { checked, report } = await blockAndBatch(service);
            expect(checked).toMatchObject({ number: 1, attempts: 1, queueItems: 3, included: 0 });
            expect(report.publicValues.prevStateRoot).toBe(GENESIS_HASH);
            expect(BigInt(await node.rpc.eth<string>('eth_getBalance', [A.address, 'latest']))).toBe(
                toNano('3') * GWEI,
            );
            // Без новых элементов очереди и пула блок не собирается.
            expect(await service.step()).toEqual({ kind: 'idle' });
        }, 600_000);

        it('блок 2: принудительные — годная включена, мусор, негодная подпись и «nonce выше» пропущены; пул без флага не берётся', async () => {
            const [valid, badSignature, nonceHigh] = A.sign([
                withdrawal(0, 100_000_000n),
                withdrawal(1, 50_000_000n, { signature: 'sZero' }),
                withdrawal(5, 50_000_000n),
            ]);
            await force(valid);
            await force(randomBytes(40));
            await force(badSignature);
            await force(nonceHigh);
            // Транзакция в пуле узла при выключенном флаге в блок не идёт (T6).
            await sendToPool(P.sign([{ nonce: 0, gas: 21_000, to: '0x' + '55'.repeat(20), value: '1000' }])[0]);
            const service = sequencer();
            await service.start();
            const { checked, report } = await blockAndBatch(service);
            expect(checked).toMatchObject({ number: 2, queueItems: 4, included: 1, pool: 0 });
            expect(report.forced).toEqual([
                { queueIndex: 0, outcome: 'included' },
                { queueIndex: 1, outcome: 'skipped', reason: 'Undecodable' },
                { queueIndex: 2, outcome: 'skipped', reason: 'Signature' },
                { queueIndex: 3, outcome: 'skipped', reason: 'Invalid(NonceTooHigh)' },
            ]);
            expect(report.withdrawals).toEqual([{ leafIndex: 0, recipientHash, amount: '100000000' }]);
            expect((await block(2))!.transactions).toHaveLength(1);
        }, 600_000);

        it('блок 3: перезапуск сервиса и узла после newPayload — тот же кандидат отдаётся узлу заново; отрезок обрезан перед принудительной от счёта с депозитом', async () => {
            await force(A.sign([withdrawal(1, 60_000_000n)])[0]);
            await deposit(S.address, toNano('1'));
            await force(S.sign([withdrawal(0, 50_000_000n)])[0]);
            const { snapshot, second } = await interruptAndRestartNode('inserted');
            const pending = snapshot.pending!;
            expect(pending.phase).toBe('inserted');
            // Отданный узлу кандидат не был головой: перезапущенный узел его не знает.
            expect(await block(3)).toBeNull();
            const { checked, report } = await blockAndBatch(second);
            // Тот же кандидат, без пересборки (у новой сборки было бы другое время и другой хеш).
            expect(checked.hash).toBe(pending.payload.blockHash);
            expect((await block(3))!.hash).toBe(pending.payload.blockHash);
            expect(lines).toContain(`блок 3: продолжается кандидат ${pending.payload.blockHash} с фазы inserted`);
            expect(lines).toContain(
                `блок 3: узел не знает кандидата ${pending.payload.blockHash} (SYNCING) — newPayload из сохранённого ответа`,
            );
            // Отрезок: принудительная A и депозит S; принудительная S — в следующий блок.
            expect(report.queueProcessedUpTo - report.queueProcessedFrom).toBe(2);
            expect(lines).toContain('блок 3: отрезок до 9 — элемент №10: отправителю зачисляется депозит в этом же отрезке');
            expect(report.forced).toEqual([{ queueIndex: 0, outcome: 'included' }]);
            expect(second.snapshot.tip.cut).toBe(true);
        }, 900_000);

        it('блок 4: кандидата, которого программа отвергает, вершина и safe не принимают; следующий кандидат той же высоты его вытесняет; после обрезанного блока отрезок полный', async () => {
            await deposit('0x' + '44'.repeat(20), toNano('0.2'));
            // Депозит Q и принудительная Q в одном отрезке. Блок 3 уже резал отрезок: этот не режется,
            // и принудительная Q законно пропускается программой (зачисление — в конце блока).
            await deposit(Q.address, toNano('1'));
            await force(Q.sign([withdrawal(0, 50_000_000n)])[0]);
            const before = { safe: (await block('safe'))!.hash, finalized: (await block('finalized'))!.hash };
            // Подлог: номер зачисления с единицы. Reth такой блок принимает, программа — нет.
            const tamper = (request: BuildRequest) => ({
                ...request,
                payloadAttributes: {
                    ...request.payloadAttributes,
                    withdrawals: request.payloadAttributes.withdrawals.map((credit, index) => ({
                        ...credit,
                        index: '0x' + (index + 1).toString(16),
                    })),
                },
            });
            const bad = sequencer({ tamper });
            await bad.start();
            await expectStop(bad, 'блок 4: программа отвергла и исправленного кандидата (без транзакций пула)');
            const state = bad.snapshot;
            expect(state.rejections).toHaveLength(2);
            for (const rejection of state.rejections)
                expect(rejection).toMatchObject({
                    number: 4,
                    reason: 'нативный расчёт отверг батч: DepositMismatch(0)',
                });
            // Вершина сервиса, safe и finalized — прежние; батча и задания пруверу нет.
            expect(state.tip.number).toBe(3);
            expect(state.blocks.map((record) => record.number)).toEqual([1, 2, 3]);
            expect({ safe: (await block('safe'))!.hash, finalized: (await block('finalized'))!.hash }).toEqual(before);
            expect(existsSync(path.join(config.stateDir, 'blocks', '4'))).toBe(false);
            expect((await rollup.getRollupState()).batchIndex).toBe(3);
            // Узел держит отвергнутого кандидата временной головой (свидетель иначе не получить).
            expect((await block(4))!.hash).toBe(state.rejections[1].hash);

            const good = sequencer();
            await good.start();
            const { checked, report } = await blockAndBatch(good);
            expect(state.rejections.map((rejection) => rejection.hash)).not.toContain(checked.hash);
            expect((await block(4))!).toMatchObject({ hash: checked.hash, parentHash: (await block(3))!.hash });
            // Принудительная S, отложенная прошлым блоком, теперь включена: депозит S уже зачислен.
            // Принудительная Q — пропущена: блок 3 резал отрезок, два блока подряд не режутся (H2).
            expect(report.forced).toEqual([
                { queueIndex: 0, outcome: 'included' },
                { queueIndex: 3, outcome: 'skipped', reason: 'Invalid(LackOfFunds)' },
            ]);
            expect(checked).toMatchObject({ queueItems: 4, included: 1 });
            expect(good.snapshot.tip.cut).toBeUndefined();
            expect((await block('safe'))!.hash).toBe(checked.hash);
        }, 900_000);

        it('блок 5: две одинаковые принудительные в отрезке — первая включена, вторая пропущена (H1); перезапуск узла во временной голове', async () => {
            const [twice] = A.sign([withdrawal(2, 70_000_000n)]);
            // Копию чужой принудительной ставит кто угодно за плату очереди.
            await force(twice);
            await force(twice);
            const { snapshot, second } = await interruptAndRestartNode('tentative');
            expect(snapshot.pending!.phase).toBe('tentative');
            const { checked, report } = await blockAndBatch(second);
            expect(checked).toMatchObject({ number: 5, hash: snapshot.pending!.payload.blockHash, queueItems: 2, included: 1 });
            expect(report.forced).toEqual([
                { queueIndex: 0, outcome: 'included' },
                { queueIndex: 1, outcome: 'skipped', reason: 'Invalid(NonceTooLow)' },
            ]);
            expect((await block(5))!.transactions).toHaveLength(1);
            expect(report.withdrawals).toEqual([{ leafIndex: 3, recipientHash, amount: '70000000' }]);
        }, 900_000);

        it('блок 6: отвергнут кандидат с пулом — вторая попытка без пула (T6); перезапуск узла после проверки', async () => {
            await deposit('0x' + '66'.repeat(20), toNano('0.2'));
            config = { ...config, includePool: true };
            await sendToPool(P.sign([{ nonce: 0, gas: 21_000, to: '0x' + '55'.repeat(20), value: '1000' }])[0]);
            // Подлог только на первой попытке: номер зачисления с единицы.
            const tamper = (request: BuildRequest, attempt: number) =>
                attempt !== 1
                    ? request
                    : {
                          ...request,
                          payloadAttributes: {
                              ...request.payloadAttributes,
                              withdrawals: request.payloadAttributes.withdrawals.map((credit) => ({ ...credit, index: '0x1' })),
                          },
                      };
            const { snapshot, second } = await interruptAndRestartNode('checked', { tamper });
            expect(snapshot.blocks[5]).toMatchObject({ number: 6, status: 'checked' });
            expect(snapshot.rejections.filter((rejection) => rejection.number === 6).map((rejection) => rejection.attempt)).toEqual([1]);
            expect(lines.some((line) => /^блок 6, попытка 1: кандидат 0x[0-9a-f]+ — .*из пула 1,/.test(line))).toBe(true);
            expect(lines.some((line) => /^блок 6, попытка 2: кандидат 0x[0-9a-f]+ — .*из пула 0,/.test(line))).toBe(true);
            // Узел перезапущен после проверки: блок 6 — safe, finalized — блок 5.
            expect((await block('safe'))!.hash).toBe(snapshot.blocks[5].hash);
            expect((await block('finalized'))!.hash).toBe(snapshot.blocks[4].hash);
            expect(await settle(second)).toEqual({ kind: 'accepted', number: 6, hash: snapshot.blocks[5].hash, alreadyAccepted: false });
            await expectAccepted(second, snapshot.blocks[5]);
            expect((await block(6))!.transactions).toHaveLength(0);
            config = { ...config, includePool: false };
        }, 900_000);

        it('блок 7: подменённые ответы узла и отчёт хоста — остановка с точным текстом (T2, T4); перезапуск узла после пруфа', async () => {
            await force(A.sign([withdrawal(3, 80_000_000n)])[0]);
            await deposit('0x' + '77'.repeat(20), toNano('0.2'));
            const stopWith = async (rpc: NodeRpc | undefined, text: string | RegExp) => {
                const service = sequencer(undefined, rpc);
                await service.start();
                await expectStop(service, text);
            };
            // T4: ответ testing_buildBlockV1 — другое время, лишняя транзакция; newPayload → INVALID.
            const shiftTime = tampered('testing_buildBlockV1', (envelope: { executionPayload: ExecutionPayload }) => ({
                executionPayload: {
                    ...envelope.executionPayload,
                    timestamp: '0x' + (BigInt(envelope.executionPayload.timestamp) + 1n).toString(16),
                },
            }));
            await stopWith(shiftTime, /^блок 7: узел собрал не то — время (\d+), а запрошено (\d+)$/);
            const [extra] = P.sign([{ nonce: 1, gas: 21_000, to: '0x' + '55'.repeat(20), value: '1' }]);
            const extraTx = tampered('testing_buildBlockV1', (envelope: { executionPayload: ExecutionPayload }) => ({
                executionPayload: {
                    ...envelope.executionPayload,
                    transactions: [...envelope.executionPayload.transactions, extra],
                },
            }));
            await stopWith(extraTx, 'блок 7: узел собрал не то — транзакция блока №1 не из запроса либо не на своём месте');
            const invalid = tampered('engine_newPayloadV3', () => ({
                status: 'INVALID',
                latestValidHash: null,
                validationError: 'подмена',
            }));
            await stopWith(
                invalid,
                'узел не принял собранный им же блок 7: {"status":"INVALID","latestValidHash":null,"validationError":"подмена"}',
            );

            // T2: данные блока и квитанции узла.
            const mismatch = 'блок 7: расчёт сервиса не сошёлся с программой — ';
            await stopWith(tampered('debug_getRawBlock', () => '0x00'), mismatch + 'данные батча — не RLP блока со слов узла');
            const noBridgeLogs = tampered('eth_getBlockReceipts', (receipts: { logs: { address: string }[] }[]) =>
                receipts.map((receipt) => ({
                    ...receipt,
                    logs: receipt.logs.filter((log) => log.address.toLowerCase() !== BRIDGE_ADDRESS),
                })),
            );
            await stopWith(
                noBridgeLogs,
                /^блок 7: расчёт сервиса не сошёлся с программой — withdrawalsRoot: у программы 0x[0-9a-f]+, у сервиса 0x[0-9a-f]+; withdrawalsCount: у программы 0x5, у сервиса 0x4; фронтир дерева выводов после блока не тот; байты публичных значений не те$/,
            );
            // T2: отчёт хоста — слово, отметка очереди, узел фронтира, судьба принудительной.
            const cases: [ReportTamper, string | RegExp][] = [
                ['word', /^блок 7: расчёт сервиса не сошёлся с программой — blockTimestamp: у программы 0x[0-9a-f]+, у сервиса 0x[0-9a-f]+$/],
                ['mark', /^блок 7: расчёт сервиса не сошёлся с программой — отметки очереди у программы (\d+)\.\.(\d+), у сервиса \1\.\.\d+$/],
                ['frontier', mismatch + 'фронтир дерева выводов после блока не тот'],
                ['forcedOutcome', mismatch + 'в блоке принудительных 1, а программа включила 0'],
                [
                    'forcedLength',
                    mismatch + 'в отчёте программы принудительных 0, в отрезке 1; в блоке принудительных 1, а программа включила 0',
                ],
            ];
            for (const [mode, text] of cases) {
                wrapper.set(mode);
                try {
                    await stopWith(undefined, text);
                } finally {
                    wrapper.set('none');
                }
            }

            // Честный прогон: пруф построен, узел перезапущен, батч отправлен после перезапуска.
            const { snapshot, second } = await interruptAndRestartNode('proven');
            expect(snapshot.blocks[6]).toMatchObject({ number: 7, status: 'proven' });
            expect((await block('finalized'))!.hash).toBe(snapshot.blocks[5].hash);
            expect(await settle(second)).toEqual({ kind: 'accepted', number: 7, hash: snapshot.blocks[6].hash, alreadyAccepted: false });
            const report = await expectAccepted(second, snapshot.blocks[6]);
            expect(report.forced).toEqual([{ queueIndex: 0, outcome: 'included' }]);
        }, 1_800_000);

        it('блок 8: транзакции из пула узла (с флагом) идут после принудительных; повторный запуск ничего не дублирует', async () => {
            const [transfer] = A.sign([
                { nonce: 4, gas: 21_000, to: '0x' + '55'.repeat(20), value: (GWEI * 1000n).toString() },
            ]);
            await sendToPool(transfer);
            await sendToPool(P.sign([{ nonce: 0, gas: 21_000, to: '0x' + '55'.repeat(20), value: '1000' }])[0]);
            config = { ...config, includePool: true };
            const service = sequencer();
            await service.start();
            const { checked } = await blockAndBatch(service);
            expect(checked).toMatchObject({ number: 8, queueItems: 0, pool: 2 });
            expect((await block(8))!.transactions).toHaveLength(2);
            // Новый экземпляр на том же каталоге: всё принято, собирать нечего.
            const again = sequencer();
            await again.start();
            expect(await again.step()).toEqual({ kind: 'idle' });
            expect((await rollup.getRollupState()).batchIndex).toBe(8);
            const queue = await rollup.getDepositQueue();
            expect(queue.processed.count).toBe(queue.head.count);
            expect(again.snapshot.tip).toMatchObject({
                number: 8,
                hash: checked.hash,
                queue: { count: Number(queue.head.count), hash: queue.head.hash },
            });
            // Каждый блок цепочки — тот, что принят контрактом; задания пруверу лежат у каждого.
            for (const record of again.snapshot.blocks) {
                expect((await block(record.number))!.hash).toBe(record.hash);
                expect(existsSync(path.join(record.dir, 'job.json'))).toBe(true);
            }
            // Хост и rsp не остались жить после шагов: живой только узел.
            expect(liveChildren()).toBe(1);
            config = { ...config, includePool: false };
        }, 900_000);

        it('блок 9: время L1 ушло за окно после проверки — блок пересобран (тот же отрезок, свежее время), safe — на соседа, контракт принимает новый', async () => {
            await deposit('0x' + '99'.repeat(20), toNano('0.3'));
            const service = sequencer();
            await service.start();
            const old = await service.step();
            if (old.kind !== 'checked') throw new Error(`ожидался проверенный блок, а шаг дал ${old.kind}`);
            const oldReport = reportOf(service, 9);
            const finalized = (await block('finalized'))!.hash;
            expect((await block('safe'))!.hash).toBe(old.hash);
            // Часы машины и L1 — на maxBlockAge вперёд: батч блока 9 не успеть даже до пруфа.
            shift = config.maxBlockAge;
            const rebuilt = await service.step();
            expect(rebuilt).toMatchObject({ kind: 'checked', number: 9, replaced: old.hash, queueItems: 1 });
            if (rebuilt.kind !== 'checked') throw new Error('не пересобран');
            expect(rebuilt.hash).not.toBe(old.hash);
            expect(lines.some((line) => line.startsWith(`блок 9 (${old.hash}) пересобирается: батч не успеть принять до пруфа:`))).toBe(true);
            // Узел: на высоте 9 — новый блок от того же родителя, safe — он же (сосед прежнего safe).
            expect((await block(9))!).toMatchObject({ hash: rebuilt.hash, parentHash: (await block(8))!.hash });
            expect({ safe: (await block('safe'))!.hash, finalized: (await block('finalized'))!.hash }).toEqual({
                safe: rebuilt.hash,
                finalized,
            });
            // Тот же отрезок очереди, свежее время; контракт до приёма — на батче 8.
            const newReport = reportOf(service, 9);
            expect([newReport.queueProcessedFrom, newReport.queueProcessedUpTo]).toEqual([
                oldReport.queueProcessedFrom,
                oldReport.queueProcessedUpTo,
            ]);
            expect(Number(newReport.publicValues.blockTimestamp)).toBeGreaterThanOrEqual(
                Number(oldReport.publicValues.blockTimestamp) + config.maxBlockAge,
            );
            expect((await rollup.getRollupState()).batchIndex).toBe(8);
            expect(service.snapshot.rebuild).toBeNull();
            expect(await settle(service)).toEqual({ kind: 'accepted', number: 9, hash: rebuilt.hash, alreadyAccepted: false });
            await expectAccepted(service, rebuilt);
            expect(liveChildren()).toBe(1);
        }, 900_000);
    });
}
