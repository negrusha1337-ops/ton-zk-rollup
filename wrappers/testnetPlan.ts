import { Cell, toNano } from '@ton/core';
import type { RethExpected, RethQueueItem } from './evmProofs';
import { BASE_DEPOSIT_FEE } from './Rollup';
import { MIN_ESCAPE_TIMEOUT_SECONDS, MIN_MAX_BLOCK_AGE_SECONDS } from './rollupDeployment';
import {
    DEPLOY_VALUE,
    ESCAPE_SERVICE_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    LATE_DEPOSIT_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    WITHDRAW_VALUE,
} from './rollupValues';

// Расчёты прогона полного цикла протокола v2 в testnet (scripts/runRethCycleTestnet.ts): сколько
// монет нужно кошельку, когда открыто окно времени батчей и можно ли начинать. Только чистые
// функции: ни сети, ни часов, ни файлов — всё приходит аргументами. Тест — tests/TestnetPlan.spec.ts
// на нынешней цепочке (fixtures/evm_batches/reth/expected.json).

/** Базовая плата за принудительную транзакцию (FORCE_TRANSACTION_FEE в contracts/rollup/logic.tolk). */
export const BASE_FORCE_TRANSACTION_FEE = toNano('0.05');
/** Плата за место удваивается на каждые столько необработанных элементов (QUEUE_FEE_STEP). */
export const QUEUE_FEE_STEP = 64;
/** Предел числа удвоений (QUEUE_FEE_MAX_DOUBLINGS). */
export const QUEUE_FEE_MAX_DOUBLINGS = 40;
/**
 * Оценка сверху минимума монет на ForceExitEvm ДО развёртывания: запас шага 500 000 gas по
 * 66,67 нанотон (0,0334 TON), пересылка заявки и минимум нуллификатора — около 0,038 TON. После
 * развёртывания скрипт берёт точное значение у контракта (get-метод evmExitBudget).
 */
export const EVM_EXIT_VALUE_ESTIMATE = toNano('0.045');
/** Комиссия кошелька за одно исходящее сообщение без учёта размера тела (газ, хранение): оценка сверху. */
export const WALLET_TX_FEE = toNano('0.003');

/** Суммы сообщений и платы очереди, по которым считается потребность кошелька. */
export type CyclePrices = {
    deploy: bigint;
    keyPart: bigint;
    keyFinalize: bigint;
    publishData: bigint;
    submitBatch: bigint;
    withdraw: bigint;
    evmExit: bigint;
    escapeService: bigint;
    /** Сколько прикладывается к позднему депозиту; на L2 зачлось бы это минус плата за место. */
    lateDeposit: bigint;
    depositFee: bigint;
    forceTransactionFee: bigint;
    queueFeeStep: number;
    queueFeeMaxDoublings: number;
};

/** Цены до развёртывания: суммы из rollupValues.ts и оценки сверху там, где минимум считает контракт. */
export const ESTIMATED_PRICES: CyclePrices = {
    deploy: DEPLOY_VALUE,
    keyPart: KEY_PART_VALUE,
    keyFinalize: KEY_FINALIZE_VALUE,
    publishData: PUBLISH_DATA_VALUE,
    submitBatch: SUBMIT_BATCH_VALUE,
    withdraw: WITHDRAW_VALUE,
    evmExit: EVM_EXIT_VALUE_ESTIMATE,
    escapeService: ESCAPE_SERVICE_VALUE,
    lateDeposit: LATE_DEPOSIT_VALUE,
    depositFee: BASE_DEPOSIT_FEE,
    forceTransactionFee: BASE_FORCE_TRANSACTION_FEE,
    queueFeeStep: QUEUE_FEE_STEP,
    queueFeeMaxDoublings: QUEUE_FEE_MAX_DOUBLINGS,
};

/** Сколько раз удвоена плата за место при таком числе необработанных элементов (queueFeeDoublings в logic.tolk). */
export const queueFeeDoublings = (pending: number, step = QUEUE_FEE_STEP, maxDoublings = QUEUE_FEE_MAX_DOUBLINGS): number =>
    Math.min(Math.floor(pending / step), maxDoublings);

