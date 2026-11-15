import { createHash } from 'crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { beginCell, Cell } from '@ton/core';

// Арифметика протокола rollup'а (версия 2, PROTOCOL-V2.md) вне блокчейна. Должна совпадать с
// contracts/rollup/logic.tolk и программой zkVM.

export const WITHDRAWAL_TREE_DEPTH = 32;
const MASK_253 = (1n << 253n) - 1n;

const bytes32 = (value: bigint) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
export const sha256Int = (...values: bigint[]) =>
    BigInt(
        '0x' +
            createHash('sha256')
                .update(Buffer.concat(values.map(bytes32)))
                .digest('hex'),
    );

export type BatchPublicValues = {
    /** Идентификатор rollup'а из хранилища контракта. */
    chainId: bigint;
    prevStateRoot: bigint;
    newStateRoot: bigint;
    batchHash: bigint;
    /** Корень дерева выводов до батча — из хранилища контракта. */
    prevWithdrawalsRoot: bigint;
    withdrawalsRoot: bigint;
    prevDepositHash: bigint;
    /** Хеш очереди L1 в точке, до которой батч её обработал, — из хранилища контракта. */
    newDepositHash: bigint;
    /** Число листьев дерева выводов до батча — из хранилища контракта. */
    prevWithdrawalsCount: bigint;
    withdrawalsCount: bigint;
    /** Время блока L2, секунды. */
    blockTimestamp: bigint;
};

/** Публичные значения батча по порядку: одиннадцать 32-байтовых слов (352 байта). */
export const batchPublicValueWords = (v: BatchPublicValues): bigint[] => [
    v.chainId,
    v.prevStateRoot,
    v.newStateRoot,
    v.batchHash,
    v.prevWithdrawalsRoot,
    v.withdrawalsRoot,
    v.prevDepositHash,
    v.newDepositHash,
    v.prevWithdrawalsCount,
    v.withdrawalsCount,
    v.blockTimestamp,
];

/** Первый публичный вход пруфа батча: sha256 одиннадцати значений, обрезанный до 253 бит. */
export function batchDigest(v: BatchPublicValues): bigint {
    return sha256Int(...batchPublicValueWords(v)) & MASK_253;
}

/** Накопительный хеш очереди депозитов после очередного депозита. */
export const depositHash = (previous: bigint, l2Recipient: bigint, amount: bigint) =>
    sha256Int(previous, l2Recipient, amount);

export type WithdrawalLeaf = { leafIndex: number; recipientHash: bigint; amount: bigint };

export const withdrawalLeafHash = (leaf: WithdrawalLeaf) =>
    sha256Int(BigInt(leaf.leafIndex), leaf.recipientHash, leaf.amount);

/** Хеши пустых поддеревьев: пустой лист — 0, узел — sha256(левый ‖ правый). */
const emptySubtrees = (() => {
    const hashes = [0n];
    for (let level = 0; level < WITHDRAWAL_TREE_DEPTH; level++) hashes.push(sha256Int(hashes[level], hashes[level]));
    return hashes;
})();

/** Разреженное дерево выводов: корень и доказательство для каждого листа. */
export function withdrawalTree(leaves: WithdrawalLeaf[]) {
    let level = new Map<number, bigint>(leaves.map((leaf) => [leaf.leafIndex, withdrawalLeafHash(leaf)]));
    const levels: Map<number, bigint>[] = [];
    for (let depth = 0; depth < WITHDRAWAL_TREE_DEPTH; depth++) {
        levels.push(level);
        const next = new Map<number, bigint>();
        for (const index of new Set([...level.keys()].map((i) => Math.floor(i / 2)))) {
            const left = level.get(index * 2) ?? emptySubtrees[depth];
            const right = level.get(index * 2 + 1) ?? emptySubtrees[depth];
            next.set(index, sha256Int(left, right));
        }
        level = next;
    }
    // Корень дерева без листьев контракт и программа zkVM хранят как ноль, а не как хеш
    // пустого дерева (withdrawals_root в zkvm/lib).
    const root = leaves.length === 0 ? 0n : level.get(0)!;
    const proofFor = (leafIndex: number): bigint[] =>
        levels.map((nodes, depth) => {
            // Сосед — узел с перевёрнутым младшим битом. Без побитовых операций: в JS они
            // 32-битные со знаком и для листьев с номером от 2³¹ дали бы неверный индекс.
            const index = Math.floor(leafIndex / 2 ** depth);
            return nodes.get(index % 2 === 0 ? index + 1 : index - 1) ?? emptySubtrees[depth];
        });
    return { root, proofFor };
}

// --- дерево выводов с дозаписью: фронтир и счётчик (PROTOCOL-V2.md, раздел 4 и правка 0.4) ---
//
// Программа zkVM не пересчитывает дерево целиком: ей хватает «фронтира» — по одному хешу на
// уровень — и числа листьев. frontier[h] — корень полного левого поддерева высоты h на
// единичном бите h счётчика; на нулевых битах — ноль (канонический вид).

