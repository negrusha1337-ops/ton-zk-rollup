import { Cell } from '@ton/core';

// Очередь L1 глазами сборщика блоков. Контракт хранит про элемент только хеш цепочки очереди до
// него и время постановки (словарь queueItems), а у депозита ещё квитанцию; САМИ элементы —
// получатель депозита и байты принудительной транзакции — есть только во входящих сообщениях
// контракта. Источник очереди берёт элемент из сообщения и принимает его, только если шаг хеша
// от него даёт хеш цепочки контракта; расхождение — остановка, а не пропуск.

/** Депозит: кому на L2 и сколько нанотонов (= gwei) зачислить. Адрес — 0x и 40 цифр, строчными. */
export type DepositItem = { kind: 'deposit'; number: number; l2Recipient: string; amount: bigint };
/** Принудительная транзакция: байты как в очереди (их keccak входит в хеш очереди). */
export type ForcedItem = { kind: 'forced'; number: number; bytes: Buffer };
export type QueueItem = DepositItem | ForcedItem;

/** Отметка очереди: номер последнего учтённого элемента и хеш цепочки после него. */
export type QueueMark = { count: number; hash: bigint };

/** Где в истории сообщений контракта лежит сообщение, поставившее элемент `number`. */
export type MessageCursor = { lt: string; hash: string; number: number };

/** Элемент очереди и сообщение, из которого он восстановлен. */
export type QueuedItem = { item: QueueItem; message: MessageCursor };

/** Окно очереди: элементы (from, from + items.length] по порядку, каждый сверен с контрактом. */
export type QueueWindow = {
    /** Отметки контракта: поставлено и обработано принятыми батчами. */
    head: QueueMark;
    processed: QueueMark;
    from: QueueMark;
    items: QueuedItem[];
};

export interface QueueSource {
    /**
     * Не больше `max` элементов после отметки `from`. `cursor` — сообщение элемента `from.count`;
     * null — счёт с начала истории контракта (первые from.count сообщений очереди пропускаются).
     */
    read(from: QueueMark, cursor: MessageCursor | null, max: number): Promise<QueueWindow>;
}

/** Входящее сообщение контракта и исход его транзакции. */
export type L1Message = {
    lt: bigint;
    /** Хеш транзакции, hex. */
    hash: string;
    /** Вычисление прошло и транзакция не прервана: состояние контракта изменилось. */
    success: boolean;
    /** Тело входящего внутреннего сообщения; null — внешнее или возвращённое (bounced). */
    body: Cell | null;
};

/** Входящие сообщения контракта в порядке lt, строго после `after` (null — с начала). */
export interface MessageFeed {
    after(after: { lt: bigint; hash: string } | null, limit: number): Promise<L1Message[]>;
}

/**
 * То, что источник очереди читает у контракта get-методами. Ему соответствуют и обёртка
 * Rollup в Sandbox, и она же, открытая через TonClient.
 */
export interface RollupQueueView {
    getDepositQueue(): Promise<{ head: { count: bigint; hash: bigint }; processed: { count: bigint; hash: bigint } }>;
    getQueueItem(index: number | bigint): Promise<{ hashBefore: bigint; queuedAt: number } | null>;
    getDepositReceipt(depositIndex: number): Promise<{ amount: bigint } | null>;
}

/** Расхождение очереди с контрактом: сервис останавливается с этим текстом. */
export class QueueMismatchError extends Error {}
