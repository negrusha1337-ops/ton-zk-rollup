import { Address, Cell, Transaction } from '@ton/core';

/** Находит транзакцию на адресе контракта и возвращает её фазу вычислений. */
export function computePhaseOf(transactions: Transaction[], contract: Address) {
    const tx = transactions.find(
        (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest.equals(contract),
    );
    if (!tx) {
        throw new Error(`Нет транзакции на адресе ${contract.toString()}`);
    }
    if (tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm') {
        throw new Error('Фаза вычислений была пропущена (compute phase skipped)');
    }
    return tx.description.computePhase;
}

/** Суммарный размер дерева ячеек: число уникальных ячеек и бит данных. */
export function cellStats(root: Cell): { cells: number; bits: number } {
    const seen = new Set<string>();
    let bits = 0;
    const stack: Cell[] = [root];
    while (stack.length > 0) {
        const cell = stack.pop()!;
        const hash = cell.hash().toString('hex');
        if (seen.has(hash)) continue;
        seen.add(hash);
        bits += cell.bits.length;
        stack.push(...cell.refs);
    }
    return { cells: seen.size, bits };
}
