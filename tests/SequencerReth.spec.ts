import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { EvmBatchReport } from '../wrappers/evmProofs';
import { Rollup } from '../wrappers/Rollup';
import { forcedTransactionCell } from '../wrappers/rollupMath';
import { BuildRequest } from '../sequencer/block/payload';
import { RunningNode, startNode } from '../sequencer/node';
import { BRIDGE_ADDRESS, GENESIS_HASH } from '../sequencer/protocol';
import { MockProver } from '../sequencer/prover';
import { SandboxFeed, SandboxQueueSource } from '../sequencer/queue/sandbox';
import { Interrupted, Sequencer, SequencerConfig, SequencerDeps, SequencerStop } from '../sequencer/service';
import { BatchSubmitter, SandboxSubmitter } from '../sequencer/submitter';
import { finalizeDummyKeys, ProtocolConstants, readProtocolConstants, testConfig } from './helpers/rollupSetup';

// Сборщик блоков (sequencer/) целиком: настоящий узел reth v2.2.0 с генезисом протокола, хост
// программы и rsp, двойник контракта в Sandbox (пруф — заглушка). Очередь L1 ставится
// сообщениями; сервис сам читает её, собирает блоки, проверяет каждый программой до того, как
// он станет проверенной вершиной, и отправляет батчи. Случаи: депозиты; принудительные — годная,
// мусор, негодная подпись, «nonce выше»; отрезок, обрезанный перед принудительной от счёта,
// которому зачисляется депозит; перезапуск после newPayload до forkchoiceUpdated; кандидат,
// который программа отвергает (номер зачисления с единицы), — вершина и safe не двигаются;
// транзакция из пула.
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
const CHAIN_ID = 362107787851n;
const GWEI = 1_000_000_000n;
const WORK = path.join(ROOT, '.tools', 'sequencer', 'test-reth');
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

