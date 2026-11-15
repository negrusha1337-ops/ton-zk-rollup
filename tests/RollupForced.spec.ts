import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { finalizeDummyKeys, mockProof, ProtocolConstants, readProtocolConstants, testConfig } from './helpers/rollupSetup';
import { Rollup, RollupErrors } from '../wrappers/Rollup';
import {
    byteSnake,
    depositHash,
    forcedTransactionCell,
    forcedTransactionHash,
    forcedTransactionKeccak,
    MAX_FORCED_TX_BYTES,
    MAX_FORCED_TX_CELLS,
    sha256Int,
} from '../wrappers/rollupMath';
import { FORCE_TRANSACTION_VALUE } from '../wrappers/rollupValues';
import { computePhaseOf } from './helpers/gas';

// Принудительные транзакции L2 на тестовом двойнике (contracts/rollup_mock.tolk), протокол v2:
// байты подписанной транзакции EVM приходят «змейкой» ячеек, в очередь L1 идёт keccak-256 этих
// байтов. Контракт проверяет только форму «змейки»; что транзакция — корректный вывод через
// мост, решает программа zkVM (негодную она пропустит).
const CHAIN_ID = 4242n;
const TIMEOUT = 3600;
const START = 1_800_000_000;
const DEPOSIT_FEE = toNano('0.01');
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;
const NO_HINTS = beginCell().endCell();
/** Байты «транзакции»: контракт их не разбирает. Все байты разные, чтобы порядок был виден в хеше. */
const transactionBytes = (seed: number, length = 110) =>
    Buffer.from(Array.from({ length }, (_, index) => (index * 31 + seed) & 255));

