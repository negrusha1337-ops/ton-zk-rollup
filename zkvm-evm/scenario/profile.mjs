// Профили сценария цепочки Reth (reth-scenario.mjs): суммы и состав блоков 2–3 — и расчёт
// того, сколько монет понадобится кошельку прогона такой цепочки в testnet.
//
//   node zkvm-evm/scenario/profile.mjs [default|testnet]     # состав очереди и потребность кошелька (JSON)
//
// Чистые функции: узла, ключей и файлов здесь нет. Тест — node --test zkvm-evm/scenario/profile.test.mjs.
import { pathToFileURL } from 'node:url';
//
// Профиль default — цепочка для Sandbox, как была: все случаи пропуска в блоках 2–3.
// Профиль testnet — та же цепочка, дешёвая для кошелька: место в очереди L1 стоит 0,05 TON за
// принудительную транзакцию и не возвращается, поэтому в блоках 2–3 оставлено только то, ради
// чего прогон в сети нужен. Блоки 4–15 (замеры, в сеть не идут) в обоих профилях одинаковы;
// монеты на них в профиле testnet даёт отдельный депозит в отрезке блока 4 — в testnet он не
// ставится (прогон ставит очередь только до батча 3).

export const GWEI = 1_000_000_000n;
/** Наименьший вывод через мост, нанотон. */
export const MIN_WITHDRAWAL = 50_000_000n;
/** Наименьшая сумма депозита на L2 (MIN_DEPOSIT в contracts/rollup/logic.tolk), нанотон. */
export const MIN_DEPOSIT = 50_000_000n;
/** Сколько видов негодных подписей ставит в блок 3 badSignatureCalls (reth-scenario.mjs). */
export const BAD_SIGNATURE_KINDS = 10;
/** Блоки, которые идут в testnet: батч k — блок k. */
export const PROVEN_BLOCKS = 3;

/**
 * Принудительные транзакции блоков 2 и 3, написанные в сценарии поимённо (негодные подписи —
 * отдельно: они есть в блоке 3 всегда). Род: includedWithdrawal — включена и дала лист дерева
 * выводов (сумма — её вывод, нанотон; null — задаёт профиль); included — включена, листа нет
 * (мост откатил); form — пропуск по форме; signature — по подписи; revm — по отказу revm. Сценарий сверяет
 * этот перечень со своим кодом: случай без записи здесь либо запись без случая — отказ.
 */
export const FORCED_CASES = {
    2: {
        withdrawal: { kind: 'includedWithdrawal', amount: null },
        garbage: { kind: 'form' },
        nonceHigh: { kind: 'revm' },
        duplicate: { kind: 'revm' },
        absentSender: { kind: 'revm' },
        depositedSender: { kind: 'revm' },
    },
    3: {
        notBridge: { kind: 'form' },
        blobType: { kind: 'form' },
        belowMinimum: { kind: 'included' },
        delegationType: { kind: 'form' },
        foreignChainId: { kind: 'form' },
        otherNonceHigh: { kind: 'revm' },
        noChainId: { kind: 'form' },
        highS: { kind: 'signature' },
        minimumWithdrawal: { kind: 'includedWithdrawal', amount: MIN_WITHDRAWAL },
        gasAboveCap: { kind: 'form' },
        create: { kind: 'form' },
        trailingByte: { kind: 'form' },
        lackOfFunds: { kind: 'revm' },
        priceBelowBase: { kind: 'revm' },
        priorityAboveMax: { kind: 'revm' },
        intrinsicGas: { kind: 'revm' },
        paymentOverflow: { kind: 'revm' },
        nonceOverflow: { kind: 'revm' },
        nonceLow: { kind: 'revm' },
        secondAbsentSender: { kind: 'revm' },
        starved: { kind: 'included' },
    },
};

/** Запас счёта A на газ L2 всех его транзакций блоков 2–5 (меньше 2 млн gas по 2 gwei), нанотон. */
const USER_GAS_RESERVE = 10_000_000n;