/** Описание цепочки в объёме, нужном расчётам (подмножество expected.json). */
export type ChainPlanSource = Pick<RethExpected, 'blocks' | 'queue' | 'withdrawals' | 'exitRecipientHash' | 'exitsByBlock'>;

/** Постановка одного элемента очереди L1: когда, сколько приложить и сколько из этого плата. */
export type QueueStep = {
    item: RethQueueItem;
    /** Перед каким батчем элемент ставится в очередь (по headAtBatch блоков). */
    beforeBatch: number;
    /** Плата за место при длине необработанного хвоста на момент постановки. */
    fee: bigint;
    /** Сколько приложить к сообщению: для депозита — сумма на L2 плюс плата, для принудительной — плата. */
    value: bigint;
};

/**
 * Очередь L1 прогона в порядке отправки: перед батчем k ставятся элементы до `headAtBatch`
 * блока k (так очередь стояла, когда блок собирался, — и так её ставит набор в Sandbox, поэтому
 * газ батчей сравним с замером). Плата считается как в контракте: удваивается на каждые
 * `queueFeeStep` элементов между отметками processed и head. Отказывает на цепочке, по которой
 * прогон невозможен: номера не подряд, поле `batch` расходится с отметками блоков.
 */
export function queuePlan(source: Pick<ChainPlanSource, 'blocks' | 'queue'>, lastBatch: number, prices: CyclePrices = ESTIMATED_PRICES): QueueStep[] {
    if (!Number.isInteger(lastBatch) || lastBatch < 1 || lastBatch > source.blocks.length) {
        throw new Error(`queuePlan: батча ${lastBatch} в цепочке нет`);
    }
    const steps: QueueStep[] = [];
    let head = 0;
    let processed = 0;
    for (let batch = 1; batch <= lastBatch; batch++) {
        const block = source.blocks[batch - 1];
        if (block.number !== batch) throw new Error(`queuePlan: блок на месте ${batch} имеет номер ${block.number}`);
        if (block.queueProcessedFrom !== processed || block.queueProcessedUpTo < processed || block.headAtBatch < block.queueProcessedUpTo) {
            throw new Error(`queuePlan: отметки очереди блока ${batch} не продолжают предыдущий блок`);
        }
        if (block.headAtBatch < head || block.headAtBatch > source.queue.length) {
            throw new Error(`queuePlan: headAtBatch блока ${batch} вне очереди`);
        }
        for (; head < block.headAtBatch; head++) {
            const item = source.queue[head];
            if (item.number !== head + 1) throw new Error(`queuePlan: элемент очереди на месте ${head + 1} имеет номер ${item.number}`);
            const doublings = BigInt(queueFeeDoublings(head - processed, prices.queueFeeStep, prices.queueFeeMaxDoublings));
            const fee = (item.kind === 'deposit' ? prices.depositFee : prices.forceTransactionFee) << doublings;
            steps.push({ item, beforeBatch: batch, fee, value: item.kind === 'deposit' ? BigInt(item.amount) + fee : fee });
        }
        processed = block.queueProcessedUpTo;
        // Поле batch элемента — каким батчем он обработан: обязано сойтись с отметками блоков.
        for (const item of source.queue.slice(block.queueProcessedFrom, block.queueProcessedUpTo)) {
            if (item.batch !== batch) throw new Error(`queuePlan: элемент ${item.number} помечен батчем ${item.batch}, а обрабатывает его батч ${batch}`);
        }
    }
    return steps;
}

/** Строка разбивки потребности: сколько уходит с кошелька и сколько из этого вернётся на него. */
export type NeedLine = { what: string; messages: number; spent: bigint; returns: bigint };

export type WalletNeed = {
    lines: NeedLine[];
    messages: number;
    /** Сколько должно быть на кошельке до первой отправки. */
    total: bigint;
    /** Сколько вернётся: выводы через мост, аварийные выходы, возврат позднего депозита. */
    returns: bigint;
    /** Сколько не вернётся: платы, газ, комиссии и то, что осталось на L2. */
    lost: bigint;
};

