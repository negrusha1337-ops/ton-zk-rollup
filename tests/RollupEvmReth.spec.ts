import { Blockchain, BlockchainSnapshot, createShardAccount, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { batchRootsOf, dataChunksOf, loadEvmProgramKeys, publicInputOf, publicValuesOf, RETH_CHAIN_BLOCKS } from '../wrappers/evmProofs';
import { NullifierErrors, PlantedState, Rollup, RollupConfig, RollupErrors } from '../wrappers/Rollup';
import {
    appendWithdrawalLeaf,
    batchDataHash,
    batchDigest,
    byteSnake,
    emptyWithdrawalFrontier,
    MAX_FORCED_TX_BYTES,
    merkleProofCell,
    withdrawalFrontierRoot,
    withdrawalLeafHash,
    withdrawalTree,
} from '../wrappers/rollupMath';
import {
    blockHeaderOf,
    blockOf,
    enqueueUpTo,
    hexBytes,
    prepareRethBatch,
    reportOf,
    RethActors,
    rethExitMessage,
    rethExpected,
    rethQueueHashes,
    rethRecipient,
    rethReports,
    WEI_PER_NANOTON,
    withdrawalLeavesUpTo,
} from './helpers/rethChain';
import { finalizeDummyKeys, mockProof, ProtocolConstants, readProtocolConstants, testConfig } from './helpers/rollupSetup';

// Полный цикл протокола v2 на блоках настоящего узла Reth (zkvm-evm/scenario/reth-scenario.mjs):
// очередь L1 из депозитов и принудительных транзакций, батчи, выводы через мост, заморозка,
// аварийный выход счетов без пруфа, возврат необработанного депозита.
//
// Контракт — двойник (contracts/rollup_mock.tolk): пруфов для этих блоков ещё нет, проверка
// пруфа заменена заглушкой. Всё остальное — тот же код (tests/MockParity.spec.ts), и главное
// здесь не пруф, а сходимость сторон: публичный вход, который контракт соберёт для каждого
// батча из своего хранилища, очереди и опубликованных данных, обязан совпасть с одиннадцатью
// словами, которые программа выдала в zkVM для этого блока (отчёты block-N.json). Приём этих
// батчей по настоящему пруфу этим тестом НЕ доказан — tests/RollupEvmRethProof.spec.ts ждёт пруфов.
//
// Очередь ставится сообщениями для блоков 1–11. Отрезок блока 12 — 32 принудительные транзакции
// по 8 128 байт (программа пропускает их по длине): с пределом длины в контракте такие в очередь
// больше не попадают, поэтому блок 12 сверяется на подложенной очереди (см. тест ниже).
const TIMEOUT = 3600;
const NO_HINTS = beginCell().endCell();
/** Последний блок, очередь которого можно поставить сообщениями. */
const LAST_MESSAGE_BLOCK = 11;
/** Коды отказа проверки счёта EVM: enum EvmExitErrors в contracts/rollup/evm_exit.tolk. */
const WRONG_BLOCK_HEADER = 7401;

describe('Rollup: полный цикл на блоках узла Reth, протокол v2', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let constants: ProtocolConstants;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let config: RollupConfig;
    let actors: RethActors;
    /** Состояние песочницы сразу после приёма батча k (afterBatch[0] — до первого батча). */
    const afterBatch: BlockchainSnapshot[] = [];
    /** Что контракт требовал и что выдала программа — для каждого батча, принятого при подготовке. */
    const inputs: { block: number; required: bigint; proven: bigint }[] = [];
    const queueHashes = rethQueueHashes();
    const recipient = rethRecipient();

    const submit = (roots: ReturnType<typeof batchRootsOf>, on = rollup) =>
        on.sendSubmitBatch(owner.getSender(), { proof: mockProof(), hints: NO_HINTS, roots, value: toNano('0.2') });
    const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;
    const restore = async (block: number) => {
        await blockchain.loadFrom(afterBatch[block]);
        // Время L1 — момент приёма этого батча; дальше тест двигает его сам.
        blockchain.now = blockOf(Math.max(block, 1)).timestamp + 60;
    };
    /** Секвенсор пропал: поздний депозит ждёт дольше срока, rollup замораживает посторонний. */
    const freezeWithLateDeposit = async () => {
        const late = toNano('0.5');
        const { depositFee } = await rollup.getQueueFees();
        const sent = await rollup.sendDeposit(stranger.getSender(), { l2Recipient: 0xdeadn, value: late + depositFee, maxFee: depositFee });
        expect(sent.transactions).toHaveTransaction({ to: rollup.address, success: true });
        const index = Number((await rollup.getDepositQueue()).head.count);
        // Срок считается от самого старого необработанного элемента: он мог встать и раньше.
        const { oldestPendingAt } = await rollup.getEscapeState();
        blockchain.now = Math.max(blockchain.now!, oldestPendingAt + TIMEOUT) + 1;
        const frozen = await rollup.sendActivateEscapeHatch(stranger.getSender(), toNano('0.05'));
        expect(frozen.transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect((await rollup.getEscapeState()).frozen).toBe(true);
        return { late, index };
    };

    beforeAll(async () => {
        code = await compile('RollupMock');
        nullifierCode = await compile('RollupNullifier');
        constants = await readProtocolConstants(code, nullifierCode);
        blockchain = await Blockchain.create();
        blockchain.now = blockOf(1).timestamp;
        owner = await blockchain.treasury('owner');
        user = await blockchain.treasury('user');
        stranger = await blockchain.treasury('stranger');
        config = testConfig(constants, {
            owner: owner.address,
            sequencer: owner.address,
            nullifierCode,
            // Генезис — константа контракта; что она равна генезису цепочки, сверяет первый тест.
            chainId: BigInt(rethExpected.chainId),
            escapeTimeout: TIMEOUT,
        });
        rollup = blockchain.openContract(Rollup.createFromConfig(config, code));
        await rollup.sendDeploy(owner.getSender(), toNano('0.05'));
        await finalizeDummyKeys(rollup, owner);
        actors = { blockchain, rollup, sequencer: owner, user };
        afterBatch[0] = blockchain.snapshot();

        // Вся цепочка, которую можно построить сообщениями: очередь, данные, батч — блок за блоком.
        for (let number = 1; number <= LAST_MESSAGE_BLOCK; number++) {
            const { roots, required, proven } = await prepareRethBatch(actors, number, toNano('0.05'));
            inputs.push({ block: number, required, proven });
            const result = await submit(roots);
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            afterBatch[number] = blockchain.snapshot();
        }
    }, 600_000);

    it('фикстуры — одна цепочка от генезиса контракта, исполненная программой нынешнего ключа', () => {
        expect(rethExpected.protocolVersion).toBe(constants.protocolVersion);
        expect(BigInt(rethExpected.genesisHash)).toBe(constants.genesisHash);
        expect(rethExpected.blocks).toHaveLength(RETH_CHAIN_BLOCKS);
        const elf = loadEvmProgramKeys().programElfSha256.replace(/^0x/, '');
        expect(rethExpected.programElfSha256).toBe(elf);
        for (let number = 1; number <= RETH_CHAIN_BLOCKS; number++) {
            const report = reportOf(number);
            const block = blockOf(number);
            expect(report.blockNumber).toBe(number);
            expect(report.programElfSha256.replace(/^0x/, '')).toBe(elf);
            expect(report.zkvmCycles).toBeGreaterThan(0);
            expect(BigInt(report.publicValues.chainId)).toBe(BigInt(rethExpected.chainId));
            expect(report.publicValues.newStateRoot).toBe(block.hash);
            expect(report.publicValues.prevStateRoot).toBe(number === 1 ? rethExpected.genesisHash : blockOf(number - 1).hash);
            expect(Number(report.publicValues.blockTimestamp)).toBe(block.timestamp);
            expect(report.queueProcessedUpTo).toBe(block.queueProcessedUpTo);
            expect(report.queueProcessedFrom).toBe(number === 1 ? 0 : blockOf(number - 1).queueProcessedUpTo);
            expect(report.queueItems).toBe(report.queueProcessedUpTo - report.queueProcessedFrom);
            expect(report.queueItems).toBeLessThanOrEqual(constants.maxBatchQueueItems);
            expect(block.headAtBatch).toBeGreaterThanOrEqual(block.queueProcessedUpTo);
            // Элементы очереди помечены тем батчем, который их обработал.
            for (const item of rethExpected.queue.filter((queued) => queued.batch === number)) {
                expect(item.number).toBeGreaterThan(report.queueProcessedFrom);
                expect(item.number).toBeLessThanOrEqual(report.queueProcessedUpTo);
            }
        }
        expect(rethExpected.queue.map((item) => item.number)).toEqual(rethExpected.queue.map((_, index) => index + 1));
        expect(blockOf(RETH_CHAIN_BLOCKS).queueProcessedUpTo).toBe(rethExpected.queue.length);
        // Сценарий не вырожден: есть блок, обработавший очередь не до головы (хеш в точке N берётся
        // из словаря), блоки с полным отрезком и блоки, не тронувшие очередь.
        expect(rethExpected.blocks.some((block) => block.queueProcessedUpTo < block.headAtBatch)).toBe(true);
        expect(rethReports.some((report) => report.queueItems === constants.maxBatchQueueItems)).toBe(true);
        expect(rethReports.some((report) => report.queueItems === 0)).toBe(true);
    });

    it('арифметика вне контракта совпадает с программой на всех двенадцати блоках: очередь, выводы, данные, дайджест', () => {
        let frontier = emptyWithdrawalFrontier();
        let count = 0n;
        for (let number = 1; number <= RETH_CHAIN_BLOCKS; number++) {
            const report = reportOf(number);
            const values = publicValuesOf(report);
            // Хеши очереди L1 в прежней отметке и в точке N.
            expect(values.prevDepositHash).toBe(queueHashes[report.queueProcessedFrom]);
            expect(values.newDepositHash).toBe(queueHashes[report.queueProcessedUpTo]);
            // Дерево выводов: дозапись листьев блока во фронтир и полный пересчёт дают корень программы.
            expect(values.prevWithdrawalsCount).toBe(count);
            expect(values.prevWithdrawalsRoot).toBe(withdrawalFrontierRoot(frontier, count));
            for (const leaf of report.withdrawals) {
                expect(BigInt(leaf.leafIndex)).toBe(count);
                const hash = withdrawalLeafHash({ leafIndex: leaf.leafIndex, recipientHash: BigInt(leaf.recipientHash), amount: BigInt(leaf.amount) });
                ({ frontier, count } = appendWithdrawalLeaf(frontier, count, hash));
            }
            expect(values.withdrawalsCount).toBe(count);
            expect(frontier).toEqual(report.withdrawalsFrontierAfter.map(BigInt));
            expect(values.withdrawalsRoot).toBe(withdrawalFrontierRoot(frontier, count));
            expect(values.withdrawalsRoot).toBe(withdrawalTree(withdrawalLeavesUpTo(number)).root);
            expect(values.withdrawalsRoot).toBe(BigInt(blockOf(number).withdrawalsRoot));
            // Данные батча и сам дайджест.
            expect(values.batchHash).toBe(batchDataHash(dataChunksOf(report)));
            expect(hexBytes(report.publicValuesBytes)).toHaveLength(352);
            expect(batchDigest(values)).toBe(publicInputOf(report.publicValuesBytes));
        }
        expect(count).toBe(BigInt(rethExpected.withdrawals.length));
        // Прежние корень и счётчик выводов бывают ненулевыми: иначе их отсутствие в дайджесте было бы не видно.
        expect(rethReports.some((report) => BigInt(report.publicValues.prevWithdrawalsCount) > 0n)).toBe(true);
    });

    it('контракт требует для каждого из блоков 1–11 ровно тот публичный вход, что программа выдала в zkVM', async () => {
        expect(inputs.map((input) => input.block)).toEqual(Array.from({ length: LAST_MESSAGE_BLOCK }, (_, index) => index + 1));
        for (const { block, required, proven } of inputs) {
            expect({ block, required }).toEqual({ block, required: proven });
        }
        // Входы все разные: совпадение — не совпадение одинаковых заглушек.
        expect(new Set(inputs.map((input) => input.required)).size).toBe(LAST_MESSAGE_BLOCK);
        // Состояние контракта после каждого батча — то, что заявил блок.
        for (let number = 1; number <= LAST_MESSAGE_BLOCK; number++) {
            await blockchain.loadFrom(afterBatch[number]);
            const report = reportOf(number);
            expect(await rollup.getRollupState()).toEqual({
                stateRoot: BigInt(blockOf(number).hash),
                withdrawalsRoot: BigInt(report.publicValues.withdrawalsRoot),
                batchIndex: number,
                withdrawalsCount: BigInt(report.publicValues.withdrawalsCount),
            });
            const queue = await rollup.getDepositQueue();
            expect(queue.processed).toEqual({ count: BigInt(report.queueProcessedUpTo), hash: queueHashes[report.queueProcessedUpTo] });
            expect(queue.head).toEqual({ count: BigInt(blockOf(number).headAtBatch), hash: queueHashes[blockOf(number).headAtBatch] });
        }
    });

    it('блок 12: его очередь сообщениями больше не поставить, а на подложенной очереди публичный вход совпадает', async () => {
        await restore(LAST_MESSAGE_BLOCK);
        const report = reportOf(12);
        const segment = rethExpected.queue.filter((item) => item.batch === 12);
        expect(segment).toHaveLength(constants.maxBatchQueueItems);
        // Все элементы отрезка — принудительные транзакции длиннее предела; программа их пропустила.
        expect(report.forced).toHaveLength(segment.length);
        for (const [index, item] of segment.entries()) {
            if (item.kind !== 'forced') throw new Error('в отрезке блока 12 ожидались только принудительные транзакции');
            expect(hexBytes(item.bytes).length).toBeGreaterThan(MAX_FORCED_TX_BYTES);
            expect(report.forced[index]).toEqual({ queueIndex: index, outcome: 'skipped', reason: 'TooLong' });
        }
        // Контракт такую транзакцию в очередь не берёт: отрезок блока 12 теперь недостижим, и
        // пропуск по длине в программе остаётся защитой в глубину.
        const first = segment[0];
        if (first.kind !== 'forced') throw new Error('unreachable');
        const refused = await rollup.sendForceTransaction(user.getSender(), {
            l2Transaction: byteSnake(hexBytes(first.bytes)),
            value: (await rollup.getQueueFees()).forceTransactionFee,
        });
        expect(refused.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.malformedForcedTransaction,
        });
        expect((await rollup.getDepositQueue()).head.count).toBe(BigInt(blockOf(11).headAtBatch));

        // Состояние после батча 11 с очередью блока 12 — подложено; хеш очереди посчитан вне
        // контракта (той же формулой, что сверена с программой выше). Дайджест собирает контракт.
        const previous = reportOf(11);
        const head = blockOf(12).headAtBatch;
        const planted: PlantedState = {
            vkData: beginCell().endCell(),
            withdrawalsRoot: BigInt(previous.publicValues.withdrawalsRoot),
            withdrawalsCount: BigInt(previous.publicValues.withdrawalsCount),
            batchIndex: 11n,
            queue: {
                head: { count: BigInt(head), hash: queueHashes[head] },
                processed: { count: BigInt(previous.queueProcessedUpTo), hash: queueHashes[previous.queueProcessedUpTo] },
                prunedCount: BigInt(previous.queueProcessedUpTo),
            },
        };
        const twelfthConfig = { ...config, genesisStateRoot: BigInt(blockOf(11).hash) };
        const contract = Rollup.createPlanted(twelfthConfig, planted, code);
        await blockchain.setShardAccount(
            contract.address,
            createShardAccount({ address: contract.address, code, data: contract.init!.data, balance: toNano('1') }),
        );
        const twelfth = blockchain.openContract(contract);
        blockchain.now = blockOf(12).timestamp + 60;
        for (const data of dataChunksOf(report)) {
            await twelfth.sendPublishData(owner.getSender(), { batchIndex: 12, data, value: toNano('0.05') });
        }
        const roots = batchRootsOf(report);
        expect(await twelfth.getExpectedPublicInput(roots)).toBe(publicInputOf(report.publicValuesBytes));
        expect((await submit(roots, twelfth)).transactions).toHaveTransaction({ to: twelfth.address, success: true });
        expect((await twelfth.getRollupState()).stateRoot).toBe(BigInt(blockOf(12).hash));
    });

    it('порядок очереди — часть протокола: те же элементы в другом порядке дают другой публичный вход', async () => {
        await restore(1);
        const report = reportOf(2);
        const [from, to] = [blockOf(1).headAtBatch, blockOf(2).headAtBatch];
        const segment = rethExpected.queue.filter((item) => item.number > from && item.number <= to);
        expect(segment.length).toBeGreaterThan(1);
        // Последний элемент отрезка встаёт первым; остальные — следом, в прежнем порядке.
        for (const item of [segment[segment.length - 1], ...segment.slice(0, -1)]) {
            const fees = await rollup.getQueueFees();
            const sent =
                item.kind === 'deposit'
                    ? await rollup.sendDeposit(user.getSender(), {
                          l2Recipient: BigInt(item.l2Recipient),
                          value: BigInt(item.amount) + fees.depositFee,
                          maxFee: fees.depositFee,
                      })
                    : await rollup.sendForceTransaction(user.getSender(), {
                          l2Transaction: byteSnake(hexBytes(item.bytes)),
                          value: fees.forceTransactionFee,
                      });
            expect(sent.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        expect((await rollup.getDepositQueue()).head.count).toBe(BigInt(to));
        for (const data of dataChunksOf(report)) {
            await rollup.sendPublishData(owner.getSender(), { batchIndex: 2, data, value: toNano('0.05') });
        }
        // Данные те же, что у программы: расходится именно очередь.
        expect(await rollup.getBatchDataHash(2)).toBe(BigInt(report.publicValues.batchHash));
        expect(await rollup.getExpectedPublicInput(batchRootsOf(report))).not.toBe(publicInputOf(report.publicValuesBytes));
    });

    it('выводы через мост: листья блоков 2, 3 и 7 выплачиваются по доказательству против корня из батча, один раз', async () => {
        const withdrawWith = async (tree: ReturnType<typeof withdrawalTree>, leafIndex: number) => {
            const leaf = rethExpected.withdrawals[leafIndex];
            expect(leaf.leafIndex).toBe(leafIndex);
            return rollup.sendWithdraw(stranger.getSender(), {
                leafIndex,
                recipient: new Address(0, hexBytes(leaf.recipientHash)),
                amount: BigInt(leaf.amount),
                merkleProof: merkleProofCell(tree.proofFor(leafIndex)),
                value: (await rollup.getMinimumValues()).withdraw,
            });
        };
        // После батча 3 в дереве пять листьев; лист блока 7 ещё не существует.
        await restore(3);
        const early = withdrawalTree(withdrawalLeavesUpTo(3));
        const late = withdrawalTree(withdrawalLeavesUpTo(LAST_MESSAGE_BLOCK));
        expect((await rollup.getRollupState()).withdrawalsRoot).toBe(early.root);
        const premature = await withdrawWith(late, 36);
        expect(premature.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: RollupErrors.wrongMerkleProof });
        let paid = 0n;
        for (const leafIndex of [0, 4]) {
            const amount = BigInt(rethExpected.withdrawals[leafIndex].amount);
            expect((await withdrawWith(early, leafIndex)).transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: amount });
            paid += amount;
        }
        expect(await balanceOf(recipient)).toBe(paid);

        // После батча 11 — все 37 листьев: старые листья выводятся по новому корню, новые — тоже.
        await restore(LAST_MESSAGE_BLOCK);
        expect(rethExpected.withdrawals).toHaveLength(37);
        expect((await rollup.getRollupState()).withdrawalsRoot).toBe(late.root);
        expect((await rollup.getRollupState()).withdrawalsCount).toBe(37n);
        paid = 0n;
        for (const leafIndex of [0, 1, 2, 5, 36]) {
            const amount = BigInt(rethExpected.withdrawals[leafIndex].amount);
            expect((await withdrawWith(late, leafIndex)).transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: amount });
            paid += amount;
        }
        expect(await balanceOf(recipient)).toBe(paid);
        // Доказательство против прежнего корня больше не годится; повтор листа не платит.
        expect((await withdrawWith(early, 3)).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.wrongMerkleProof,
        });
        const again = await withdrawWith(late, 36);
        expect(again.transactions).toHaveTransaction({ success: false, exitCode: NullifierErrors.alreadyClaimed });
        expect(await balanceOf(recipient)).toBe(paid);
    });

    // REVIEW.md, 14-9: слово состояния, против которого идёт выход, записано БАТЧЕМ — состояние
    // построено сообщениями от генезиса, а не подложено в хранилище, как в tests/RollupEvmExit.spec.ts.
    const exitBlocks = rethExpected.exitsByBlock.filter(({ block }) => block <= LAST_MESSAGE_BLOCK);
    it('у цепочки есть выходы против каждого блока со второго', () => {
        expect(exitBlocks.map(({ block }) => block)).toEqual(Array.from({ length: LAST_MESSAGE_BLOCK - 1 }, (_, index) => index + 2));
        expect(rethExpected.exitsByBlock.map(({ block }) => block)).toContain(RETH_CHAIN_BLOCKS);
    });

    it.each(exitBlocks.map((entry) => [entry.block, entry] as const))(
        'батч записал слово состояния блока %i → заморозка → выходы счетов против него → возврат позднего депозита',
        async (number, entry) => {
            await restore(number);
            expect(BigInt(entry.blockHash)).toBe((await rollup.getRollupState()).stateRoot);
            const budget = await rollup.getEvmExitBudget();
            const send = (block: number, exit: (typeof entry.exits)[number], to = recipient) =>
                rollup.sendForceExitEvm(stranger.getSender(), { recipient: to, ...rethExitMessage(block, exit), value: budget.minValue });

            // До заморозки выхода нет.
            expect((await send(number, entry.exits[0])).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupNotFrozen,
            });
            const { late, index } = await freezeWithLateDeposit();
            // Согласие подписано под chainId, это слово состояния и этого получателя.
            expect(await rollup.getEvmExitConsentHash(BigInt(rethExpected.exitRecipientHash))).toBe(BigInt(entry.consentHash));

            // Выход против ПРЕЖНЕГО блока (его заголовок, его доказательство и подпись) не проходит:
            // контракт сверяет заголовок со словом состояния, которое записал последний батч.
            const stale = rethExpected.exitsByBlock.find(({ block }) => block === number - 1);
            if (stale) {
                expect((await send(number - 1, stale.exits[0])).transactions).toHaveTransaction({
                    to: rollup.address,
                    success: false,
                    exitCode: WRONG_BLOCK_HEADER,
                });
            }
            // Заголовок этого блока с доказательством счёта из прежнего — тоже нет (корень состояния другой).
            if (stale && stale.exits[0].accountProof[0] !== entry.exits[0].accountProof[0]) {
                const mixed = await rollup.sendForceExitEvm(stranger.getSender(), {
                    recipient,
                    ...rethExitMessage(number - 1, stale.exits[0]),
                    header: rethExitMessage(number, entry.exits[0]).header,
                    value: budget.minValue,
                });
                expect(mixed.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: 7403 });
            }

            let paid = 0n;
            expect(entry.exits.length).toBeGreaterThan(0);
            for (const exit of entry.exits) {
                const amount = BigInt(exit.balanceWei) / WEI_PER_NANOTON;
                expect(amount).toBeGreaterThan(0n);
                const exited = await send(number, exit);
                expect(exited.transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: amount });
                paid += amount;
            }
            expect(await balanceOf(recipient)).toBe(paid);
            // Повтор не платит. Чтобы отказ пришёл именно от нуллификатора счёта, а не от ранней
            // проверки «нечем платить», контракт пополнен: денег на повторную выплату хватило бы.
            await owner.send({ to: rollup.address, value: toNano('10') });
            for (const exit of entry.exits) {
                const again = await send(number, exit);
                expect(again.transactions).toHaveTransaction({ success: false, exitCode: NullifierErrors.alreadyClaimed });
            }
            expect(await balanceOf(recipient)).toBe(paid);
            // Заголовок действительно тот, что принёс батч: хеш сверен в blockHeaderOf.
            expect(blockHeaderOf(number).length).toBeGreaterThan(500);

            // Поздний депозит не обработан ни одним батчем и возвращается вносителю.
            const refund = await rollup.sendCancelDeposit(user.getSender(), { depositIndex: index, value: toNano('0.05') });
            expect(refund.transactions).toHaveTransaction({ from: rollup.address, to: stranger.address, value: late });
            // Обработанный депозит вернуть нельзя: он уже на L2.
            const processed = await rollup.sendCancelDeposit(user.getSender(), { depositIndex: 1, value: toNano('0.05') });
            expect(processed.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.depositAlreadyProcessed,
            });
        },
    );

    it('после заморозки возвращается и депозит цепочки, не дождавшийся своего батча', async () => {
        // Блок 1 обработал очередь не до головы: второй элемент (депозит) к приёму батча 1 уже
        // стоит в очереди, но в блок не вошёл. Секвенсор пропал — депозит возвращается вносителю.
        await restore(1);
        const pending = rethExpected.queue[1];
        if (pending.kind !== 'deposit') throw new Error('второй элемент очереди цепочки — депозит');
        expect(blockOf(1).queueProcessedUpTo).toBe(1);
        expect(blockOf(1).headAtBatch).toBe(2);
        await freezeWithLateDeposit();
        const refund = await rollup.sendCancelDeposit(stranger.getSender(), { depositIndex: 2, value: toNano('0.05') });
        expect(refund.transactions).toHaveTransaction({ from: rollup.address, to: user.address, value: BigInt(pending.amount) });
        expect(await rollup.getDepositReceipt(2)).toBeNull();
    });

    it('очередь блоков 2–11 встаёт и на свежем контракте: сумма депозитов цепочки покрывает все её выплаты', async () => {
        await restore(0);
        blockchain.now = blockOf(1).timestamp + 60;
        const deposited = await enqueueUpTo(actors, blockOf(LAST_MESSAGE_BLOCK).headAtBatch);
        const withdrawn = rethExpected.withdrawals.reduce((sum, leaf) => sum + BigInt(leaf.amount), 0n);
        const finalExits = rethExpected.exitsByBlock.find(({ block }) => block === LAST_MESSAGE_BLOCK)!;
        const exiting = finalExits.exits.reduce((sum, exit) => sum + BigInt(exit.balanceWei) / WEI_PER_NANOTON, 0n);
        // Все монеты L2 — из депозитов: выводы через мост и остатки выходящих счетов вместе не
        // больше внесённого (остальное — газ L2, чаевые и счета, которые здесь не выходят).
        expect(withdrawn + exiting).toBeLessThanOrEqual(deposited);
        expect(await balanceOf(rollup.address)).toBeGreaterThanOrEqual(deposited);
    });
});
