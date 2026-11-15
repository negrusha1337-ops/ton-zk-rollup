import { Address, Cell } from '@ton/core';
import { TonClient } from '@ton/ton';
import { Rollup } from '../../wrappers/Rollup';
import { ContractQueueSource } from './contractSource';
import { SnakeLimits } from './messages';
import { L1Message, MessageFeed, RollupQueueView } from './types';

// Очередь L1 в testnet: только чтение, без ключей. Get-методы — toncenter v2 (TonClient),
// входящие сообщения — индексатор toncenter v3 (/transactions по lt, по возрастанию). Ключ API —
// из переменной окружения TONCENTER_API_KEY, если задан (без ключа — 1 запрос в секунду, с
// бесплатным ключом — 10). Ничего не отправляет.

export const TESTNET_V2 = 'https://testnet.toncenter.com/api/v2/jsonRPC';
export const TESTNET_V3 = 'https://testnet.toncenter.com/api/v3';

/** Повтор при ответе 429 (превышена частота): до пяти раз с растущей паузой. Прочие ошибки — сразу наверх. */
export async function retrying<R>(call: () => Promise<R>, pause = (attempt: number) => 1500 * attempt): Promise<R> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await call();
        } catch (error) {
            if (attempt >= 5 || !/\b429\b/.test(String((error as Error)?.message ?? error))) throw error;
            await new Promise((resolve) => setTimeout(resolve, pause(attempt)));
        }
    }
}

/** Не чаще `perSecond` запросов в секунду — общий на все вызовы одного источника. */
export function rateLimiter(perSecond: number): () => Promise<void> {
    const gap = Math.ceil(1000 / perSecond);
    let next = 0;
    return async () => {
        const now = Date.now();
        const at = Math.max(now, next);
        next = at + gap;
        if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
    };
}

type V3Transaction = {
    lt: string;
    hash: string;
    description?: { aborted?: boolean; compute_ph?: { skipped?: boolean; success?: boolean } };
    in_msg?: { source?: string | null; bounced?: boolean | null; message_content?: { body?: string | null } } | null;
};

/** Разбор ответа v3 в сообщения сервиса. Чистая функция: на ней держится тест разбора. */
export function v3Messages(transactions: V3Transaction[]): L1Message[] {
    return transactions.map((transaction) => {
        const compute = transaction.description?.compute_ph;
        const success = !transaction.description?.aborted && !compute?.skipped && compute?.success === true;
        const message = transaction.in_msg;
        const internal = Boolean(message?.source) && !message?.bounced && message?.message_content?.body;
        return {
            lt: BigInt(transaction.lt),
            hash: Buffer.from(transaction.hash, 'base64').toString('hex'),
            success,
            body: internal ? Cell.fromBase64(message!.message_content!.body!) : null,
        };
    });
}

export class ToncenterFeed implements MessageFeed {
    constructor(
        private readonly address: Address,
        private readonly limit: () => Promise<void>,
        private readonly apiKey?: string,
        private readonly base = TESTNET_V3,
    ) {}

    async after(after: { lt: bigint; hash: string } | null, limit: number): Promise<L1Message[]> {
        const query = new URLSearchParams({
            account: this.address.toRawString(),
            sort: 'asc',
            limit: String(limit),
            ...(after ? { start_lt: (after.lt + 1n).toString() } : {}),
        });
        const page = await retrying(async () => {
            await this.limit();
            const response = await fetch(`${this.base}/transactions?${query}`, {
                headers: this.apiKey ? { 'X-API-Key': this.apiKey } : {},
                signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) throw new Error(`toncenter v3 /transactions ответил ${response.status}`);
            return ((await response.json()) as { transactions?: V3Transaction[] }).transactions ?? [];
        });
        return v3Messages(page);
    }
}

/** Get-методы контракта через TonClient, каждый вызов — через общий ограничитель частоты. */
export function testnetRollupView(client: TonClient, address: Address, limit: () => Promise<void>) {
    const rollup = client.open(Rollup.createFromAddress(address));
    const limited =
        <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
        (...args: A): Promise<R> =>
            retrying(async () => {
                await limit();
                return call(...args);
            });
    return {
        getDepositQueue: limited(() => rollup.getDepositQueue()),
        getQueueItem: limited((index: number | bigint) => rollup.getQueueItem(index)),
        getDepositReceipt: limited((index: number) => rollup.getDepositReceipt(index)),
        getQueueLimits: limited(() => rollup.getQueueLimits()),
        getChainId: limited(() => rollup.getChainId()),
        getGenesisHash: limited(() => rollup.getGenesisHash()),
    } satisfies RollupQueueView & Record<string, unknown>;
}

export class TestnetQueueSource extends ContractQueueSource {
    readonly contract: ReturnType<typeof testnetRollupView>;

    constructor(
        address: Address,
        limits: SnakeLimits,
        options: {
            apiKey?: string;
            client?: TonClient;
            limit?: () => Promise<void>;
            allowBelowProcessed?: boolean;
        } = {},
    ) {
        const limit = options.limit ?? rateLimiter(options.apiKey ? 9 : 1);
        const client = options.client ?? new TonClient({ endpoint: TESTNET_V2, apiKey: options.apiKey });
        const view = testnetRollupView(client, address, limit);
        super(view, new ToncenterFeed(address, limit, options.apiKey), limits, options.allowBelowProcessed ?? false);
        this.contract = view;
    }
}