export const PROFILES = {
    default: {
        name: 'default',
        /** Депозиты счетов A и B, нанотон: что зачтётся на L2. */
        userDeposit: 3_000_000_000n,
        otherDeposit: 300_000_000n,
        /** Перевод секвенсора постороннему счёту, wei: не возвращается. */
        transferWei: 10_000_000n * GWEI,
        /** Принудительный вывод блока 2 и вывод секвенсора блока 2, нанотон. */
        forcedWithdrawal: 100_000_000n,
        sequencerWithdrawal: 250_000_000n,
        /** Сумма вызова контракта L2, который делит её на два вывода (четверть и остаток), нанотон. */
        splitterValue: 200_000_000n,
        /** Вызовы контрактов L2, после которых монеты остаются на контракте (откат кадра, DELEGATECALL), нанотон; 0 — не делать. */
        lockedCallValue: 100_000_000n,
        /** Какие принудительные случаи блоков 2 и 3 ставить в очередь; null — все. */
        keepForced: null,
        /** Депозит счёту A в отрезке блока 4: монеты на блоки замеров; 0 — не нужен. */
        topUp: 0n,
    },
    testnet: {
        name: 'testnet',
        // Счёт A: вывод секвенсора, принудительный вывод на минимум, два вывода из контракта L2,
        // плюс остаток, с которым проходят проверку баланса вызовы моста, которые мост откатит
        // (31 байт данных; сумма не в целых нанотонах), и газ.
        // 0,30 выводов + 0,05 остатка + 0,02 на газ и переводы.
        userDeposit: 370_000_000n,
        // Счёт B: транзакция с негодными подписями с настоящей подписью была бы по карману.
        otherDeposit: MIN_WITHDRAWAL + USER_GAS_RESERVE,
        transferWei: 1_000n * GWEI,
        forcedWithdrawal: MIN_WITHDRAWAL,
        sequencerWithdrawal: MIN_WITHDRAWAL,
        // Наименьшая сумма, при которой четверть — не меньше наименьшего вывода.
        splitterValue: 4n * MIN_WITHDRAWAL,
        lockedCallValue: 0n,
        // По одному пропуску каждого рода и включённый принудительный вывод; десять негодных
        // подписей идут сверх этого списка. В блоке 2 принудительных нет.
        keepForced: { 2: [], 3: ['notBridge', 'otherNonceHigh', 'minimumWithdrawal'] },
        // Блоки 7 и 12 включают 40 выводов по 0,05: у счёта A перед блоком 7 должно быть не
        // меньше, чем в профиле default (около 2,18 монеты).
        topUp: 2_200_000_000n,
    },
};

/** Профиль по имени; отказ на неизвестном. */
export function profileNamed(name) {
    const profile = PROFILES[name];
    if (!profile) throw new Error(`неизвестный профиль «${name}»: есть ${Object.keys(PROFILES).join(', ')}`);
    return profile;
}

/** Ставится ли принудительный случай `id` блока `block` в очередь при этом профиле. */
export function keepsForced(profile, block, id) {
    if (!(id in (FORCED_CASES[block] ?? {}))) throw new Error(`принудительного случая «${id}» в перечне блока ${block} нет`);
    return profile.keepForced === null || profile.keepForced[block].includes(id);
}

/** Оставленные случаи блока по порядку перечня. */
export const keptForced = (profile, block) => Object.keys(FORCED_CASES[block]).filter((id) => keepsForced(profile, block, id));

/**
 * Чем профиль негоден: пустой список — годен. Проверяется то, ради чего блок 3 идёт в пруф и в
 * сеть: включённый принудительный вывод, по пропуску каждого рода, вывод из контракта L2 (обе
 * части — не меньше наименьшего вывода), а монет счетов хватает на всё, что они тратят.
 */
