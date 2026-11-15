import { keccak_256 } from '@noble/hashes/sha3';
import { createHash } from 'crypto';
import {
    appendWithdrawalLeaf,
    batchDigest,
    batchPublicValueWords,
    byteSnake,
    emptyWithdrawalFrontier,
    FORCED_TRANSACTION_MARKER,
    forcedTransactionCell,
    forcedTransactionHash,
    MAX_FORCED_TX_BYTES,
    MAX_FORCED_TX_CELLS,
    MAX_WITHDRAWALS,
    sha256Int,
    WITHDRAWAL_TREE_DEPTH,
    withdrawalFrontierRoot,
    WithdrawalLeaf,
    withdrawalLeafHash,
    withdrawalTree,
} from '../wrappers/rollupMath';

// Арифметика протокола v2 вне контракта (wrappers/rollupMath.ts): то, чему обязаны следовать
// и контракт, и программа zkVM. Сверка с контрактом — в наборах на двойнике (Rollup, RollupQueue,
// RollupForced); здесь — внутренняя согласованность и независимые пересчёты.
describe('Арифметика протокола v2', () => {
    describe('дерево выводов: фронтир и счётчик против полного пересчёта', () => {
        const leaf = (index: number): WithdrawalLeaf => ({
            leafIndex: index,
            recipientHash: sha256Int(1000n + BigInt(index)),
            amount: 1_000_000n + BigInt(index),
        });
        /** Фронтир и счётчик после дозаписи первых `count` листьев по одному. */
        const frontierOf = (count: number) => {
            let state = { frontier: emptyWithdrawalFrontier(), count: 0n };
            for (let index = 0; index < count; index++) {
                state = appendWithdrawalLeaf(state.frontier, state.count, withdrawalLeafHash(leaf(index)));
            }
            return state;
        };
        const fullRoot = (count: number) => withdrawalTree(Array.from({ length: count }, (_, index) => leaf(index))).root;
        // 0, 1, 2, 3, степени двойки и их соседи.
        const counts = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257];

        it.each(counts)('корень по фронтиру равен корню полного дерева на %i листьях', (count) => {
            const state = frontierOf(count);
            expect(state.count).toBe(BigInt(count));
            expect(withdrawalFrontierRoot(state.frontier, state.count)).toBe(fullRoot(count));
        });

        it('пустое дерево: корень — ноль, а не хеш пустого дерева', () => {
            expect(withdrawalFrontierRoot(emptyWithdrawalFrontier(), 0n)).toBe(0n);
            expect(fullRoot(0)).toBe(0n);
            expect(fullRoot(1)).not.toBe(0n);
        });

        it('фронтир канонический: на нулевых битах счётчика — нули, на единичных — корни полных поддеревьев', () => {
            for (const count of [1, 2, 3, 5, 8, 13, 64, 100]) {
                const { frontier } = frontierOf(count);
                for (let height = 0; height < WITHDRAWAL_TREE_DEPTH; height++) {
                    const bit = (BigInt(count) >> BigInt(height)) & 1n;
                    if (bit === 0n) expect(frontier[height]).toBe(0n);
                    else expect(frontier[height]).not.toBe(0n);
                }
            }
            // Счётчик 4 = 100b: единственный элемент — корень поддерева из первых четырёх листьев.
            const four = frontierOf(4);
            const leaves = [0, 1, 2, 3].map((index) => withdrawalLeafHash(leaf(index)));
            expect(four.frontier[2]).toBe(sha256Int(sha256Int(leaves[0], leaves[1]), sha256Int(leaves[2], leaves[3])));
        });

        it('дозапись не меняет исходный фронтир и зависит от порядка листьев', () => {
            const before = frontierOf(3);
            const snapshot = [...before.frontier];
            const next = appendWithdrawalLeaf(before.frontier, before.count, withdrawalLeafHash(leaf(3)));
            expect(before.frontier).toEqual(snapshot);
            expect(next.count).toBe(4n);
            const swapped = appendWithdrawalLeaf(
                appendWithdrawalLeaf(emptyWithdrawalFrontier(), 0n, withdrawalLeafHash(leaf(1))).frontier,
                1n,
                withdrawalLeafHash(leaf(0)),
            );
            expect(withdrawalFrontierRoot(swapped.frontier, 2n)).not.toBe(fullRoot(2));
        });

        it('один корень счётчик не связывает: тот же корень получается с другим счётчиком', () => {
            // Атака из раздела 4 PROTOCOL-V2.md, из-за которой счётчик входит в публичные значения:
            // при настоящем count = 2 вход count' = 2^i с frontier'[i] = «корень левого поддерева»
            // даёт тот же корень дерева.
            const honest = frontierOf(2);
            const root = withdrawalFrontierRoot(honest.frontier, honest.count);
            const forgedHeight = 5;
            // Корень поддерева высоты 5, в котором заняты только два первых листа.
            let subtree = honest.frontier[1];
            let empty = sha256Int(0n, 0n);
            for (let height = 1; height < forgedHeight; height++) {
                subtree = sha256Int(subtree, empty);
                empty = sha256Int(empty, empty);
            }
            const forged = emptyWithdrawalFrontier();
            forged[forgedHeight] = subtree;
            expect(withdrawalFrontierRoot(forged, 1n << BigInt(forgedHeight))).toBe(root);
            // Публичный вход при этом другой: счётчик — отдельное слово.
            const values = {
                chainId: 1n,
                prevStateRoot: 2n,
                newStateRoot: 3n,
                batchHash: 4n,
                prevWithdrawalsRoot: 0n,
                withdrawalsRoot: root,
                prevDepositHash: 0n,
                newDepositHash: 0n,
                prevWithdrawalsCount: 0n,
                blockTimestamp: 5n,
            };
            expect(batchDigest({ ...values, withdrawalsCount: 2n })).not.toBe(
                batchDigest({ ...values, withdrawalsCount: 1n << BigInt(forgedHeight) }),
            );
        });

        it('дерево не переполняется: дозапись при счётчике 2^32 − 1 отвергается', () => {
            expect(MAX_WITHDRAWALS).toBe((1n << 32n) - 1n);
            const full = emptyWithdrawalFrontier().map((_, height) => sha256Int(BigInt(height)));
            expect(() => appendWithdrawalLeaf(full, MAX_WITHDRAWALS, 1n)).toThrow('заполнено');
            // Последний допустимый лист: счётчик 2^32 − 2 → 2^32 − 1.
            expect(appendWithdrawalLeaf(full, MAX_WITHDRAWALS - 1n, 1n).count).toBe(MAX_WITHDRAWALS);
            expect(() => withdrawalFrontierRoot(full, MAX_WITHDRAWALS + 1n)).toThrow('вне дерева');
        });
    });

    describe('публичные значения батча', () => {
        const values = {
            chainId: 0x11n,
            prevStateRoot: 0x22n,
            newStateRoot: 0x33n,
            batchHash: 0x44n,
            prevWithdrawalsRoot: 0x55n,
            withdrawalsRoot: 0x66n,
            prevDepositHash: 0x77n,
            newDepositHash: 0x88n,
            prevWithdrawalsCount: 0x99n,
            withdrawalsCount: 0xaan,
            blockTimestamp: 0xbbn,
        };

        it('дайджест — sha256 от 352 байт (11 слов по 32 байта), обрезанный до 253 бит', () => {
            const words = batchPublicValueWords(values);
            expect(words).toHaveLength(11);
            const bytes = Buffer.concat(words.map((word) => Buffer.from(word.toString(16).padStart(64, '0'), 'hex')));
            expect(bytes).toHaveLength(352);
            // Последний байт каждого слова — его значение: порядок слов виден прямо в байтах.
            expect([...Array(11).keys()].map((index) => bytes[index * 32 + 31])).toEqual([
                0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
            ]);
            const full = BigInt('0x' + createHash('sha256').update(bytes).digest('hex'));
            expect(batchDigest(values)).toBe(full & ((1n << 253n) - 1n));
        });

        it('каждое из одиннадцати слов меняет дайджест', () => {
            const base = batchDigest(values);
            for (const field of Object.keys(values) as (keyof typeof values)[]) {
                expect(batchDigest({ ...values, [field]: values[field] + 1n })).not.toBe(base);
            }
        });
    });

    describe('принудительная транзакция: «змейка» и хеш элемента очереди', () => {
        const bytes = Buffer.from(Array.from({ length: 400 }, (_, index) => (index * 37 + 11) & 255));

        it('элемент очереди — sha256(прежний ‖ метка ‖ keccak256(байты))', () => {
            const previous = sha256Int(42n);
            const keccak = BigInt('0x' + Buffer.from(keccak_256(bytes)).toString('hex'));
            expect(FORCED_TRANSACTION_MARKER).toBe(1n << 255n);
            expect(forcedTransactionHash(previous, bytes)).toBe(sha256Int(previous, 1n << 255n, keccak));
        });

        it('«змейка» хранит байты по порядку, по одной ссылке на ячейку, при любой нарезке', () => {
            const read = (root: ReturnType<typeof byteSnake>) => {
                const parts: Buffer[] = [];
                let cells = 0;
                for (let cell: typeof root | undefined = root; cell; cell = cell.refs[0]) {
                    expect(cell.refs.length).toBeLessThanOrEqual(1);
                    expect(cell.bits.length % 8).toBe(0);
                    parts.push(cell.beginParse().loadBuffer(cell.bits.length / 8));
                    cells++;
                }
                return { bytes: Buffer.concat(parts), cells };
            };
            expect(read(forcedTransactionCell(bytes))).toEqual({ bytes, cells: 4 });
            expect(read(forcedTransactionCell(bytes, [1, 127, 0, 100, 172 - 100, 100]))).toEqual({ bytes, cells: 6 });
            expect(read(forcedTransactionCell(Buffer.alloc(0)))).toEqual({ bytes: Buffer.alloc(0), cells: 1 });
            expect(read(forcedTransactionCell(Buffer.alloc(127, 1)))).toEqual({ bytes: Buffer.alloc(127, 1), cells: 1 });
            expect(read(forcedTransactionCell(Buffer.alloc(128, 1)))).toEqual({ bytes: Buffer.alloc(128, 1), cells: 2 });
        });

        it('упаковщик не собирает то, что контракт отвергнет', () => {
            expect(MAX_FORCED_TX_BYTES).toBe(MAX_FORCED_TX_CELLS * 127);
            expect(() => forcedTransactionCell(Buffer.alloc(MAX_FORCED_TX_BYTES))).not.toThrow();
            expect(() => forcedTransactionCell(Buffer.alloc(MAX_FORCED_TX_BYTES + 1))).toThrow('больше предела');
            expect(() => forcedTransactionCell(Buffer.alloc(65), new Array(65).fill(1))).toThrow('больше предела');
            expect(() => byteSnake(Buffer.alloc(10), [4, 5])).toThrow('не складываются');
            expect(() => byteSnake(Buffer.alloc(128), [128])).toThrow('не помещается');
        });
    });
});
