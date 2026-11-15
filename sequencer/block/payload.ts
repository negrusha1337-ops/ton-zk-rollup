import { GAS_LIMIT, ZERO_HASH } from '../protocol';
import { Credit } from './segment';

// Запрос к testing_buildBlockV1 и сверка ответа узла — чистые функции.
//
// Узел (reth v2.2.0, --testing.skip-invalid-transactions по умолчанию включён) негодную
// транзакцию и все следующие того же отправителя выбрасывает МОЛЧА, а поля заголовка берёт свои
// (лимит газа — от родителя). Поэтому ответ сверяется: принудительные транзакции — ровно
// запрошенные, байт в байт и по порядку; транзакции пула — подпоследовательность запрошенных;
// зачисления, время, получатель чаевых, родитель и закреплённые программой поля — как запрошено.

export type BuildRequest = {
    parentBlockHash: string;
    payloadAttributes: {
        timestamp: string;
        prevRandao: string;
        suggestedFeeRecipient: string;
        withdrawals: Credit[];
        parentBeaconBlockRoot: string;
    };
    transactions: string[];
};

/** Поля ExecutionPayloadV3, которые сверяет сборщик. */
export type ExecutionPayload = {
    parentHash: string;
    feeRecipient: string;
    stateRoot: string;
    prevRandao: string;
    blockNumber: string;
    gasLimit: string;
    gasUsed: string;
    timestamp: string;
    extraData: string;
    blockHash: string;
    transactions: string[];
    withdrawals: { index: string; validatorIndex: string; address: string; amount: string }[];
    blobGasUsed: string;
    excessBlobGas: string;
    [field: string]: unknown;
};

/** Время блока: не раньше секунды после родителя и не раньше «сейчас» (программа: строго позже родителя). */
export const blockTimestamp = (parentTimestamp: number, now: number): number => Math.max(parentTimestamp + 1, now);

export function buildRequest(options: {
    parentHash: string;
    timestamp: number;
    feeRecipient: string;
    credits: Credit[];
    forced: string[];
    pool: string[];
}): BuildRequest {
    return {
        parentBlockHash: options.parentHash,
        payloadAttributes: {
            timestamp: '0x' + options.timestamp.toString(16),
            prevRandao: ZERO_HASH,
            suggestedFeeRecipient: options.feeRecipient.toLowerCase(),
            withdrawals: options.credits,
            parentBeaconBlockRoot: ZERO_HASH,
        },
        transactions: [...options.forced, ...options.pool].map((raw) => raw.toLowerCase()),
    };
}

/** Итог сверки ответа узла. */
export type PayloadCheck = {
    /** Нарушения закреплённых полей и порядка: любое — кандидат негоден. */
    problems: string[];
    /** Номера (в запрошенном списке принудительных) выброшенных узлом принудительных транзакций. */
    droppedForced: number[];
    /** Сколько транзакций пула узел включил. */
    poolIncluded: number;
};