export function profileProblems(profile) {
    const problems = [];
    for (const block of [2, 3]) {
        for (const id of profile.keepForced?.[block] ?? []) {
            if (!(id in FORCED_CASES[block])) problems.push(`в перечне блока ${block} нет случая «${id}»`);
        }
    }
    if (problems.length > 0) return problems;
    const kinds = keptForced(profile, 3).map((id) => FORCED_CASES[3][id].kind);
    for (const [kind, what] of [['includedWithdrawal', 'включённого принудительного вывода'], ['form', 'пропуска по форме'], ['revm', 'пропуска по отказу revm']]) {
        if (!kinds.includes(kind)) problems.push(`в блоке 3 нет ${what}`);
    }
    if (profile.splitterValue / 4n < MIN_WITHDRAWAL) problems.push('четверть суммы вызова контракта L2 меньше наименьшего вывода');
    if (profile.forcedWithdrawal < MIN_WITHDRAWAL || profile.sequencerWithdrawal < MIN_WITHDRAWAL) problems.push('вывод меньше наименьшего');
    if (profile.lockedCallValue !== 0n && profile.lockedCallValue < MIN_WITHDRAWAL) problems.push('вызов моста из контракта L2 меньше наименьшего вывода');
    if (profile.transferWei <= 0n) problems.push('перевод обязан быть ненулевым');
    for (const [name, amount] of [['A', profile.userDeposit], ['B', profile.otherDeposit]]) {
        // Ровно наименьший вывод сценарий отличает как первый депозит блока 9 (поиск по сумме).
        if (amount < MIN_DEPOSIT || amount === MIN_WITHDRAWAL) problems.push(`депозит счёта ${name} меньше наименьшего либо равен ему`);
    }
    if (profile.topUp !== 0n && (profile.topUp < MIN_DEPOSIT || profile.topUp === MIN_WITHDRAWAL)) problems.push('депозит на блоки замеров меньше наименьшего либо равен ему');
    if (profile.otherDeposit < MIN_WITHDRAWAL + USER_GAS_RESERVE) problems.push('счёту B не по карману транзакция с негодными подписями');
    const spent = userSpending(profile);
    // Сверх потраченного — остаток на вызов моста, который мост откатит: сумма обязана быть на счёте.
    if (profile.userDeposit < spent + MIN_WITHDRAWAL + USER_GAS_RESERVE) {
        problems.push(`депозита счёта A (${profile.userDeposit}) не хватает на его транзакции блоков 2–3 (${spent}), остаток и газ`);
    }
    return problems;
}

/** Сколько счёт A безвозвратно отдаёт в блоках 2–3 (выводы, переводы, вызовы контрактов L2), нанотон, с округлением вверх. */
export function userSpending(profile) {
    const withdrawn = bridgeWithdrawals(profile).reduce((total, amount) => total + amount, 0n);
    // Два перевода (блоки 2 и 3) и два вызова, оставляющие монеты на контрактах L2.
    const transfers = (2n * profile.transferWei + GWEI - 1n) / GWEI;
    return withdrawn + transfers + 2n * profile.lockedCallValue;
}

/** Листья дерева выводов блоков 2–3 по порядку: суммы, нанотон. Получатель — кошелёк прогона. */
export function bridgeWithdrawals(profile) {
    const forcedLeaves = (block) =>
        keptForced(profile, block)
            .filter((id) => FORCED_CASES[block][id].kind === 'includedWithdrawal')
            .map((id) => FORCED_CASES[block][id].amount ?? profile.forcedWithdrawal);
    return [
        // Блок 2: включённые принудительные идут первыми, затем вывод секвенсора.
        ...forcedLeaves(2), profile.sequencerWithdrawal,
        // Блок 3: включённые принудительные, затем два вывода из контракта L2 — четверть и остаток.
        ...forcedLeaves(3), profile.splitterValue / 4n, profile.splitterValue - profile.splitterValue / 4n,
    ];
}

/**
 * Очередь L1 батчей 1–3 при этом профиле: батч 1 — депозит A (в очереди при этом уже стоит и
 * депозит B), батч 2 — депозит B и принудительные блока 2, батч 3 — принудительные блока 3 и
 * негодные подписи.
 */
export function queuePlan(profile) {
    const forced = (block, count) => Array.from({ length: count }, () => ({ batch: block, kind: 'forced' }));
    return [
        { batch: 1, kind: 'deposit', amount: profile.userDeposit },
        { batch: 2, kind: 'deposit', amount: profile.otherDeposit },
        ...forced(2, keptForced(profile, 2).length),
        ...forced(3, keptForced(profile, 3).length + BAD_SIGNATURE_KINDS),
    ];
}

/**
 * Цены прогона в testnet, нанотон. Обязаны совпадать с ESTIMATED_PRICES в wrappers/testnetPlan.ts
 * (суммы сообщений — wrappers/rollupValues.ts, платы — contracts/rollup/logic.tolk): сверяет
 * tests/TestnetPlan.spec.ts, считая потребность того же состава очереди своим кодом.
 */