describe('Rollup: принудительные транзакции L2 на тестовом двойнике', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let constants: ProtocolConstants;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;

    const forceCell = (l2Transaction: Cell, value = FORCE_TRANSACTION_VALUE) =>
        rollup.sendForceTransaction(user.getSender(), { l2Transaction, value });
    const force = (bytes: Buffer, pieces?: number[]) => forceCell(forcedTransactionCell(bytes, pieces));
    const submit = (newStateRoot: bigint, queueProcessedUpTo: number) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof(),
            hints: NO_HINTS,
            roots: {
                newStateRoot,
                withdrawalsRoot: 0n,
                withdrawalsCount: 0n,
                queueProcessedUpTo: BigInt(queueProcessedUpTo),
                blockTimestamp: BigInt(blockchain.now!),
            },
            value: toNano('0.2'),
        });
    const malformed = async (cell: Cell) => {
        const before = await rollup.getDepositQueue();
        expect((await forceCell(cell)).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.malformedForcedTransaction,
        });
        expect(await rollup.getDepositQueue()).toEqual(before);
    };
    const queuedHash = async () => (await rollup.getDepositQueue()).head.hash;
    /** Регистрирует ячейку как библиотеку и возвращает ссылку на неё (экзотическую ячейку). */
    const libraryReferenceTo = (content: Cell) => {
        const libraries = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        libraries.set(BigInt('0x' + content.hash().toString('hex')), content);
        blockchain.libs = beginCell().storeDictDirect(libraries).endCell();
        return beginCell().storeUint(2, 8).storeBuffer(content.hash()).endCell({ exotic: true });
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
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                testConfig(constants, {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode,
                    chainId: CHAIN_ID,
                    escapeTimeout: TIMEOUT,
                }),
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
        await finalizeDummyKeys(rollup, owner);
    });

    it('ставит транзакцию в общую очередь с депозитами, в порядке прихода', async () => {
        const first = transactionBytes(0xa1);
        const second = transactionBytes(0xa2, 250);
        const result = await force(first);
        expect(result.transactions).toHaveTransaction({ from: user.address, to: rollup.address, success: true });
        await rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') });
        await force(second);

        const afterFirst = forcedTransactionHash(0n, first);
        const afterDeposit = depositHash(afterFirst, L2_RECIPIENT, toNano('1') - DEPOSIT_FEE);
        const queue = await rollup.getDepositQueue();
        expect(queue.head).toEqual({ count: 3n, hash: forcedTransactionHash(afterDeposit, second) });
        // Порядок — часть обязательства: те же элементы в другом порядке дают другой хеш.
        expect(queue.head.hash).not.toBe(forcedTransactionHash(depositHash(forcedTransactionHash(0n, second), L2_RECIPIENT, toNano('1') - DEPOSIT_FEE), first));
        // Квитанция есть только у депозита: принудительной транзакции возвращать нечего. Запись
        // словаря есть у всех: по ней считаются хеш в точке N и срок заморозки.
        expect(await rollup.getDepositReceipt(1)).toBeNull();
        expect(await rollup.getDepositReceipt(2)).not.toBeNull();
        expect(await rollup.getDepositReceipt(3)).toBeNull();
        expect(await rollup.getQueueItem(1)).toEqual({ hashBefore: 0n, queuedAt: START });
        expect(await rollup.getQueueItem(3)).toEqual({ hashBefore: afterDeposit, queuedAt: START });
    });

    it('элемент очереди — keccak-256 байтов транзакции под меткой: спутать с депозитом нельзя', async () => {
        // Депозит с тем же «содержимым» дал бы другой хеш очереди: у транзакции на месте
        // получателя стоит метка, которой не может быть у 160-битного адреса.
        const bytes = transactionBytes(0xa1);
        await force(bytes);
        const asForced = await queuedHash();
        expect(asForced).toBe(sha256Int(0n, 1n << 255n, forcedTransactionKeccak(bytes)));
        expect(asForced).not.toBe(depositHash(0n, L2_RECIPIENT, forcedTransactionKeccak(bytes)));
        // И это хеш байтов, а не хеш ячейки, в которой они пришли.
        const cellHash = BigInt('0x' + forcedTransactionCell(bytes).hash().toString('hex'));
        expect(asForced).not.toBe(sha256Int(0n, 1n << 255n, cellHash));
    });

    it('хеш в очереди не зависит от нарезки байтов на ячейки', async () => {
        const bytes = transactionBytes(0x33, 200);
        const expected = forcedTransactionHash(0n, bytes);
        const slicings: (number[] | undefined)[] = [
            undefined, // по 127 байт: 127 и 73
            [100, 100],
            [200 - 127, 127],
            [1, 127, 72],
            // Пустые ячейки в начале, середине и конце допустимы.
            [0, 127, 73],
            [127, 0, 73],
            [127, 73, 0],
        ];
        const cells = new Set<string>();
        for (const pieces of slicings) {
            const snapshot = blockchain.snapshot();
            cells.add(forcedTransactionCell(bytes, pieces).hash().toString('hex'));
            expect((await force(bytes, pieces)).transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await queuedHash()).toBe(expected);
            await blockchain.loadFrom(snapshot);
        }
        // Ячейки при этом все разные: одинаковый хеш очереди — не совпадение деревьев.
        expect(cells.size).toBe(slicings.length);
        // Другие байты той же длины — другой хеш.
        const other = Buffer.from(bytes);
        other[199] ^= 1;
        await force(other);
        expect(await queuedHash()).not.toBe(expected);
    });

    it('«змейка» из одной ячейки, из предельного числа и на одну больше: предел ячеек — у контракта', async () => {
        const limit = constants.maxForcedTxCells;
        expect(limit).toBe(MAX_FORCED_TX_CELLS);
        // На ячейку больше предела — отказ, даже если байтов мало (по одному на ячейку).
        await malformed(byteSnake(transactionBytes(1, limit + 1), new Array(limit + 1).fill(1)));
        await malformed(byteSnake(Buffer.alloc(0), new Array(limit + 1).fill(0)));

        const one = transactionBytes(2, 127);
        expect((await force(one)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await queuedHash()).toBe(forcedTransactionHash(0n, one));
        // Ровно предел ячеек, по одному байту в каждой.
        const sparse = transactionBytes(4, limit);
        expect((await force(sparse, new Array(limit).fill(1))).transactions).toHaveTransaction({
            to: rollup.address,
            success: true,
        });
        expect(await queuedHash()).toBe(forcedTransactionHash(forcedTransactionHash(0n, one), sparse));
        expect((await rollup.getDepositQueue()).head.count).toBe(2n);
    });

    it('длина в байтах: ровно предел принят при любой нарезке, на байт больше — отказ', async () => {
        // Предел — тот же, что у программы zkVM (FORCED_TX_MAX_BYTES): транзакцию длиннее она
        // пропустила бы, но за чтение её байтов заплатил бы прувер. Ячеек предел вмещает больше
        // (три по 127 байт — 381 байт), поэтому байты считаются отдельно и точно.
        const limit = constants.maxForcedTxBytes;
        expect(limit).toBe(MAX_FORCED_TX_BYTES);
        expect(limit).toBe(256);
        expect(limit).toBeLessThan(constants.maxForcedTxCells * 127);
        // На байт больше — при каждой нарезке, которая помещается в предел ячеек.
        const tooLong = transactionBytes(5, limit + 1);
        for (const pieces of [[127, 127, 3], [3, 127, 127], [86, 86, 85]]) {
            await malformed(byteSnake(tooLong, pieces));
        }
        // Три полные ячейки: по ячейкам годится, по байтам — нет.
        await malformed(byteSnake(transactionBytes(6, 381)));
        // Упаковщик такого не собирает вовсе.
        expect(() => forcedTransactionCell(tooLong)).toThrow('больше предела');

        const longest = transactionBytes(7, limit);
        let expected = 0n;
        for (const pieces of [[127, 127, 2], [2, 127, 127], [86, 85, 85]]) {
            expect((await force(longest, pieces)).transactions).toHaveTransaction({ to: rollup.address, success: true });
            expected = forcedTransactionHash(expected, longest);
            expect(await queuedHash()).toBe(expected);
        }
    });

    it('пустая транзакция формально допустима: программа её просто пропустит', async () => {
        expect((await forceCell(beginCell().endCell())).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await queuedHash()).toBe(forcedTransactionHash(0n, Buffer.alloc(0)));
    });

    it('нецелое число байт — отказ, в первой ячейке и в любой следующей', async () => {
        await malformed(beginCell().storeUint(1, 7).endCell());
        await malformed(beginCell().storeBuffer(transactionBytes(1, 127)).storeUint(0, 7).endCell());
        await malformed(beginCell().storeBuffer(transactionBytes(1, 10)).storeBit(1).endCell());
        const tail = beginCell().storeBuffer(transactionBytes(2, 10)).storeUint(1, 4).endCell();
        await malformed(beginCell().storeBuffer(transactionBytes(1, 10)).storeRef(tail).endCell());
        const deepTail = beginCell().storeBuffer(transactionBytes(1, 10)).storeRef(
            beginCell().storeBuffer(transactionBytes(2, 10)).storeRef(tail).endCell(),
        );
        await malformed(deepTail.endCell());
    });

    it('две ссылки у ячейки — отказ: продолжение было бы неоднозначным', async () => {
        const leaf = () => beginCell().storeBuffer(transactionBytes(9, 5)).endCell();
        await malformed(beginCell().storeBuffer(transactionBytes(1, 10)).storeRef(leaf()).storeRef(leaf()).endCell());
        await malformed(beginCell().storeRef(leaf()).storeRef(leaf()).storeRef(leaf()).storeRef(leaf()).endCell());
        const forked = beginCell().storeBuffer(transactionBytes(2, 10)).storeRef(leaf()).storeRef(leaf()).endCell();
        await malformed(beginCell().storeBuffer(transactionBytes(1, 10)).storeRef(forked).endCell());
        // Та же цепочка без лишней ссылки принимается.
        const chain = beginCell().storeBuffer(transactionBytes(1, 10)).storeRef(
            beginCell().storeBuffer(transactionBytes(2, 10)).storeRef(leaf()).endCell(),
        );
        expect((await forceCell(chain.endCell())).transactions).toHaveTransaction({ to: rollup.address, success: true });
    });

    it('экзотическая ячейка — отказ: байты обязаны лежать в самом сообщении', async () => {
        // Ссылка на библиотеку: обычное чтение (CTOS) молча подставило бы содержимое библиотеки.
        // Проверка формы прошла бы, а байты пришли бы не из сообщения L1 — секвенсор, собирающий
        // свидетель по сообщениям, их не достал бы. Библиотека зарегистрирована: с обычным
        // чтением транзакция была бы ПРИНЯТА, отказ даёт именно проверка на экзотику.
        const content = forcedTransactionCell(transactionBytes(0xa1));
        const reference = libraryReferenceTo(content);
        expect(reference.isExotic).toBe(true);
        await malformed(reference);
        // То же в середине и в хвосте «змейки».
        await malformed(beginCell().storeBuffer(transactionBytes(1, 10)).storeRef(reference).endCell());
        await malformed(
            beginCell()
                .storeBuffer(transactionBytes(1, 10))
                .storeRef(beginCell().storeBuffer(transactionBytes(2, 10)).storeRef(reference).endCell())
                .endCell(),
        );
        // Сама библиотека как обычная ячейка — годится.
        expect((await forceCell(content)).transactions).toHaveTransaction({ to: rollup.address, success: true });
    });

    it('секвенсор обрабатывает её наравне с депозитом — ближайшим батчем', async () => {
        const bytes = transactionBytes(0xa1);
        await force(bytes);
        const queued = forcedTransactionHash(0n, bytes);
        await submit(sha256Int(2n), 1);
        const queue = await rollup.getDepositQueue();
        expect(queue.processed).toEqual({ count: 1n, hash: queued });
        expect((await rollup.getEscapeState()).oldestPendingAt).toBe(0);
    });

    it('берёт плату и не принимает транзакцию без неё', async () => {
        const { forceTransactionFee } = await rollup.getQueueFees();
        expect(forceTransactionFee).toBe(toNano('0.05'));
        const cheap = await forceCell(forcedTransactionCell(transactionBytes(1)), forceTransactionFee - 1n);
        expect(cheap.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.notEnoughValue,
        });
        expect((await rollup.getDepositQueue()).head.count).toBe(0n);
        expect((await forceCell(forcedTransactionCell(transactionBytes(1)), forceTransactionFee)).transactions).toHaveTransaction({
            to: rollup.address,
            success: true,
        });
    });

    it('газ постановки в очередь укладывается в запас шага — на одной ячейке и на предельной длине', async () => {
        // Запас — у контракта (get-метод queueBudgets): из него считается плата при дорогом газе.
        // Замер на словаре очереди, заполненном до предела, — tests/RollupQueue.spec.ts.
        const { forceTransactionStepGas } = await rollup.getQueueBudgets();
        for (const length of [122, constants.maxForcedTxBytes]) {
            const result = await force(transactionBytes(1, length));
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            const gasUsed = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
            expect(gasUsed).toBeLessThanOrEqual(forceTransactionStepGas);
        }
    });

    it('цензура ведёт к заморозке: необработанная транзакция запускает срок', async () => {
        // Секвенсор жив и выпускает батчи, но транзакцию пользователя не берёт. Пользователь
        // ставит её в очередь сам — и дальше секвенсор либо обработает очередь, либо rollup
        // заморозят.
        await force(transactionBytes(0xa1));
        expect((await rollup.getEscapeState()).oldestPendingAt).toBe(START);
        blockchain.now = START + 10;
        await submit(sha256Int(2n), 0); // батч принят, но очередь он не тронул
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
        expect((await rollup.getEscapeState()).oldestPendingAt).toBe(START);

        blockchain.now = START + TIMEOUT;
        expect((await rollup.sendActivateEscapeHatch(user.getSender(), toNano('0.05'))).transactions).toHaveTransaction(
            { to: rollup.address, success: false, exitCode: RollupErrors.escapeNotDue },
        );
        blockchain.now = START + TIMEOUT + 1;
        expect((await rollup.sendActivateEscapeHatch(user.getSender(), toNano('0.05'))).transactions).toHaveTransaction(
            { to: rollup.address, success: true },
        );
        expect((await rollup.getEscapeState()).frozen).toBe(true);
    });

    it('после заморозки в очередь ничего не ставится, а «возврата» у транзакции нет', async () => {
        await force(transactionBytes(0xa1));
        blockchain.now = START + TIMEOUT + 1;
        await rollup.sendActivateEscapeHatch(user.getSender(), toNano('0.05'));

        expect((await force(transactionBytes(0xa2))).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.rollupFrozen,
        });
        // Запись в словаре у транзакции есть, квитанции нет: возвращать нечего, и отказ записи
        // не удаляет.
        const refund = await rollup.sendCancelDeposit(user.getSender(), { depositIndex: 1, value: toNano('0.05') });
        expect(refund.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.noSuchDeposit,
        });
        expect(refund.transactions).not.toHaveTransaction({ from: rollup.address, to: user.address, inMessageBounced: false });
        expect(await rollup.getQueueItem(1)).not.toBeNull();
    });
});
