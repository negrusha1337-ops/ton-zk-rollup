import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { Address, beginCell, Cell } from '@ton/core';
import { RollupOpcodes } from '../wrappers/Rollup';
import { forcedTransactionCell } from '../wrappers/rollupMath';
import { ContractQueueSource } from '../sequencer/queue/contractSource';
import { queueStep } from '../sequencer/queue/messages';
import { ToncenterFeed } from '../sequencer/queue/toncenter';
import { QueueItem, QueueLagError, QueueMismatchError, RollupQueueView } from '../sequencer/queue/types';

// Очередь L1 из индексатора toncenter v3 — на записанных страницах ответа: локальный HTTP-сервер
// отдаёт /transactions так же, как индексатор (по lt, по возрастанию, с start_lt включительно).
// История контракта — больше ста транзакций (постраничное чтение), с неуспешной, возвращённой,
// внешней и с чужим опкодом; get-методы — заглушка, хеши цепочки посчитаны формулой контракта.

const LIMITS = { maxForcedTxCells: 3, maxForcedTxBytes: 256 };
const ADDRESS = new Address(0, Buffer.alloc(32, 7));
const COUNT = 130;

type V3 = {
    lt: string;
    hash: string;
    description: { aborted: boolean; compute_ph: { success: boolean } };
    in_msg: { source: string | null; bounced: boolean; message_content: { body: string } };
};

const recipient = (index: number) => '0x' + (index + 1).toString(16).padStart(40, '0');
const itemOf = (number: number): QueueItem =>
    number % 3 === 0
        ? { kind: 'forced', number, bytes: Buffer.from('02f8' + number.toString(16).padStart(4, '0'), 'hex') }
        : { kind: 'deposit', number, l2Recipient: recipient(number), amount: BigInt(number) * 1000n };
const bodyOf = (item: QueueItem): Cell =>
    item.kind === 'deposit'
        ? beginCell()
              .storeUint(RollupOpcodes.depositTon, 32)
              .storeUint(0, 64)
              .storeUint(BigInt(item.l2Recipient), 160)
              .storeCoins(item.amount)
              .endCell()
        : beginCell()
              .storeUint(RollupOpcodes.forceTransaction, 32)
              .storeUint(0, 64)
              .storeRef(forcedTransactionCell(item.bytes))
              .endCell();

const items = Array.from({ length: COUNT }, (_, index) => itemOf(index + 1));
const hashes = [0n];
for (const item of items) hashes.push(queueStep(hashes[hashes.length - 1], item));

/** История контракта: элементы очереди вперемешку с транзакциями, которые элемента не ставят. */
const history: V3[] = [];
const itemTx = new Map<number, V3>();
let lt = 1000n;
const push = (body: Cell, extra: { aborted?: boolean; source?: string | null; bounced?: boolean } = {}) => {
    lt += 2n;
    const transaction: V3 = {
        lt: lt.toString(),
        hash: Buffer.alloc(32, Number(lt % 251n)).fill(Number(lt % 256n), 0, 4).toString('base64'),
        description: { aborted: extra.aborted ?? false, compute_ph: { success: !extra.aborted } },
        in_msg: {
            source: extra.source === undefined ? '0:' + '11'.repeat(32) : extra.source,
            bounced: extra.bounced ?? false,
            message_content: { body: body.toBoc().toString('base64') },
        },
    };
    history.push(transaction);
    return transaction;
};
for (const item of items) {
    if (item.number % 10 === 1) push(bodyOf(itemOf(999)), { aborted: true }); // отвергнутый депозит
    if (item.number % 10 === 4) push(bodyOf(item), { bounced: true }); // возвращённое
    if (item.number % 10 === 6) push(beginCell().storeUint(RollupOpcodes.publishData, 32).endCell()); // чужой опкод
    if (item.number % 10 === 8) push(bodyOf(item), { source: null }); // внешнее
    itemTx.set(item.number, push(bodyOf(item)));
}

const view = (overrides: { processed?: number; missing?: number } = {}): RollupQueueView => ({
    getDepositQueue: async () => ({
        head: { count: BigInt(COUNT), hash: hashes[COUNT] },
        processed: { count: BigInt(overrides.processed ?? 0), hash: hashes[overrides.processed ?? 0] },
    }),
    getQueueItem: async (index) =>
        Number(index) >= 1 && Number(index) <= COUNT && Number(index) !== overrides.missing
            ? { hashBefore: hashes[Number(index) - 1], queuedAt: 0 }
            : null,
    getDepositReceipt: async (number) => {
        const item = items[number - 1];
        return item?.kind === 'deposit' ? { amount: item.amount } : null;
    },
});
const cursorOf = (number: number) => {
    const transaction = itemTx.get(number)!;
    return { lt: transaction.lt, hash: Buffer.from(transaction.hash, 'base64').toString('hex'), number };
};