/**
 * Полная потребность кошелька на прогон: развёртывание, очередь L1, данные, батчи 1…lastBatch,
 * вывод каждого листа моста, поздний депозит, заморозка, аварийные выходы счетов против блока
 * lastBatch и возврат позднего депозита. `walletFees` — комиссии самого кошелька за все
 * сообщения (estimateWalletFees).
 */
export function walletNeed(
    source: ChainPlanSource,
    options: { lastBatch: number; keyParts: number; dataChunks: number[]; walletFees: bigint; prices?: CyclePrices },
): WalletNeed {
    const prices = options.prices ?? ESTIMATED_PRICES;
    const { lastBatch } = options;
    if (options.dataChunks.length !== lastBatch) throw new Error('walletNeed: число порций данных задано не для каждого батча');
    const queue = queuePlan(source, lastBatch, prices);
    const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
    const deposits = queue.filter(({ item }) => item.kind === 'deposit');
    const forced = queue.filter(({ item }) => item.kind === 'forced');
    const leaves = source.withdrawals.filter((leaf) => leaf.block <= lastBatch);
    const exits = source.exitsByBlock.find(({ block }) => block === lastBatch)?.exits ?? [];
    const deposited = sum(deposits.map(({ item }) => BigInt((item as { amount: string }).amount)));
    const withdrawn = sum(leaves.map((leaf) => BigInt(leaf.amount)));
    const exited = sum(exits.map((exit) => BigInt(exit.balanceWei) / 1_000_000_000n));
    if (withdrawn + exited > deposited) {
        throw new Error('walletNeed: цепочка выплачивает больше, чем внесено депозитами — контракту нечем платить');
    }
    const chunks = options.dataChunks.reduce((total, count) => total + count, 0);
    const lateFee = prices.depositFee << BigInt(queueFeeDoublings(0, prices.queueFeeStep, prices.queueFeeMaxDoublings));
    const lines: NeedLine[] = [
        {
            what: 'развёртывание, части ключа и его фиксация',
            messages: options.keyParts + 2,
            spent: prices.deploy + BigInt(options.keyParts) * prices.keyPart + prices.keyFinalize,
            returns: 0n,
        },
        { what: 'депозиты: суммы на L2 (возвращаются выводами и выходами)', messages: deposits.length, spent: deposited, returns: withdrawn + exited },
        { what: 'депозиты: плата за место в очереди', messages: 0, spent: sum(deposits.map(({ fee }) => fee)), returns: 0n },
        { what: 'принудительные транзакции: плата за место в очереди', messages: forced.length, spent: sum(forced.map(({ fee }) => fee)), returns: 0n },
        { what: 'данные батчей', messages: chunks, spent: BigInt(chunks) * prices.publishData, returns: 0n },
        { what: 'батчи по пруфам', messages: lastBatch, spent: BigInt(lastBatch) * prices.submitBatch, returns: 0n },
        { what: 'выводы через мост: газ цепочки вывода', messages: leaves.length, spent: BigInt(leaves.length) * prices.withdraw, returns: 0n },
        { what: 'поздний депозит (возвращается за вычетом платы за место)', messages: 1, spent: prices.lateDeposit, returns: prices.lateDeposit - lateFee },
        { what: 'заморозка и возврат позднего депозита', messages: 2, spent: 2n * prices.escapeService, returns: 0n },
        { what: 'аварийные выходы счетов: газ шага', messages: exits.length, spent: BigInt(exits.length) * prices.evmExit, returns: 0n },
    ];
    const messages = lines.reduce((total, line) => total + line.messages, 0);
    lines.push({ what: 'комиссии кошелька за отправку (оценка)', messages: 0, spent: options.walletFees, returns: 0n });
    const total = sum(lines.map((line) => line.spent));
    const returns = sum(lines.map((line) => line.returns));
    return { lines, messages, total, returns, lost: total - returns };
}

