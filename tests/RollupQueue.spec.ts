import { Blockchain, createShardAccount, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { BASE_DEPOSIT_FEE, BatchRoots, PlantedState, Rollup, RollupConfig, RollupErrors } from '../wrappers/Rollup';
import {
    batchDigest,
    depositHash,
    forcedTransactionCell,
    forcedTransactionHash,
    MAX_FORCED_TX_BYTES,
    sha256Int,
} from '../wrappers/rollupMath';
import { FORCE_TRANSACTION_VALUE } from '../wrappers/rollupValues';
import { saveGasReport } from './helpers/benchResults';
import { computePhaseOf } from './helpers/gas';
import { finalizeDummyKeys, mockProof, ProtocolConstants, readProtocolConstants, testConfig } from './helpers/rollupSetup';

// Очередь L1 протокола v2 на тестовом двойнике (PROTOCOL-V2.md, раздел 5 с правками 0.2):
// батч сам заявляет отметку N, до которой обработал очередь; контракт берёт хеш в точке N из
// словаря элементов, ограничивает отрезок и убирает записи обработанных элементов.
const CHAIN_ID = 4242n;
const TIMEOUT = 3600;
const START = 1_800_000_000;
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;
const NO_HINTS = beginCell().endCell();
const transactionBytes = (fill: number, length = 110) => Buffer.alloc(length, fill);

describe('Rollup: очередь L1 с отметкой батча', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let constants: ProtocolConstants;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let config: RollupConfig;
    const gas: Record<string, number> = {};
    let budgets: { depositStepGas: number; forceTransactionStepGas: number };

    const roots = (newStateRoot: bigint, queueProcessedUpTo: bigint | number): BatchRoots => ({
        newStateRoot,
        withdrawalsRoot: 0n,
        withdrawalsCount: 0n,
        queueProcessedUpTo: BigInt(queueProcessedUpTo),
        blockTimestamp: BigInt(blockchain.now!),
    });
    const submit = (batch: BatchRoots, on = rollup) =>
        on.sendSubmitBatch(sequencer.getSender(), { proof: mockProof(), hints: NO_HINTS, roots: batch, value: toNano('0.2') });
    const deposit = (value = toNano('1')) => rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value });
    const force = (bytes: Buffer) =>
        rollup.sendForceTransaction(user.getSender(), {
            l2Transaction: forcedTransactionCell(bytes),
            value: FORCE_TRANSACTION_VALUE,
        });
    /** Ставит в очередь `count` элементов, депозиты и принудительные транзакции вперемежку. */
    const enqueue = async (count: number, hashes: bigint[]) => {
        for (let index = 0; index < count; index++) {
            const previous = hashes[hashes.length - 1];
            if (hashes.length % 3 === 2) {
                const bytes = transactionBytes(hashes.length);
                expect((await force(bytes)).transactions).toHaveTransaction({ to: rollup.address, success: true });
                hashes.push(forcedTransactionHash(previous, bytes));
            } else {
                expect((await deposit()).transactions).toHaveTransaction({ to: rollup.address, success: true });
                hashes.push(depositHash(previous, L2_RECIPIENT, toNano('1') - BASE_DEPOSIT_FEE));
            }
        }
    };
    /** Публичный вход батча, каким его обязан потребовать контракт при таких хешах очереди. */
    const digest = (batch: BatchRoots, prevStateRoot: bigint, prevDepositHash: bigint, newDepositHash: bigint) =>
        batchDigest({
            chainId: CHAIN_ID,
            prevStateRoot,
            newStateRoot: batch.newStateRoot,
            batchHash: 0n,
            prevWithdrawalsRoot: 0n,
            withdrawalsRoot: batch.withdrawalsRoot,
            prevDepositHash,
            newDepositHash,
            prevWithdrawalsCount: 0n,
            withdrawalsCount: batch.withdrawalsCount,
            blockTimestamp: batch.blockTimestamp,
        });
    const rejected = (result: { transactions: unknown }, exitCode: number) =>
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode });
    const accepted = (result: { transactions: unknown }) =>
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
    /** Очередь и её словарь прямо из хранилища: без get-методов. */
    const stored = async (contract = rollup) => {
        const account = (await blockchain.getContract(contract.address)).accountState;
        if (account?.type !== 'active') throw new Error('контракт не развёрнут');
        return Rollup.queueFromData(account.state.data!);
    };
    /** Контракт с подложенным состоянием очереди и «зафиксированным» ключом — мимо сообщений. */
    const plant = async (planted: PlantedState, balance = toNano('5')) => {
        const contract = Rollup.createPlanted(config, { vkData: beginCell().endCell(), ...planted }, code);
        await blockchain.setShardAccount(
            contract.address,
            createShardAccount({ address: contract.address, code, data: contract.init!.data, balance }),
        );
        return blockchain.openContract(contract);
    };

    beforeAll(async () => {
        code = await compile('RollupMock');
        nullifierCode = await compile('RollupNullifier');
        constants = await readProtocolConstants(code, nullifierCode);
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = START;
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        user = await blockchain.treasury('user');
        config = testConfig(constants, {
            owner: owner.address,
            sequencer: sequencer.address,
            nullifierCode,
            chainId: CHAIN_ID,
            escapeTimeout: TIMEOUT,
        });
        rollup = blockchain.openContract(Rollup.createFromConfig(config, code));
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
        await finalizeDummyKeys(rollup, owner);
        budgets = await rollup.getQueueBudgets();
    });

    afterAll(() => {
        saveGasReport(
            'rollup-queue-gas.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupQueue.spec.ts на двойнике (contracts/rollup_mock.tolk); не редактировать вручную',
                note: 'Шаги очереди L1 протокола v2 на словаре очереди, заполненном до предела: в словаре maxTrackedItems − 1 записей с номерами подряд, постановка убирает две прежние и добавляет одну. Номера подобраны под САМУЮ ГЛУБОКУЮ вставку: новая запись — последний лист полного поддерева (номер 2^14 − 1), путь к ней проходит все 13 развилок словаря; убираемые записи лежат так же глубоко. depositFullQueue — депозит; forceTransactionFullQueue — принудительная транзакция наибольшей длины (maxForcedTxBytes байт в maxForcedTxCells ячейках); depositShallowInsert и forceTransactionShallowInsert — те же шаги на словаре того же размера, где новая запись ложится у корня (номера с единицы; так мерилось до круга 14); forceTransactionOneCell — принудительная транзакция из одной ячейки на пустой очереди. mockSubmitBatchAtHead и mockSubmitBatchMidQueue — батч ДВОЙНИКА (без проверки пруфа) с отметкой на голове очереди и в её середине на том же словаре: разница — цена поиска записи в словаре, которую настоящий батч заплатит сверх проверки пруфа. pruneFiftyEntries — уборка 50 записей одним сообщением. Запасы шагов (depositStepGas, forceTransactionStepGas) — из get-метода queueBudgets.',
                maxTrackedItems: constants.maxTrackedItems,
                maxForcedTxCells: constants.maxForcedTxCells,
                maxForcedTxBytes: constants.maxForcedTxBytes,
                maxBatchQueueItems: constants.maxBatchQueueItems,
                depositStepGas: budgets.depositStepGas,
                forceTransactionStepGas: budgets.forceTransactionStepGas,
            },
            gas,
            [
                'depositFullQueue',
                'forceTransactionFullQueue',
                'depositShallowInsert',
                'forceTransactionShallowInsert',
                'forceTransactionOneCell',
                'mockSubmitBatchAtHead',
                'mockSubmitBatchMidQueue',
                'pruneFiftyEntries',
            ],
        );
        console.table(gas);
    });

    describe('отметка N', () => {
        // hashes[i] — хеш очереди после i элементов, посчитанный вне контракта.
        let hashes: bigint[];
        let stateRoot: bigint;

        beforeEach(async () => {
            hashes = [0n];
            await enqueue(5, hashes);
            // Первый батч обрабатывает два элемента из пяти: дальше processed = 2, head = 5.
            const first = roots(sha256Int(2n), 2);
            accepted(await submit(first));
            stateRoot = first.newStateRoot;
        });

        it('словарь хранит для каждого элемента хеш очереди ДО него и время постановки', async () => {
            for (let index = 1; index <= 5; index++) {
                expect(await rollup.getQueueItem(index)).toEqual({ hashBefore: hashes[index - 1], queuedAt: START });
            }
            expect(await rollup.getQueueItem(6)).toBeNull();
            expect(await rollup.getQueueItem(0)).toBeNull();
            const queue = await rollup.getDepositQueue();
            expect(queue.head).toEqual({ count: 5n, hash: hashes[5] });
            expect(queue.processed).toEqual({ count: 2n, hash: hashes[2] });
        });

        it('контракт подставляет в публичный вход хеш очереди ровно в точке N — для каждого N от processed до head', async () => {
            // Ловит «хеш после вместо хеша до» и «запись N вместо N + 1»: все пять хешей разные.
            expect(new Set(hashes).size).toBe(6);
            for (let n = 2; n <= 5; n++) {
                const batch = roots(sha256Int(3n), n);
                expect(await rollup.getExpectedPublicInput(batch)).toBe(digest(batch, stateRoot, hashes[2], hashes[n]));
            }
        });

        it('N меньше processed — отказ: обработанное назад не возвращается', async () => {
            for (const n of [1, 0]) {
                rejected(await submit(roots(sha256Int(3n), n)), RollupErrors.queueMarkOutOfRange);
            }
            expect((await rollup.getDepositQueue()).processed).toEqual({ count: 2n, hash: hashes[2] });
            expect((await rollup.getRollupState()).batchIndex).toBe(1);
        });

        it('N больше head — отказ: заявить обработку того, чего в очереди нет, нельзя', async () => {
            rejected(await submit(roots(sha256Int(3n), 6)), RollupErrors.queueMarkOutOfRange);
            rejected(await submit(roots(sha256Int(3n), 1n << 40n)), RollupErrors.queueMarkOutOfRange);
            expect((await rollup.getRollupState()).batchIndex).toBe(1);
        });

        it('N равно processed — пустой отрезок: батч принят, очередь не сдвинулась', async () => {
            accepted(await submit(roots(sha256Int(3n), 2)));
            const queue = await rollup.getDepositQueue();
            expect(queue.processed).toEqual({ count: 2n, hash: hashes[2] });
            expect(queue.head).toEqual({ count: 5n, hash: hashes[5] });
            expect((await rollup.getRollupState()).batchIndex).toBe(2);
        });

        it('N посередине — обработано ровно до N, остальное ждёт следующего батча', async () => {
            accepted(await submit(roots(sha256Int(3n), 4)));
            const queue = await rollup.getDepositQueue();
            expect(queue.processed).toEqual({ count: 4n, hash: hashes[4] });
            expect(queue.head).toEqual({ count: 5n, hash: hashes[5] });
            // Следующий батч продолжает с новой отметки: прежний хеш очереди — хеш в точке 4.
            const next = roots(sha256Int(4n), 5);
            expect(await rollup.getExpectedPublicInput(next)).toBe(digest(next, sha256Int(3n), hashes[4], hashes[5]));
        });

        it('N равно head — очередь обработана целиком', async () => {
            accepted(await submit(roots(sha256Int(3n), 5)));
            const queue = await rollup.getDepositQueue();
            expect(queue.processed).toEqual(queue.head);
            expect(queue.head).toEqual({ count: 5n, hash: hashes[5] });
            expect((await rollup.getQueueFees()).pending).toBe(0);
        });

        it('элемент, вставший в очередь между сборкой блока и приёмом батча, батч не ломает', async () => {
            // Сценарий 6-Г: секвенсор собрал блок, обработавший очередь до головы (N = 5), и строит
            // пруф. Пока он строит, приходит чужой депозит. В протоколе v1 это меняло публичный
            // вход, и готовый пруф пропадал.
            const batch = roots(sha256Int(3n), 5);
            const required = await rollup.getExpectedPublicInput(batch);
            expect(required).toBe(digest(batch, stateRoot, hashes[2], hashes[5]));

            blockchain.now = START + 60;
            await enqueue(2, hashes);
            expect((await rollup.getDepositQueue()).head.count).toBe(7n);
            // Публичный вход для N = 5 тот же: хеш в точке 5 от новых элементов не зависит.
            expect(await rollup.getExpectedPublicInput(batch)).toBe(required);
            accepted(await submit(batch));
            const queue = await rollup.getDepositQueue();
            expect(queue.processed).toEqual({ count: 5n, hash: hashes[5] });
            expect(queue.head).toEqual({ count: 7n, hash: hashes[7] });
            // Срок заморозки теперь идёт от первого из опоздавших.
            expect((await rollup.getEscapeState()).oldestPendingAt).toBe(START + 60);
        });
    });

    describe('предел элементов на батч', () => {
        it('ровно предел — принят, на один больше — отказ, хотя элементы в очереди есть', async () => {
            const limit = constants.maxBatchQueueItems;
            const hashes = [0n];
            await enqueue(limit + 2, hashes);
            // Отметка в пределах очереди, но отрезок длиннее предела: свой код отказа.
            rejected(await submit(roots(sha256Int(2n), limit + 1)), RollupErrors.tooManyQueueItems);
            rejected(await submit(roots(sha256Int(2n), limit + 2)), RollupErrors.tooManyQueueItems);
            expect((await rollup.getDepositQueue()).processed.count).toBe(0n);

            accepted(await submit(roots(sha256Int(2n), limit)));
            expect((await rollup.getDepositQueue()).processed).toEqual({ count: BigInt(limit), hash: hashes[limit] });
            // Предел считается от новой отметки: остаток уходит следующим батчем.
            accepted(await submit(roots(sha256Int(3n), limit + 2)));
            expect((await rollup.getDepositQueue()).processed.count).toBe(BigInt(limit + 2));
        });
    });

    describe('уборка словаря', () => {
        it('постановка в очередь убирает до двух записей обработанных элементов и не трогает необработанные', async () => {
            expect(constants.prunePerPush).toBe(2);
            const hashes = [0n];
            await enqueue(6, hashes);
            accepted(await submit(roots(sha256Int(2n), 3))); // обработаны 1–3, ждут 4–6
            expect((await stored()).items.keys()).toEqual([1n, 2n, 3n, 4n, 5n, 6n]);

            await enqueue(1, hashes); // 7: убирает 1 и 2
            expect((await stored()).items.keys()).toEqual([3n, 4n, 5n, 6n, 7n]);
            expect((await rollup.getDepositQueue()).prunedCount).toBe(2n);
            await enqueue(1, hashes); // 8: убирает 3; запись 4 не обработана и остаётся
            expect((await stored()).items.keys()).toEqual([4n, 5n, 6n, 7n, 8n]);
            expect((await rollup.getDepositQueue()).prunedCount).toBe(3n);
            await enqueue(1, hashes); // 9: убирать нечего
            expect((await stored()).items.keys()).toEqual([4n, 5n, 6n, 7n, 8n, 9n]);
            expect((await rollup.getDepositQueue()).prunedCount).toBe(3n);

            // Необработанные записи целы: батч с отметкой в середине берёт хеш из словаря.
            const batch = roots(sha256Int(3n), 5);
            expect(await rollup.getExpectedPublicInput(batch)).toBe(digest(batch, sha256Int(2n), hashes[3], hashes[5]));
            accepted(await submit(batch));
        });

        it('сообщение уборки удаляет не больше заданного числа записей и только обработанные', async () => {
            const hashes = [0n];
            await enqueue(8, hashes);
            accepted(await submit(roots(sha256Int(2n), 5))); // обработаны 1–5, ждут 6–8
            const prune = (count: number) =>
                rollup.sendPruneDepositReceipts(sequencer.getSender(), { count, value: toNano('0.05') });

            accepted(await prune(2));
            expect((await stored()).items.keys()).toEqual([3n, 4n, 5n, 6n, 7n, 8n]);
            expect((await rollup.getDepositQueue()).prunedCount).toBe(2n);
            // Просят больше, чем есть мусора: уборка останавливается на отметке processed.
            accepted(await prune(100));
            expect((await stored()).items.keys()).toEqual([6n, 7n, 8n]);
            expect((await rollup.getDepositQueue()).prunedCount).toBe(5n);
            accepted(await prune(100));
            expect((await stored()).items.keys()).toEqual([6n, 7n, 8n]);

            // Всё, что нужно контракту от необработанных записей, на месте: квитанция депозита,
            // срок заморозки и хеш в точке N.
            expect(await rollup.getDepositReceipt(7)).not.toBeNull();
            expect((await rollup.getEscapeState()).oldestPendingAt).toBe(START);
            const batch = roots(sha256Int(3n), 7);
            expect(await rollup.getExpectedPublicInput(batch)).toBe(digest(batch, sha256Int(2n), hashes[5], hashes[7]));
        });
    });

    describe('предел отслеживаемых записей', () => {
        it('очередь из maxTrackedItems необработанных элементов больше не растёт; после батча место появляется', async () => {
            // Столько необработанных элементов сообщениями не набрать: плата за место к этому
            // времени удвоена сорок раз. Поэтому очередь подложена: необработанных ровно на один
            // меньше предела, мусора нет. Суммы — миллиарды TON, и get-методы после первого же
            // депозита недоступны (Sandbox не исполняет их при балансе от 2^63 нанотон): очередь
            // читается из хранилища.
            const limit = BigInt(constants.maxTrackedItems);
            const pending = limit - 1n;
            const items = Rollup.queueItemsDictionary();
            const batchSize = BigInt(constants.maxBatchQueueItems);
            // Запись, по которой батч возьмёт хеш в точке «обработано batchSize элементов».
            items.set(batchSize + 1n, { hashBefore: 777n, queuedAt: START, receipt: null });
            rollup = await plant({ queue: { head: { count: pending, hash: 1n } }, queueItems: items });
            const { depositFee } = await rollup.getQueueFees();
            const whale = await blockchain.treasury('whale', { balance: 8n * depositFee });
            const push = () =>
                rollup.sendDeposit(whale.getSender(), {
                    l2Recipient: L2_RECIPIENT,
                    value: depositFee + toNano('1'),
                    maxFee: depositFee,
                });

            // Последнее свободное место: принят, записей стало ровно maxTrackedItems.
            accepted(await push());
            expect((await stored()).head.count).toBe(limit);
            // Места нет: отказ, депозит возвращается, очередь не изменилась.
            const full = await push();
            rejected(full, RollupErrors.queueStorageFull);
            expect(full.transactions).toHaveTransaction({ from: rollup.address, to: whale.address, inMessageBounced: true });
            expect((await stored()).head.count).toBe(limit);

            // Батч обработал часть очереди: появился мусор, постановка его убирает и проходит.
            accepted(await submit(roots(sha256Int(2n), batchSize)));
            expect((await stored()).processed).toEqual({ count: batchSize, hash: 777n });
            accepted(await push());
            const queue = await stored();
            expect(queue.head.count).toBe(limit + 1n);
            expect(queue.prunedCount).toBe(2n);
        });
    });

    describe('счётчик убранных записей и целостность словаря (REVIEW.md, 14-5)', () => {
        it('батч не трогает счётчик убранных записей: уборка продолжается с того же места', async () => {
            const hashes = [0n];
            await enqueue(6, hashes);
            accepted(await submit(roots(sha256Int(2n), 3))); // обработаны 1–3
            await enqueue(1, hashes); // 7: убирает 1 и 2
            expect((await rollup.getDepositQueue()).prunedCount).toBe(2n);

            // Батч с отметкой и в середине очереди, и на голове: счётчик убранных — прежний.
            accepted(await submit(roots(sha256Int(3n), 5)));
            expect((await rollup.getDepositQueue()).prunedCount).toBe(2n);
            accepted(await submit(roots(sha256Int(4n), 7)));
            expect((await rollup.getDepositQueue()).prunedCount).toBe(2n);
            expect((await stored()).items.keys()).toEqual([3n, 4n, 5n, 6n, 7n]);

            // Обнулись счётчик — следующая постановка «убирала» бы уже убранные 1 и 2, а записи
            // 3 и 4 остались бы в словаре навсегда.
            await enqueue(1, hashes); // 8: убирает 3 и 4
            expect((await stored()).items.keys()).toEqual([5n, 6n, 7n, 8n]);
            expect((await rollup.getDepositQueue()).prunedCount).toBe(4n);
            // И явная уборка добирает остальное ровно до отметки processed.
            accepted(await rollup.sendPruneDepositReceipts(user.getSender(), { count: 100, value: toNano('0.05') }));
            expect((await stored()).items.keys()).toEqual([8n]);
            expect((await rollup.getDepositQueue()).prunedCount).toBe(7n);
        });

        it('предел записей считается от счётчика убранных, а не от отметки обработанного', async () => {
            // Предел — про память контракта: сколько записей лежит в словаре, обработанных и нет.
            // Состояние подложено и сообщениями недостижимо (от генезиса неубранных записей больше
            // предела не накопить: постановка растит словарь, только когда мусора в нём нет, а
            // тогда оба счёта совпадают). Тест закрепляет саму формулу: необработанных всего три,
            // но неубранных — на пять больше предела, и после попутной уборки двух записей места
            // всё ещё нет.
            const limit = BigInt(constants.maxTrackedItems);
            const head = limit + 5n;
            rollup = await plant({
                queue: {
                    head: { count: head, hash: 1n },
                    processed: { count: head - 3n, hash: 2n },
                    prunedCount: 0n,
                },
            });
            const refused = await deposit();
            rejected(refused, RollupErrors.queueStorageFull);
            expect((await stored()).head.count).toBe(head);
            expect((await stored()).prunedCount).toBe(0n);

            // Уборка освобождает место: неубранных стало на одну меньше предела.
            accepted(await rollup.sendPruneDepositReceipts(user.getSender(), { count: 6, value: toNano('0.05') }));
            expect((await stored()).prunedCount).toBe(6n);
            accepted(await deposit());
            expect((await stored()).head.count).toBe(head + 1n);
        });

        it('батч с отметкой в середине очереди отказывает кодом 7334, если записи в словаре нет', async () => {
            // Запись элемента N + 1 при N < head обязана существовать: по ней берётся хеш очереди
            // в точке N. Сообщениями её не удалить (необработанные записи убирает только возврат
            // депозита после заморозки), поэтому состояние подложено: пять элементов, записи
            // третьего нет.
            const items = Rollup.queueItemsDictionary();
            for (const index of [1n, 2n, 4n, 5n]) {
                items.set(index, { hashBefore: sha256Int(100n + index), queuedAt: START, receipt: null });
            }
            rollup = await plant({ queue: { head: { count: 5n, hash: sha256Int(200n) } }, queueItems: items });
            expect(RollupErrors.queueEntryMissing).toBe(7334);
            rejected(await submit(roots(sha256Int(2n), 2)), RollupErrors.queueEntryMissing);
            expect((await stored()).processed.count).toBe(0n);
            // Соседние отметки, записи которых на месте, принимаются: отказ — именно из-за дыры.
            const snapshot = blockchain.snapshot();
            accepted(await submit(roots(sha256Int(2n), 1)));
            expect((await stored()).processed).toEqual({ count: 1n, hash: sha256Int(102n) });
            await blockchain.loadFrom(snapshot);
            accepted(await submit(roots(sha256Int(2n), 3)));
            expect((await stored()).processed).toEqual({ count: 3n, hash: sha256Int(104n) });
            // На голове очереди запись не нужна вовсе.
            await blockchain.loadFrom(snapshot);
            accepted(await submit(roots(sha256Int(2n), 5)));
            expect((await stored()).processed).toEqual({ count: 5n, hash: sha256Int(200n) });
        });
    });

    describe('газ на словаре, заполненном до предела', () => {
        /**
         * Словарь из maxTrackedItems − 1 записей с номерами подряд и очередь, в которой почти всё
         * обработано, но ничего не убрано. `pruned` — сколько записей «уже убрано», то есть с
         * какого номера начинается словарь.
         *
         * Цена вставки зависит от того, где в словаре ляжет новая запись. С номерами от единицы
         * новая запись (номер 2^13) ложится у самого корня — это самый дешёвый случай. Самый
         * дорогой — номер, у которого все младшие биты единицы: запись становится последним
         * листом заполненного поддерева, и путь к ней проходит все развилки. Поэтому по умолчанию
         * словарь начинается так, чтобы следующий номер был 2^14 − 1.
         */
        const fullQueue = async (unprocessed: bigint, pruned = deepestBase()) => {
            const count = BigInt(constants.maxTrackedItems) - 1n;
            const items = Rollup.queueItemsDictionary();
            for (let index = pruned + 1n; index <= pruned + count; index++) {
                items.set(index, {
                    hashBefore: sha256Int(index),
                    queuedAt: START,
                    receipt: index % 3n === 0n ? null : { depositor: user.address, amount: toNano('1') },
                });
            }
            const head = pruned + count;
            return plant({
                queue: {
                    head: { count: head, hash: sha256Int(head + 1n) },
                    processed: { count: head - unprocessed, hash: sha256Int(head - unprocessed + 1n) },
                    prunedCount: pruned,
                },
                queueItems: items,
            });
        };
        /** Сколько записей «убрано», чтобы следующая постановка получила номер из одних единиц. */
        const deepestBase = () => {
            const tracked = BigInt(constants.maxTrackedItems);
            // Наименьшее число вида 2^k − 1, не меньшее 2 · maxTrackedItems − 1: словарь занимает
            // всё поддерево под старшим битом, кроме последнего листа.
            let next = 1n;
            while (next < 2n * tracked - 1n) next = next * 2n + 1n;
            return next - tracked;
        };
        const longestTransaction = () => {
            // Самая длинная допустимая транзакция: maxForcedTxBytes байт в maxForcedTxCells ячейках.
            const bytes = Buffer.alloc(MAX_FORCED_TX_BYTES);
            for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 131 + 7) & 255;
            expect(bytes.length).toBe(constants.maxForcedTxBytes);
            expect(forcedTransactionCell(bytes).depth() + 1).toBe(constants.maxForcedTxCells);
            return bytes;
        };
        /**
         * Депозит и принудительная транзакция наибольшей длины на полном словаре; возвращает их
         * газ. Каждый шаг — на своём свежем словаре: иначе глубокая вставка досталась бы только
         * первому из них.
         */
        const queueSteps = async (pruned: bigint) => {
            rollup = await fullQueue(3n, pruned);
            const before = await stored();
            expect(before.items.size).toBe(constants.maxTrackedItems - 1);
            expect(before.prunedCount).toBe(pruned);
            const firstNewIndex = before.head.count + 1n;
            /** Убраны две записи, добавлена одна — с ожидаемым номером и хешем очереди. */
            const pushed = async (headHash: bigint) => {
                const after = await stored();
                expect(after.items.size).toBe(constants.maxTrackedItems - 2);
                expect(after.prunedCount).toBe(pruned + 2n);
                expect(after.items.keys().at(-1)).toBe(firstNewIndex);
                expect(after.head).toEqual({ count: firstNewIndex, hash: headHash });
            };

            const deposited = await deposit();
            accepted(deposited);
            const depositGas = Number(computePhaseOf(deposited.transactions, rollup.address).gasUsed);
            await pushed(depositHash(before.head.hash, L2_RECIPIENT, toNano('1') - BASE_DEPOSIT_FEE));

            rollup = await fullQueue(3n, pruned);
            const bytes = longestTransaction();
            const forced = await rollup.sendForceTransaction(user.getSender(), {
                l2Transaction: forcedTransactionCell(bytes),
                value: FORCE_TRANSACTION_VALUE,
            });
            accepted(forced);
            const forceGas = Number(computePhaseOf(forced.transactions, rollup.address).gasUsed);
            await pushed(forcedTransactionHash(before.head.hash, bytes));
            return { depositGas, forceGas, firstNewIndex };
        };

        it('депозит и принудительная транзакция наибольшей длины укладываются в запасы газа — на самой глубокой вставке', async () => {
            const { depositGas, forceGas, firstNewIndex } = await queueSteps(deepestBase());
            // Номер новой записи — из одних единиц: последний лист заполненного поддерева.
            expect(firstNewIndex & (firstNewIndex + 1n)).toBe(0n);
            expect(firstNewIndex).toBeGreaterThan(BigInt(constants.maxTrackedItems));
            gas.depositFullQueue = depositGas;
            gas.forceTransactionFullQueue = forceGas;
            expect(gas.depositFullQueue).toBeLessThanOrEqual(budgets.depositStepGas);
            expect(gas.forceTransactionFullQueue).toBeLessThanOrEqual(budgets.forceTransactionStepGas);
        });

        it('вставка у корня словаря дешевле глубокой: прежний замер шёл на ней', async () => {
            const shallow = await queueSteps(0n);
            gas.depositShallowInsert = shallow.depositGas;
            gas.forceTransactionShallowInsert = shallow.forceGas;
            const deep = await queueSteps(deepestBase());
            expect(deep.depositGas).toBeGreaterThan(shallow.depositGas);
            expect(deep.forceGas).toBeGreaterThan(shallow.forceGas);
        });

        it('поиск записи в полном словаре: батч с отметкой в середине против батча на голове', async () => {
            rollup = await fullQueue(10n);
            const queue = await stored();
            const middle = await submit(roots(sha256Int(2n), queue.head.count - 5n));
            accepted(middle);
            gas.mockSubmitBatchMidQueue = Number(computePhaseOf(middle.transactions, rollup.address).gasUsed);
            const head = await submit(roots(sha256Int(3n), queue.head.count));
            accepted(head);
            gas.mockSubmitBatchAtHead = Number(computePhaseOf(head.transactions, rollup.address).gasUsed);
            expect((await stored()).processed).toEqual(queue.head);
        });

        it('уборка пятидесяти записей одним сообщением', async () => {
            rollup = await fullQueue(3n);
            const before = await stored();
            const pruned = await rollup.sendPruneDepositReceipts(user.getSender(), { count: 50, value: toNano('0.1') });
            accepted(pruned);
            gas.pruneFiftyEntries = Number(computePhaseOf(pruned.transactions, rollup.address).gasUsed);
            expect((await stored()).prunedCount).toBe(before.prunedCount + 50n);
            expect((await stored()).items.size).toBe(constants.maxTrackedItems - 1 - 50);
        });

        it('принудительная транзакция из одной ячейки на пустой очереди', async () => {
            const forced = await force(transactionBytes(1, 122));
            accepted(forced);
            gas.forceTransactionOneCell = Number(computePhaseOf(forced.transactions, rollup.address).gasUsed);
            expect(gas.forceTransactionOneCell).toBeLessThanOrEqual(budgets.forceTransactionStepGas);
        });
    });
});
