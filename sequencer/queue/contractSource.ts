import { parseQueueMessage, queueStep, SnakeLimits } from './messages';
import {
    L1Message,
    MessageCursor,
    MessageFeed,
    QueuedItem,
    QueueItem,
    QueueMark,
    QueueMismatchError,
    QueueSource,
    QueueWindow,
    RollupQueueView,
} from './types';

// Источник очереди по контракту: отметки и хеши — get-методами, сами элементы — из входящих
// сообщений (MessageFeed). Каждая успешная транзакция с DepositTon или ForceTransaction ставит
// ровно один элемент, поэтому k-е такое сообщение после сообщения элемента n — это элемент n + k.
// Номер не берётся на веру: элемент принимается, только если шаг хеша от него переводит хеш
// цепочки контракта до элемента (queueItem(n).hashBefore) в хеш после него.

const PAGE = 100;

/**
 * Хеши цепочки очереди для номеров (from, upTo]: hashBefore[i] — хеш до элемента from+1+i,
 * последний — хеш после upTo. Берутся у контракта; хеш в самой отметке `from` обязан совпасть.
 */
export async function chainHashes(
    view: RollupQueueView,
    from: QueueMark,
    upTo: number,
    head: QueueMark,
): Promise<bigint[]> {
    const hashes: bigint[] = [];
    for (let number = from.count + 1; number <= upTo; number++) {
        const entry = await view.getQueueItem(number);
        if (!entry) throw new QueueMismatchError(`у контракта нет записи об элементе очереди №${number} (уже убран?)`);
        hashes.push(entry.hashBefore);
    }
    hashes.push(upTo === head.count ? head.hash : ((await view.getQueueItem(upTo + 1))?.hashBefore ?? -1n));
    if (hashes[hashes.length - 1] === -1n)
        throw new QueueMismatchError(`у контракта нет записи об элементе очереди №${upTo + 1}`);
    if (hashes[0] !== from.hash) {
        throw new QueueMismatchError(
            `хеш очереди в отметке ${from.count} у контракта 0x${hashes[0].toString(16)}, а у сервиса 0x${from.hash.toString(16)}`,
        );
    }
    return hashes;
}

/**
 * Сопоставляет сообщения элементам и сверяет каждый с хешем цепочки. `messages` — успешные
 * сообщения очереди после сообщения элемента `from.count`, по порядку; `amountOf` — сумма
 * депозита с этим номером (квитанция контракта). Чистая функция, кроме чтения сумм.
 */
export async function matchQueueItems(
    from: QueueMark,
    hashes: bigint[],
    messages: { message: L1Message; parsed: ReturnType<typeof parseQueueMessage> }[],
    amountOf: (number: number) => Promise<bigint | null>,
): Promise<QueuedItem[]> {
    const wanted = hashes.length - 1;
    const out: QueuedItem[] = [];
    for (let index = 0; index < wanted; index++) {
        const number = from.count + 1 + index;
        const entry = messages[index];
        if (!entry)
            throw new QueueMismatchError(
                `у контракта есть элемент очереди №${number}, а сообщения, которое его поставило, сервис не нашёл`,
            );
        const { message, parsed } = entry;
        const where = `элемент очереди №${number} (транзакция lt ${message.lt}, ${message.hash})`;
        let item: QueueItem;
        if (parsed.kind === 'deposit') {
            const amount = await amountOf(number);
            if (amount === null) throw new QueueMismatchError(`${where}: депозит без квитанции у контракта`);
            item = { kind: 'deposit', number, l2Recipient: parsed.l2Recipient, amount };
        } else if (parsed.kind === 'forced') {
            item = { kind: 'forced', number, bytes: parsed.bytes };
        } else {
            throw new QueueMismatchError(`${where}: сообщение не ставит элемент в очередь`);
        }
        const after = queueStep(hashes[index], item);
        if (after !== hashes[index + 1]) {
            throw new QueueMismatchError(
                `${where} не сходится с хешем очереди контракта: от сообщения 0x${after.toString(16)}, у контракта 0x${hashes[index + 1].toString(16)}`,
            );
        }
        out.push({ item, message: { lt: message.lt.toString(), hash: message.hash, number } });
    }
    return out;
}

export class ContractQueueSource implements QueueSource {
    constructor(
        private readonly view: RollupQueueView,
        private readonly feed: MessageFeed,
        private readonly limits: SnakeLimits,
        /** Читать и уже обработанные контрактом элементы (только для осмотра из командной строки). */
        private readonly allowBelowProcessed = false,
    ) {}

    async read(from: QueueMark, cursor: MessageCursor | null, max: number): Promise<QueueWindow> {
        const queue = await this.view.getDepositQueue();
        const head = { count: Number(queue.head.count), hash: queue.head.hash };
        const processed = { count: Number(queue.processed.count), hash: queue.processed.hash };
        if (from.count > head.count)
            throw new QueueMismatchError(`отметка сервиса ${from.count} дальше головы очереди контракта ${head.count}`);
        if (from.count < processed.count && !this.allowBelowProcessed) {
            throw new QueueMismatchError(
                `отметка сервиса ${from.count} позади обработанного контрактом (${processed.count}): состояние сервиса не от этого контракта`,
            );
        }
        if (cursor && cursor.number !== from.count) {
            throw new QueueMismatchError(
                `курсор сообщений (элемент ${cursor.number}) не соответствует отметке ${from.count}`,
            );
        }
        const upTo = Math.min(head.count, from.count + max);
        if (upTo === from.count) return { head, processed, from, items: [] };
        const hashes = await chainHashes(this.view, from, upTo, head);
        // Без курсора счёт идёт с начала истории контракта: первые from.count сообщений очереди
        // пропускаются. Номер от этого не становится «на веру»: следующие сверяются по хешу.
        const messages = await this.queueMessages(cursor, cursor ? 0 : from.count, upTo - from.count);
        const items = await matchQueueItems(
            from,
            hashes,
            messages,
            async (number) => (await this.view.getDepositReceipt(number))?.amount ?? null,
        );
        return { head, processed, from, items };
    }

    /** `count` успешных сообщений очереди после курсора, пропустив первые `skip`. */
    private async queueMessages(cursor: MessageCursor | null, skip: number, count: number) {
        const found: { message: L1Message; parsed: ReturnType<typeof parseQueueMessage> }[] = [];
        let after = cursor ? { lt: BigInt(cursor.lt), hash: cursor.hash } : null;
        while (found.length < count) {
            const page = await this.feed.after(after, PAGE);
            for (const message of page) {
                if (!message.success || !message.body) continue;
                const parsed = parseQueueMessage(message.body, this.limits);
                if (parsed.kind === 'other') continue;
                if (skip > 0) {
                    skip--;
                    continue;
                }
                found.push({ message, parsed });
                if (found.length === count) break;
            }
            if (page.length < PAGE) break;
            after = { lt: page[page.length - 1].lt, hash: page[page.length - 1].hash };
        }
        return found;
    }
}