const same = (a: string | undefined, b: string | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
const num = (value: string) => BigInt(value);

/**
 * Сверка ответа узла с запросом. `forcedCount` — сколько первых транзакций запроса —
 * принудительные. Выброшенные принудительные не ошибка сами по себе (узел отказал им тем же
 * revm, что и программа), но такой кандидат не годится: состав пересобирается без них.
 */
export function checkPayload(request: BuildRequest, forcedCount: number, payload: ExecutionPayload): PayloadCheck {
    const problems: string[] = [];
    const attributes = request.payloadAttributes;
    if (!same(payload.parentHash, request.parentBlockHash))
        problems.push(`родитель ${payload.parentHash}, а запрошен ${request.parentBlockHash}`);
    if (num(payload.timestamp) !== num(attributes.timestamp))
        problems.push(`время ${num(payload.timestamp)}, а запрошено ${num(attributes.timestamp)}`);
    if (!same(payload.feeRecipient, attributes.suggestedFeeRecipient))
        problems.push(`получатель чаевых ${payload.feeRecipient}`);
    if (!same(payload.prevRandao, ZERO_HASH)) problems.push('prevRandao не ноль');
    if (num(payload.gasLimit) !== GAS_LIMIT) problems.push(`лимит газа ${num(payload.gasLimit)} вместо ${GAS_LIMIT}`);
    if (payload.extraData !== '0x') problems.push('extraData не пуст');
    if (num(payload.blobGasUsed ?? '0x1') !== 0n || num(payload.excessBlobGas ?? '0x1') !== 0n)
        problems.push('расход или избыток blob-газа не ноль');
    const credits = payload.withdrawals ?? [];
    const wanted = attributes.withdrawals;
    if (
        credits.length !== wanted.length ||
        credits.some(
            (credit, index) =>
                num(credit.index) !== num(wanted[index].index) ||
                num(credit.validatorIndex) !== num(wanted[index].validatorIndex) ||
                !same(credit.address, wanted[index].address) ||
                num(credit.amount) !== num(wanted[index].amount),
        )
    ) {
        problems.push('зачисления не те, что запрошены');
    }

    // Транзакции: принудительные — префикс запроса с выброшенными; пул — подпоследовательность.
    const got = payload.transactions.map((raw) => raw.toLowerCase());
    const forced = request.transactions.slice(0, forcedCount);
    const pool = request.transactions.slice(forcedCount);
    const droppedForced: number[] = [];
    let at = 0;
    forced.forEach((raw, index) => {
        if (got[at] === raw) at++;
        else droppedForced.push(index);
    });
    let poolIncluded = 0;
    let poolAt = 0;
    for (; at < got.length; at++) {
        while (poolAt < pool.length && pool[poolAt] !== got[at]) poolAt++;
        if (poolAt === pool.length) {
            problems.push(`транзакция блока №${at} не из запроса либо не на своём месте`);
            break;
        }
        poolAt++;
        poolIncluded++;
    }
    return { problems, droppedForced, poolIncluded };
}

/**
 * Какие принудительные убрать перед следующей сборкой: первую выброшенную у каждого
 * отправителя. Узел выбрасывает её за отказ revm, а остальные того же отправителя — уже без
 * исполнения («все следующие того же отправителя»), и программа могла бы их включить.
 */
export function forcedToDrop(dropped: number[], signerOfForced: string[]): number[] {
    const seen = new Set<string>();
    const out: number[] = [];
    for (const index of [...dropped].sort((a, b) => a - b)) {
        const signer = signerOfForced[index].toLowerCase();
        if (seen.has(signer)) continue;
        seen.add(signer);
        out.push(index);
    }
    return out;
}

/** Транзакция пула (ответ txpool_content) — только поля, по которым она фильтруется. */
export type PoolTransaction = {
    hash: string;
    from: string;
    nonce: string;
    type?: string;
    chainId?: string | null;
    gas: string;
    blobVersionedHashes?: unknown[] | null;
    authorizationList?: unknown[] | null;
};

/**
 * Фильтр пула: то, что Reth примет, а программа отвергнет весь блок (REVIEW.md, круг 11): тип
 * вне 0/1/2, нет chainId или он чужой, blob-транзакция, делегирование EIP-7702. Порядок — по
 * отправителю и nonce; общий газ — не больше лимита блока за вычетом запаса под принудительные.
 */
export function filterPool(transactions: PoolTransaction[], chainId: bigint, gasBudget: bigint): PoolTransaction[] {
    const allowed = transactions.filter(
        (transaction) =>
            ['0x0', '0x1', '0x2'].includes((transaction.type ?? '').toLowerCase()) &&
            transaction.chainId !== undefined &&
            transaction.chainId !== null &&
            BigInt(transaction.chainId) === chainId &&
            !(transaction.blobVersionedHashes && transaction.blobVersionedHashes.length > 0) &&
            !(transaction.authorizationList && transaction.authorizationList.length > 0),
    );
    allowed.sort((a, b) => (a.from === b.from ? Number(BigInt(a.nonce) - BigInt(b.nonce)) : a.from < b.from ? -1 : 1));
    const out: PoolTransaction[] = [];
    let gas = 0n;
    for (const transaction of allowed) {
        if (gas + BigInt(transaction.gas) > gasBudget) break;
        gas += BigInt(transaction.gas);
        out.push(transaction);
    }
    return out;
}