export const PRICES = {
    deploy: 50_000_000n,
    keyPart: 1_000_000n,
    keyFinalize: 3_000_000n,
    publishData: 1_000_000n,
    submitBatch: 72_000_000n,
    withdraw: 20_000_000n,
    evmExit: 45_000_000n,
    escapeService: 2_000_000n,
    lateDeposit: 60_000_000n,
    depositFee: 10_000_000n,
    forceTransactionFee: 50_000_000n,
    queueFeeStep: 64,
};
/** Частей ключа контракта (fixtures/evm_batches/key.json) и порций данных на батч: как у нынешней цепочки. */
export const KEY_PARTS = 12;
export const DATA_CHUNKS_PER_BATCH = 1;
/**
 * Комиссии кошелька, оценка сверху: дважды плата по размеру тел частей ключа и трёх батчей
 * (0,24 и 0,10 TON по нынешним фикстурам — от цепочки размеры не зависят) и 0,004 TON на
 * каждое сообщение. Точнее считает скрипт прогона по настоящим телам (режим check).
 */
export const WALLET_FEES_FIXED = 340_000_000n;
export const WALLET_FEE_PER_MESSAGE = 4_000_000n;

/**
 * Потребность кошелька прогона батчей 1–3 в testnet: что уйдёт, что вернётся (выводы через мост,
 * аварийные выходы обоих счетов против блока 3, поздний депозит) и что нет. Остаток счёта A после
 * блока 3 оценён снизу (весь запас на газ считается потраченным).
 */
export function walletNeed(profile, prices = PRICES) {
    const queue = queuePlan(profile);
    // Плата за место — как в контракте: удваивается на каждые queueFeeStep необработанных
    // элементов. Перед батчем 1 в очереди оба депозита, обрабатывает он один; батчи 2 и 3
    // принимаются после своих элементов и обрабатывают всё.
    let [head, processed, depositFees, forcedFees] = [0, 0, 0n, 0n];
    const enqueue = (items) => {
        for (const item of items) {
            const doublings = BigInt(Math.floor((head - processed) / prices.queueFeeStep));
            if (item.kind === 'deposit') depositFees += prices.depositFee << doublings;
            else forcedFees += prices.forceTransactionFee << doublings;
            head += 1;
        }
    };
    enqueue(queue.slice(0, 2));
    processed = 1;
    enqueue(queue.slice(2).filter((item) => item.batch === 2));
    processed = head;
    enqueue(queue.filter((item) => item.batch === 3));
    const deposited = profile.userDeposit + profile.otherDeposit;
    const leaves = bridgeWithdrawals(profile);
    const withdrawn = leaves.reduce((total, amount) => total + amount, 0n);
    const userLeft = profile.userDeposit - userSpending(profile) - USER_GAS_RESERVE;
    const exited = userLeft + profile.otherDeposit;
    const forcedCount = queue.filter((item) => item.kind === 'forced').length;
    const messages = KEY_PARTS + 2 + queue.length + PROVEN_BLOCKS * DATA_CHUNKS_PER_BATCH + PROVEN_BLOCKS + leaves.length + 1 + 2 + 2;
    const walletFees = WALLET_FEES_FIXED + BigInt(messages) * WALLET_FEE_PER_MESSAGE;
    const fixed =
        prices.deploy + BigInt(KEY_PARTS) * prices.keyPart + prices.keyFinalize +
        BigInt(PROVEN_BLOCKS * DATA_CHUNKS_PER_BATCH) * prices.publishData + BigInt(PROVEN_BLOCKS) * prices.submitBatch +
        BigInt(leaves.length) * prices.withdraw + prices.lateDeposit + 2n * prices.escapeService + 2n * prices.evmExit;
    const total = fixed + deposited + depositFees + forcedFees + walletFees;
    const returns = withdrawn + exited + prices.lateDeposit - prices.depositFee;
    return {
        profile: profile.name, messages, queueItems: queue.length, forcedItems: forcedCount,
        deposited, depositFees, forcedFees, fixed, walletFees, withdrawn, exitedAtLeast: exited,
        total, returns, lost: total - returns,
    };
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    const profile = profileNamed(process.argv[2] ?? 'default');
    const text = (value) => JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
    console.log(text({ problems: profileProblems(profile), queue: queuePlan(profile), withdrawals: bridgeWithdrawals(profile), need: walletNeed(profile) }));
}