/** Цены пересылки сообщений basechain (bench/network-config.json, параметр 25), нанотон. */
export type ForwardPrices = { lumpPriceNano: number; bitPriceNanoPerBit: number; cellPriceNanoPerCell: number };

/** Плата за пересылку сообщения с таким телом: разные ячейки дерева считаются по одному разу. */
export function forwardFeeOf(body: Cell, prices: ForwardPrices): bigint {
    const seen = new Set<string>();
    let bits = 0;
    const visit = (cell: Cell) => {
        const hash = cell.hash().toString('hex');
        if (seen.has(hash)) return;
        seen.add(hash);
        bits += cell.bits.length;
        cell.refs.forEach(visit);
    };
    visit(body);
    return BigInt(Math.ceil(prices.lumpPriceNano + bits * prices.bitPriceNanoPerBit + seen.size * prices.cellPriceNanoPerCell));
}

/**
 * Комиссии кошелька за все сообщения прогона, оценка сверху: на каждое — WALLET_TX_FEE и
 * дважды плата по размеру тела (тело едет в кошелёк внешним сообщением — плата за импорт — и из
 * кошелька в контракт — плата за пересылку). `bodies` — тела больших сообщений (части ключа,
 * пруфы с подсказками, данные, принудительные транзакции, выходы); `smallMessages` — сколько
 * остальных. В сети не измерялось: это оценка для предполётной проверки, не замер.
 */
export function estimateWalletFees(bodies: Cell[], smallMessages: number, prices: ForwardPrices): bigint {
    const smallBody = BigInt(Math.ceil(prices.lumpPriceNano + 2 * prices.cellPriceNanoPerCell + 1023 * prices.bitPriceNanoPerBit));
    const small = BigInt(smallMessages) * (WALLET_TX_FEE + 2n * smallBody);
    return bodies.reduce((total, body) => total + WALLET_TX_FEE + 2n * forwardFeeOf(body, prices), small);
}

/** Чем цепочка не подходит этому кошельку: выплаты ушли бы не ему. Пустой список — подходит. */
export function recipientProblems(source: Pick<ChainPlanSource, 'withdrawals' | 'exitRecipientHash'>, walletHashHex: string, lastBatch: number): string[] {
    const plain = (hex: string) => hex.replace(/^0x/, '').toLowerCase();
    const wallet = plain(walletHashHex);
    const problems: string[] = [];
    if (plain(source.exitRecipientHash) !== wallet) {
        problems.push('согласия на аварийный выход подписаны под другого получателя: выходы ушли бы не этому кошельку');
    }
    const foreign = source.withdrawals.filter((leaf) => leaf.block <= lastBatch && plain(leaf.recipientHash) !== wallet);
    if (foreign.length > 0) {
        problems.push(`выводы через мост (листья ${foreign.map((leaf) => leaf.leafIndex).join(', ')}) назначены другому получателю`);
    }
    return problems;
}

/**
 * Находка 16-2: против каких блоков 1…lastBatch−1 нет согласий на выход и сколько депозитов к
 * этому моменту уже зачислено на L2. Если прогон встанет после такого батча, эти монеты не
 * вернуть: возврат депозита работает только для необработанных, а выйти со счёта нечем.
 */
export function exitGaps(source: Pick<ChainPlanSource, 'blocks' | 'queue' | 'exitsByBlock'>, lastBatch: number): { block: number; lockedNano: bigint }[] {
    const gaps: { block: number; lockedNano: bigint }[] = [];
    for (let batch = 1; batch < lastBatch; batch++) {
        const credited = source.queue
            .slice(0, source.blocks[batch - 1].queueProcessedUpTo)
            .reduce((total, item) => total + (item.kind === 'deposit' ? BigInt(item.amount) : 0n), 0n);
        const consents = source.exitsByBlock.find(({ block }) => block === batch)?.exits ?? [];
        if (consents.length === 0 && credited > 0n) gaps.push({ block: batch, lockedNano: credited });
    }
    return gaps;
}