if (missing.length > 0) {
    describe(SUITE, () => {
        it.todo(
            `нет бинарников ${missing.join(', ')} (PROVING.md: reth v2.2.0 в .tools/reth/bin, rsp и rollup-evm-host собраны)`,
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
        let config: SequencerConfig;
        const A = wallet();
        const S = wallet();
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
        /** Время L1 — не раньше времени блока: контракт берёт батч в окне [время блока, + maxBlockAge]. */
        const submitter = (): BatchSubmitter => {
            const inner = new SandboxSubmitter(rollup, owner.getSender(), (result) => feed.record(result));
            return {
                submit: async (batch) => {
                    blockchain.now = Math.max(
                        blockchain.now ?? 0,
                        Number(batch.report.publicValues.blockTimestamp) + 1,
                    );
                    return inner.submit(batch);
                },
            };
        };
        const sequencer = (faults?: SequencerDeps['faults']) =>
            new Sequencer(config, {
                node: node.rpc,
                queue: new SandboxQueueSource(rollup, feed, constants),
                prover: new MockProver(),
                submitter: submitter(),
                log: (line) => lines.push(line),
                faults,
            });
        const withdrawal = (nonce: number, value: bigint, extra: object = {}) => ({
            nonce,
            gas: 40_000,
            to: BRIDGE_ADDRESS,
            value: (value * GWEI).toString(),
            data: recipientHash,
            ...extra,
        });
        const block = (tag: string | number) =>
            node.rpc.eth<{ hash: string; number: string; parentHash: string } | null>('eth_getBlockByNumber', [
                typeof tag === 'number' ? '0x' + tag.toString(16) : tag,
                false,
            ]);
        const reportOf = (service: Sequencer, number: number) =>
            JSON.parse(
                readFileSync(path.join(service.snapshot.blocks[number - 1].dir, 'report.json'), 'utf8'),
            ) as EvmBatchReport;
        /** Два шага: блок проверен программой, затем батч принят контрактом. */
        const blockAndBatch = async (service: Sequencer) => {
            const checked = await service.step();
            if (checked.kind !== 'checked') throw new Error(`ожидался проверенный блок, а шаг дал ${checked.kind}`);
            const accepted = await service.step();
            expect(accepted).toEqual({
                kind: 'accepted',
                number: checked.number,
                hash: checked.hash,
                alreadyAccepted: false,
            });
            const report = reportOf(service, checked.number);
            // Контракт принял батч: его состояние — слова программы, отметка очереди — та, что заявлена.
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
            return { checked, report };
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
            node = await startNode({
                reth: TOOLS.reth,
                dir: path.join(WORK, 'node'),
                chainId: CHAIN_ID,
                httpPort: 8748,
                authPort: 8752,
                p2pPort: 30599,
            });
            config = {
                chainId: await rollup.getChainId(),
                feeRecipient,
                stateDir: path.join(WORK, 'state'),
                rpcUrl: node.rpcUrl,
                genesisPath: node.genesisPath,
                includePool: false,
                tools: { host: TOOLS.host, rsp: TOOLS.rsp, executeInZkvm: false },
                // Предел отрезка — у контракта, не копией.
                maxBatchQueueItems: constants.maxBatchQueueItems,
            };
        }, 300_000);

        afterAll(async () => {
            await node?.stop();
        }, 60_000);

        it('блок 1: депозиты из очереди зачисляются с номерами от нуля; батч принят, публичный вход — 11 слов программы', async () => {
            await deposit(A.address, toNano('3'));
            await deposit('0x' + '33'.repeat(20), toNano('0.5'));
            const service = sequencer();
            await service.start();
            const { checked, report } = await blockAndBatch(service);
            expect(checked).toMatchObject({ number: 1, attempts: 1, queueItems: 2, included: 0 });
            expect(report.publicValues.prevStateRoot).toBe(GENESIS_HASH);
            expect(BigInt(await node.rpc.eth<string>('eth_getBalance', [A.address, 'latest']))).toBe(
                toNano('3') * GWEI,
            );
            // Без новых элементов очереди и пула блок не собирается.
            expect(await service.step()).toEqual({ kind: 'idle' });
        }, 600_000);

        it('блок 2: принудительные — годная включена, мусор, негодная подпись и «nonce выше» пропущены программой', async () => {
            const [valid, badSignature, nonceHigh] = A.sign([
                withdrawal(0, 100_000_000n),
                withdrawal(1, 50_000_000n, { signature: 'sZero' }),
                withdrawal(5, 50_000_000n),
            ]);
            await force(valid);
            await force(randomBytes(40));
            await force(badSignature);
            await force(nonceHigh);
            const service = sequencer();
            await service.start();
            const { checked, report } = await blockAndBatch(service);
            expect(checked).toMatchObject({ number: 2, queueItems: 4, included: 1 });
            expect(report.forced).toEqual([
                { queueIndex: 0, outcome: 'included' },
                { queueIndex: 1, outcome: 'skipped', reason: 'Undecodable' },
                { queueIndex: 2, outcome: 'skipped', reason: 'Signature' },
                { queueIndex: 3, outcome: 'skipped', reason: 'Invalid(NonceTooHigh)' },
            ]);
            expect(report.withdrawals).toEqual([{ leafIndex: 0, recipientHash, amount: '100000000' }]);
            const transactions = (
                await node.rpc.eth<{ transactions: string[] }>('eth_getBlockByNumber', ['0x2', false])
            ).transactions;
            expect(transactions).toHaveLength(1);
        }, 600_000);

        it('блок 3: перезапуск после newPayload до forkchoiceUpdated продолжает того же кандидата; отрезок обрезан перед принудительной от счёта с депозитом', async () => {
            await force(A.sign([withdrawal(1, 60_000_000n)])[0]);
            await deposit(S.address, toNano('1'));
            await force(S.sign([withdrawal(0, 50_000_000n)])[0]);
            const first = sequencer({ stopAfter: 'inserted' });
            await first.start();
            await expect(first.step()).rejects.toThrow(Interrupted);
            const pending = first.snapshot.pending!;
            expect(pending.phase).toBe('inserted');
            // Отданный узлу кандидат ещё не голова: на высоте 3 узел ничего не отдаёт.
            expect(await block(3)).toBeNull();

            const second = sequencer();
            await second.start();
            const { checked, report } = await blockAndBatch(second);
            // Тот же кандидат, без пересборки (у новой сборки было бы другое время и другой хеш).
            expect(checked.hash).toBe(pending.payload.blockHash);
            expect((await block(3))!.hash).toBe(pending.payload.blockHash);
            expect(
                lines.some((line) =>
                    line.includes(`продолжается кандидат ${pending.payload.blockHash} с фазы inserted`),
                ),
            ).toBe(true);
            // Отрезок: принудительная A и депозит S; принудительная S — в следующий блок.
            expect(report.queueProcessedUpTo - report.queueProcessedFrom).toBe(2);
            expect(lines.some((line) => line.includes('отправителю зачисляется депозит в этом же отрезке'))).toBe(true);
            expect(report.forced).toEqual([{ queueIndex: 0, outcome: 'included' }]);
        }, 900_000);

        it('блок 4: кандидата, которого программа отвергает, вершина и safe не принимают; следующий кандидат той же высоты его вытесняет', async () => {
            await deposit('0x' + '44'.repeat(20), toNano('0.2'));
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
            await expect(bad.step()).rejects.toThrow(SequencerStop);
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
            expect(report.forced).toEqual([{ queueIndex: 0, outcome: 'included' }]);
            expect((await block('safe'))!.hash).toBe(checked.hash);
        }, 900_000);

        it('блок 5: транзакция из пула узла (с флагом) идёт после принудительных; повторный запуск ничего не дублирует', async () => {
            const [transfer] = A.sign([
                { nonce: 2, gas: 21_000, to: '0x' + '55'.repeat(20), value: (GWEI * 1000n).toString() },
            ]);
            await node.rpc.eth('eth_sendRawTransaction', [transfer]);
            config = { ...config, includePool: true };
            const service = sequencer();
            await service.start();
            const { checked } = await blockAndBatch(service);
            expect(checked).toMatchObject({ number: 5, queueItems: 0, pool: 1 });
            expect(
                (await node.rpc.eth<{ transactions: string[] }>('eth_getBlockByNumber', ['0x5', false])).transactions,
            ).toHaveLength(1);
            // Новый экземпляр на том же каталоге: всё принято, собирать нечего.
            const again = sequencer();
            await again.start();
            expect(await again.step()).toEqual({ kind: 'idle' });
            expect((await rollup.getRollupState()).batchIndex).toBe(5);
            const queue = await rollup.getDepositQueue();
            expect(queue.processed.count).toBe(queue.head.count);
            expect(again.snapshot.tip).toMatchObject({
                number: 5,
                hash: checked.hash,
                queue: { count: Number(queue.head.count), hash: queue.head.hash },
            });
            // Каждый блок цепочки — тот, что принят контрактом; задания пруверу лежат у каждого.
            for (const record of again.snapshot.blocks) {
                expect((await block(record.number))!.hash).toBe(record.hash);
                expect(existsSync(path.join(record.dir, 'job.json'))).toBe(true);
            }
        }, 900_000);
    });
}
