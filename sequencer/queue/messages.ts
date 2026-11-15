import { Cell } from '@ton/core';
import { RollupOpcodes } from '../../wrappers/Rollup';
import { depositHash, forcedTransactionHash } from '../../wrappers/rollupMath';

// Разбор входящих сообщений контракта, ставящих элемент в очередь L1 (DepositTon и
// ForceTransaction в contracts/rollup/messages.tolk), и шаг хеша очереди от элемента.

/** Что сообщение ставит в очередь: депозит (сумму знает только контракт) или байты транзакции. */
export type QueueMessage =
    { kind: 'deposit'; l2Recipient: string } | { kind: 'forced'; bytes: Buffer } | { kind: 'other' };

/** Пределы «змейки» принудительной транзакции — get-метод queueLimits контракта. */
export type SnakeLimits = { maxForcedTxCells: number; maxForcedTxBytes: number };

/**
 * Байты «змейки» — как их читает контракт (byteParts в contracts/rollup/bytes.tolk): обычные
 * ячейки, в каждой целое число байт и не больше одной ссылки, не больше maxForcedTxCells ячеек и
 * maxForcedTxBytes байт. Иное контракт отвергает, поэтому успешная транзакция с такой ячейкой —
 * признак, что сервис читает сообщения не так, как контракт: исключение.
 */
export function snakeBytes(root: Cell, limits: SnakeLimits): Buffer {
    const parts: Buffer[] = [];
    let current: Cell | null = root;
    while (current) {
        if (current.isExotic) throw new Error('«змейка» принудительной транзакции: экзотическая ячейка');
        if (current.bits.length % 8 !== 0)
            throw new Error('«змейка» принудительной транзакции: не целое число байт в ячейке');
        if (current.refs.length > 1) throw new Error('«змейка» принудительной транзакции: больше одной ссылки');
        const slice = current.beginParse();
        parts.push(slice.loadBuffer(current.bits.length / 8));
        if (parts.length > limits.maxForcedTxCells)
            throw new Error('«змейка» принудительной транзакции длиннее предела в ячейках');
        current = current.refs[0] ?? null;
    }
    const bytes = Buffer.concat(parts);
    if (bytes.length > limits.maxForcedTxBytes) throw new Error('принудительная транзакция длиннее предела в байтах');
    return bytes;
}

const hex40 = (value: bigint) => '0x' + value.toString(16).padStart(40, '0');

/** Что ставит в очередь сообщение с этим телом. Тело чужого вида — 'other'. */
export function parseQueueMessage(body: Cell, limits: SnakeLimits): QueueMessage {
    const slice = body.beginParse();
    if (slice.remainingBits < 32) return { kind: 'other' };
    const op = slice.loadUint(32);
    if (op === RollupOpcodes.depositTon) {
        slice.loadUintBig(64); // queryId
        return { kind: 'deposit', l2Recipient: hex40(slice.loadUintBig(160)) };
    }
    if (op === RollupOpcodes.forceTransaction) {
        slice.loadUintBig(64); // queryId
        return { kind: 'forced', bytes: snakeBytes(slice.loadRef(), limits) };
    }
    return { kind: 'other' };
}

/** Шаг накопительного хеша очереди — формулы контракта (wrappers/rollupMath.ts). */
export function queueStep(
    previous: bigint,
    item: { kind: 'deposit'; l2Recipient: string; amount: bigint } | { kind: 'forced'; bytes: Buffer },
): bigint {
    return item.kind === 'deposit'
        ? depositHash(previous, BigInt(item.l2Recipient), item.amount)
        : forcedTransactionHash(previous, item.bytes);
}