/** Параметры времени стенда и оценки скорости прогона. */
export type TimeInput = {
    /** Время блоков батчей 1…N (unix), по порядку. */
    blockTimestamps: number[];
    maxBlockAge: number;
    escapeTimeout: number;
    /** Сейчас по часам этой машины (unix). */
    now: number;
    /** Сколько сообщений осталось отправить до приёма последнего батча включительно. */
    messagesLeft: number;
    /** Самый старый необработанный элемент уже в очереди: когда он поставлен (unix); 0 — очередь пуста. */
    oldestPendingAt: number;
    /** Оценка времени на одно сообщение с подтверждением, секунд. */
    secondsPerMessage: number;
    /** Запас: часы блока L1 отстают от часов машины, а оценка скорости — оценка. */
    marginSeconds: number;
    /** Сколько скрипт согласен ждать открытия окна, секунд. */
    maxWaitSeconds: number;
};

export type TimeDecision = {
    /** С какого момента контракт примет все батчи: время последнего блока. */
    opensAt: number;
    /** До какого момента он примет каждый: время первого блока плюс maxBlockAge. */
    closesAt: number;
    /** Оценка времени на оставшийся путь до последнего батча, секунд. */
    pathSeconds: number;
    /** Не раньше этого момента можно ставить очередь и слать батчи (opensAt с запасом на часы). */
    startAt: number;
    /** Не позже этого момента надо начать, чтобы успеть до закрытия окна. */
    latestStartAt: number;
    action: 'go' | 'wait' | 'refuse';
    waitSeconds: number;
    reason: string;
};

/** Чем параметры времени стенда недопустимы для контракта (FinalizeKey откажет). */
export function timeConfigProblems(maxBlockAge: number, escapeTimeout: number): string[] {
    const problems: string[] = [];
    if (escapeTimeout < MIN_ESCAPE_TIMEOUT_SECONDS) problems.push(`срок заморозки ${escapeTimeout} с меньше допустимых ${MIN_ESCAPE_TIMEOUT_SECONDS} с`);
    if (maxBlockAge < MIN_MAX_BLOCK_AGE_SECONDS) problems.push(`возраст блока ${maxBlockAge} с меньше допустимых ${MIN_MAX_BLOCK_AGE_SECONDS} с`);
    if (maxBlockAge > escapeTimeout) problems.push(`возраст блока ${maxBlockAge} с больше срока заморозки ${escapeTimeout} с`);
    return problems;
}

/**
 * Можно ли сейчас идти к батчам. Контракт принимает батч k, только пока
 * `blockTimestamp_k ≤ now ≤ blockTimestamp_k + maxBlockAge`; батчи идут подряд, поэтому окно для
 * всех — от времени последнего блока до времени первого плюс maxBlockAge.
 *
 * Очередь L1 ставится не раньше открытия окна: поставленная заранее, она только приближает
 * заморозку (элемент, прождавший дольше escapeTimeout, позволяет заморозить rollup кому угодно),
 * а батч раньше окна всё равно не принять. Поэтому весь путь от первой постановки до последнего
 * батча обязан уложиться и в окно, и в срок заморозки.
 */