describe('сборщик блоков: очередь L1 из индексатора toncenter v3 (записанные страницы)', () => {
    let server: Server;
    let base: string;
    let visible = history.length;
    let requests = 0;

    beforeAll(async () => {
        server = createServer((request, response) => {
            requests++;
            const url = new URL(request.url!, 'http://local');
            const startLt = BigInt(url.searchParams.get('start_lt') ?? '0');
            const limit = Number(url.searchParams.get('limit'));
            const page =
                url.pathname === '/transactions' &&
                url.searchParams.get('account') === ADDRESS.toRawString() &&
                url.searchParams.get('sort') === 'asc'
                    ? history.slice(0, visible).filter((transaction) => BigInt(transaction.lt) >= startLt).slice(0, limit)
                    : null;
            response.writeHead(page ? 200 : 400, { 'content-type': 'application/json' });
            response.end(JSON.stringify(page ? { transactions: page } : { error: 'bad request' }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        await new Promise((resolve) => server.close(resolve));
    });
    beforeEach(() => {
        visible = history.length;
        requests = 0;
    });

    const source = (stub = view(), lag = { retries: 0, pauseMs: 0 }) =>
        new ContractQueueSource(stub, new ToncenterFeed(ADDRESS, async () => {}, undefined, base), LIMITS, false, lag);

    it('больше ста транзакций: все элементы по порядку, неуспешная, возвращённая, внешняя и чужой опкод — не элементы', async () => {
        expect(history.length).toBeGreaterThan(150);
        const window = await source().read({ count: 0, hash: 0n }, null, COUNT);
        expect(window.items.map(({ item }) => item)).toEqual(items);
        expect(window.items[COUNT - 1].message).toEqual(cursorOf(COUNT));
        expect(requests).toBeGreaterThan(1);
    });

    it('с курсора — элементы строго после него; курсор сверяется по хешу транзакции', async () => {
        const window = await source().read({ count: 120, hash: hashes[120] }, cursorOf(120), 32);
        expect(window.items.map(({ item }) => item.number)).toEqual(Array.from({ length: 10 }, (_, i) => 121 + i));
        await expect(
            source().read({ count: 120, hash: hashes[120] }, { ...cursorOf(120), hash: 'ab'.repeat(32) }, 32),
        ).rejects.toThrow(`в истории контракта у toncenter нет транзакции курсора lt ${cursorOf(120).lt}`);
    });

    it('отметка позади обработанного и элемент без записи у контракта — QueueMismatchError с текстом', async () => {
        const behind = source(view({ processed: 5 })).read({ count: 3, hash: hashes[3] }, null, 32);
        await expect(behind).rejects.toBeInstanceOf(QueueMismatchError);
        await expect(source(view({ processed: 5 })).read({ count: 3, hash: hashes[3] }, null, 32)).rejects.toThrow(
            'отметка сервиса 3 позади обработанного контрактом (5): состояние сервиса не от этого контракта',
        );
        const pruned = source(view({ missing: 2 })).read({ count: 0, hash: 0n }, null, 32);
        await expect(pruned).rejects.toBeInstanceOf(QueueMismatchError);
        await expect(source(view({ missing: 2 })).read({ count: 0, hash: 0n }, null, 32)).rejects.toThrow(
            'у контракта нет записи об элементе очереди №2 (уже убран?)',
        );
    });

    it('индексатор отстаёт: элемента ещё нет — повтор с ожиданием, затем QueueLagError, а не расхождение', async () => {
        visible = history.indexOf(itemTx.get(COUNT - 2)!) + 1;
        const lagging = source(view(), { retries: 1, pauseMs: 10 }).read({ count: 120, hash: hashes[120] }, cursorOf(120), 32);
        await expect(lagging).rejects.toBeInstanceOf(QueueLagError);
        await expect(
            source(view(), { retries: 0, pauseMs: 0 }).read({ count: 120, hash: hashes[120] }, cursorOf(120), 32),
        ).rejects.toThrow('у контракта элементы очереди до №130, а сообщений после отметки 120 найдено 8 из 10');
        // Догнал во время ожидания — окно целиком.
        const caughtUp = source(view(), { retries: 3, pauseMs: 30 }).read({ count: 120, hash: hashes[120] }, cursorOf(120), 32);
        setTimeout(() => (visible = history.length), 10);
        expect((await caughtUp).items).toHaveLength(10);
    });
});