/** Больше листьев в дереве не бывает: переход счётчика к 2^32 — отказ. */
export const MAX_WITHDRAWALS = 2n ** BigInt(WITHDRAWAL_TREE_DEPTH) - 1n;

/** Фронтир пустого дерева. */
export const emptyWithdrawalFrontier = (): bigint[] => new Array<bigint>(WITHDRAWAL_TREE_DEPTH).fill(0n);

/**
 * Корень дерева по фронтиру и счётчику. При нуле листьев — ноль, а не хеш пустого дерева
 * (как у withdrawalTree и у контракта).
 */
export function withdrawalFrontierRoot(frontier: bigint[], count: bigint): bigint {
    if (frontier.length !== WITHDRAWAL_TREE_DEPTH) throw new Error('withdrawalFrontierRoot: во фронтире не 32 хеша');
    if (count < 0n || count > MAX_WITHDRAWALS) throw new Error('withdrawalFrontierRoot: счётчик вне дерева');
    if (count === 0n) return 0n;
    let node = 0n;
    for (let height = 0; height < WITHDRAWAL_TREE_DEPTH; height++) {
        node =
            ((count >> BigInt(height)) & 1n) === 1n
                ? sha256Int(frontier[height], node)
                : sha256Int(node, emptySubtrees[height]);
    }
    return node;
}

/**
 * Дозапись листа (хеш листа — withdrawalLeafHash с номером, равным прежнему счётчику).
 * Возвращает новые фронтир и счётчик; исходный фронтир не меняется.
 */
export function appendWithdrawalLeaf(
    frontier: bigint[],
    count: bigint,
    leafHash: bigint,
): { frontier: bigint[]; count: bigint } {
    if (frontier.length !== WITHDRAWAL_TREE_DEPTH) throw new Error('appendWithdrawalLeaf: во фронтире не 32 хеша');
    if (count < 0n || count >= MAX_WITHDRAWALS) throw new Error('appendWithdrawalLeaf: дерево выводов заполнено');
    const next = [...frontier];
    let node = leafHash;
    for (let height = 0; height < WITHDRAWAL_TREE_DEPTH; height++) {
        if (((count >> BigInt(height)) & 1n) === 0n) {
            next[height] = node;
            break;
        }
        node = sha256Int(next[height], node);
        next[height] = 0n;
    }
    return { frontier: next, count: count + 1n };
}

/** Доказательство как цепочка ячеек: по три хеша на ячейку, продолжение по ссылке. */
export function merkleProofCell(siblings: bigint[]): Cell {
    let tail: Cell | null = null;
    const chunkCount = Math.ceil(siblings.length / 3);
    for (let chunk = chunkCount - 1; chunk >= 0; chunk--) {
        const builder = beginCell();
        for (const sibling of siblings.slice(chunk * 3, chunk * 3 + 3)) builder.storeUint(sibling, 256);
        if (tail) builder.storeRef(tail);
        tail = builder.endCell();
    }
    if (!tail) throw new Error('merkleProofCell: пустое доказательство');
    return tail;
}

// --- данные батча (data availability, DA.md) ---

/** Байт данных в одной ячейке порции: 127 байт = 1016 бит из 1023. */
export const DATA_CELL_BYTES = 127;
/** Ссылок на ячейку в дереве порции. */
export const DATA_CELL_REFS = 4;
/** Предел порции: с запасом помещается во внешнее сообщение (65 535 байт вместе с обвязкой). */
export const MAX_DATA_CHUNK_BYTES = 60_000;

/**
 * Порция данных батча как дерево ячеек. Данные режутся на куски по DATA_CELL_BYTES байт;
 * кусок i лежит в ячейке i, а её ссылки — ячейки 4i+1 … 4i+4 (раскладка «куча», как у
 * двоичной кучи, только с четырьмя потомками). Корень — ячейка 0. Пустая порция — одна
 * пустая ячейка.
 *
 * Раскладка — часть протокола: программа zkVM (zkvm/lib, `data_chunk_hash`) считает хеш
 * именно такого дерева. Дерево, а не цепочка, потому что глубина цепочки на 60 КБ — под
 * 500 ячеек: это у самого лимита сети (512), и эмулятор Sandbox на такой глубине падает.
 */
