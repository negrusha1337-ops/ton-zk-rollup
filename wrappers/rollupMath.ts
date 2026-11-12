import { createHash } from 'crypto';
import { beginCell, Cell } from '@ton/core';

// Арифметика протокола rollup'а вне блокчейна. Должна совпадать с
// contracts/rollup/logic.tolk и zk/rollup-math.mjs.

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
    prevStateRoot: bigint;
    newStateRoot: bigint;
    batchHash: bigint;
    withdrawalsRoot: bigint;
    prevDepositHash: bigint;
    newDepositHash: bigint;
};

/** Первый публичный вход пруфа батча: sha256 шести значений, обрезанный до 253 бит. */
export function batchDigest(v: BatchPublicValues): bigint {
    return (
        sha256Int(
            v.prevStateRoot,
            v.newStateRoot,
            v.batchHash,
            v.withdrawalsRoot,
            v.prevDepositHash,
            v.newDepositHash,
        ) & MASK_253
    );
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
    const root = level.get(0) ?? emptySubtrees[WITHDRAWAL_TREE_DEPTH];
    const proofFor = (leafIndex: number): bigint[] =>
        levels.map((nodes, depth) => nodes.get(Math.floor(leafIndex / 2 ** depth) ^ 1) ?? emptySubtrees[depth]);
    return { root, proofFor };
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