export function timeDecision(input: TimeInput): TimeDecision {
    const { blockTimestamps, maxBlockAge, escapeTimeout, now, marginSeconds } = input;
    if (blockTimestamps.length === 0) throw new Error('timeDecision: нет ни одного батча');
    const opensAt = Math.max(...blockTimestamps);
    const closesAt = Math.min(...blockTimestamps) + maxBlockAge;
    const pathSeconds = input.messagesLeft * input.secondsPerMessage;
    const startAt = opensAt + marginSeconds;
    const latestStartAt = closesAt - marginSeconds - pathSeconds;
    const at = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z');
    const decision = (action: TimeDecision['action'], reason: string, waitSeconds = 0): TimeDecision => ({
        opensAt, closesAt, pathSeconds, startAt, latestStartAt, action, waitSeconds, reason,
    });
    const window = `окно батчей: ${at(opensAt)} — ${at(closesAt)}`;
    if (latestStartAt < startAt) {
        return decision('refuse', `${window}; путь до последнего батча (${input.messagesLeft} сообщений, около ${pathSeconds} с) с запасом ${marginSeconds} с в окно не помещается`);
    }
    // Срок заморозки: от самого старого необработанного элемента (либо от начала постановки) до
    // приёма последнего батча.
    const queueFrom = input.oldestPendingAt > 0 ? input.oldestPendingAt : Math.max(now, startAt);
    const finishAt = Math.max(now, startAt) + pathSeconds;
    if (finishAt + marginSeconds > queueFrom + escapeTimeout) {
        return decision('refuse', `${window}; к приёму последнего батча (около ${at(finishAt)}) самый старый элемент очереди прождёт дольше срока заморозки ${escapeTimeout} с: rollup заморозит кто угодно`);
    }
    if (now > latestStartAt) {
        const left = closesAt - now;
        return decision(
            'refuse',
            left <= 0
                ? `${window}; окно закрыто ${-left} с назад: батчи этой цепочки контракт больше не примет (код 7330), цепочку и пруфы надо строить заново`
                : `${window}; до закрытия ${left} с, а на путь до последнего батча нужно около ${pathSeconds} с и запас ${marginSeconds} с`,
        );
    }
    if (now < startAt) {
        const waitSeconds = startAt - now;
        return waitSeconds <= input.maxWaitSeconds
            ? decision('wait', `${window}; до начала ${waitSeconds} с`, waitSeconds)
            : decision('refuse', `${window}; до начала ${waitSeconds} с — больше, чем задано ждать (${input.maxWaitSeconds} с): запусти скрипт не раньше ${at(startAt - input.maxWaitSeconds)} и не позже ${at(latestStartAt)}`);
    }
    return decision('go', `${window}; до закрытия ${closesAt - now} с, на путь нужно около ${pathSeconds} с`);
}

/** Всё, что предполётная проверка знает до первой отправки. */
export type PreflightInput = {
    proofs: { current: boolean; reason: string };
    timeConfig: string[];
    recipient: string[];
    need: WalletNeed;
    balance: bigint;
    /** Решение о времени; null — батчи уже приняты, окно больше не важно. */
    time: TimeDecision | null;
};

/** Причины отказа до первой отправки; пустой список — можно начинать (возможно, после ожидания окна). */
export function preflightRefusals(input: PreflightInput): string[] {
    const ton = (nano: bigint) => (Number(nano) / 1e9).toFixed(4);
    const refusals: string[] = [];
    if (!input.proofs.current) refusals.push(`пруфы блоков не годятся: ${input.proofs.reason}`);
    refusals.push(...input.timeConfig.map((problem) => `параметры стенда: ${problem}`));
    refusals.push(...input.recipient.map((problem) => `получатель: ${problem}`));
    if (input.balance < input.need.total) {
        refusals.push(`на кошельке ${ton(input.balance)} TON, на весь путь нужно ${ton(input.need.total)} TON: не хватает ${ton(input.need.total - input.balance)} TON`);
    }
    if (input.time?.action === 'refuse') refusals.push(`время: ${input.time.reason}`);
    return refusals;
}

/**
 * Дошла ли выплата получателю, если получатель — сам кошелёк прогона. `before` — баланс до
 * отправки заявки, `sent` — сколько к ней приложено. Кошелёк платит ещё и комиссии, а сеть
 * удерживает с получателя плату за хранение (в прогоне 13.11.2026 — 89 нанотон), поэтому
 * сверка — с допуском. Допуск обязан быть меньше суммы выплаты: иначе её не отличить от комиссий.
 */
export function payoutArrived(check: { before: bigint; after: bigint; sent: bigint; amount: bigint; tolerance: bigint }): boolean {
    if (check.tolerance >= check.amount) throw new Error('payoutArrived: допуск не меньше суммы выплаты — сверка ничего не значит');
    return check.after >= check.before - check.sent + check.amount - check.tolerance;
}