export function dataChunkCell(data: Buffer): Cell {
    if (data.length > MAX_DATA_CHUNK_BYTES) {
        throw new Error(`dataChunkCell: порция ${data.length} байт больше ${MAX_DATA_CHUNK_BYTES}`);
    }
    const cellCount = Math.max(1, Math.ceil(data.length / DATA_CELL_BYTES));
    const cells: Cell[] = new Array(cellCount);
    for (let index = cellCount - 1; index >= 0; index--) {
        const builder = beginCell().storeBuffer(data.subarray(index * DATA_CELL_BYTES, (index + 1) * DATA_CELL_BYTES));
        for (let child = DATA_CELL_REFS * index + 1; child <= DATA_CELL_REFS * index + DATA_CELL_REFS; child++) {
            if (child < cellCount) builder.storeRef(cells[child]);
        }
        cells[index] = builder.endCell();
    }
    return cells[0];
}

const cellHashInt = (cell: Cell) => BigInt('0x' + cell.hash().toString('hex'));

/** Шаг накопительного хеша данных батча — как dataHashStep в контракте. */
export const dataHashStep = (previous: bigint, chunk: Cell) => sha256Int(previous, cellHashInt(chunk));

/** Хеш данных батча: порции в порядке публикации; 0, если данных нет. */
export const batchDataHash = (chunks: Cell[]) => chunks.reduce(dataHashStep, 0n);

// --- принудительные транзакции L2 ---

/** Метка принудительной транзакции в хеше очереди — как FORCED_TRANSACTION_MARKER в контракте. */
export const FORCED_TRANSACTION_MARKER = 1n << 255n;
/** Предел длины «змейки» в ячейках — как MAX_FORCED_TX_CELLS в контракте (get-метод queueLimits). */
export const MAX_FORCED_TX_CELLS = 3;
/**
 * Предел длины принудительной транзакции в байтах — как MAX_FORCED_TX_BYTES в контракте
 * (get-метод queueLimits) и FORCED_TX_MAX_BYTES в программе zkVM. Три ячейки вмещают больше
 * (381 байт): предел в байтах — отдельный и точный.
 */
export const MAX_FORCED_TX_BYTES = 256;

/**
 * Байтовая строка «змейкой» ячеек: куски заданной длины по порядку, каждый следующий — по
 * единственной ссылке предыдущего. `pieces` — длины кусков (сумма равна длине строки); без
 * него строка режется по DATA_CELL_BYTES байт. Пустая строка — одна пустая ячейка.
 */
export function byteSnake(data: Buffer, pieces?: number[]): Cell {
    const lengths = pieces ?? [];
    if (!pieces) {
        for (let left = data.length; left > 0; left -= DATA_CELL_BYTES) lengths.push(Math.min(left, DATA_CELL_BYTES));
        if (lengths.length === 0) lengths.push(0);
    }
    if (lengths.reduce((sum, length) => sum + length, 0) !== data.length) {
        throw new Error('byteSnake: длины кусков не складываются в длину строки');
    }
    if (lengths.some((length) => length < 0 || length > DATA_CELL_BYTES)) {
        throw new Error(`byteSnake: кусок не помещается в ячейку (${DATA_CELL_BYTES} байт)`);
    }
    let tail: Cell | null = null;
    let end = data.length;
    for (let index = lengths.length - 1; index >= 0; index--) {
        const builder = beginCell().storeBuffer(data.subarray(end - lengths[index], end));
        if (tail) builder.storeRef(tail);
        tail = builder.endCell();
        end -= lengths[index];
    }
    return tail!;
}

/**
 * Принудительная транзакция как «змейка»: байты подписанной транзакции EVM (EIP-2718), не
 * больше MAX_FORCED_TX_BYTES байт и MAX_FORCED_TX_CELLS ячеек. Нарезка на хеш в очереди не
 * влияет. То, что контракт отвергнет, не собирает (для тестов отказа — byteSnake).
 */
export function forcedTransactionCell(transaction: Buffer, pieces?: number[]): Cell {
    if (transaction.length > MAX_FORCED_TX_BYTES) {
        throw new Error(`forcedTransactionCell: ${transaction.length} байт больше предела ${MAX_FORCED_TX_BYTES}`);
    }
    const cellCount = pieces?.length ?? Math.max(1, Math.ceil(transaction.length / DATA_CELL_BYTES));
    if (cellCount > MAX_FORCED_TX_CELLS) {
        throw new Error(`forcedTransactionCell: ${cellCount} ячеек больше предела ${MAX_FORCED_TX_CELLS}`);
    }
    return byteSnake(transaction, pieces);
}

/** keccak-256 байтов транзакции числом: для транзакции EVM это её хеш. */
export const forcedTransactionKeccak = (transaction: Buffer) =>
    BigInt('0x' + Buffer.from(keccak_256(transaction)).toString('hex'));

/**
 * Накопительный хеш очереди L1→L2 после принудительной транзакции — как в контракте:
 * sha256(прежний ‖ метка ‖ keccak256(байты транзакции)).
 */
export const forcedTransactionHash = (previous: bigint, transaction: Buffer) =>
    sha256Int(previous, FORCED_TRANSACTION_MARKER, forcedTransactionKeccak(transaction));
