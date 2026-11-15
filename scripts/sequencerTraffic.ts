import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { Address, beginCell, fromNano, OpenedContract, toNano } from '@ton/core';
import { NetworkProvider, sleep, UIProvider } from '@ton/blueprint';
import { BASE_DEPOSIT_FEE, Rollup } from '../wrappers/Rollup';
import { RollupNullifier } from '../wrappers/RollupNullifier';
import { depositHash, forcedTransactionCell, forcedTransactionHash } from '../wrappers/rollupMath';
import { ESCAPE_SERVICE_VALUE, FORCE_TRANSACTION_VALUE } from '../wrappers/rollupValues';
import { assertTestnetWithMnemonic } from '../wrappers/testnetGuard';
import {
    BASE_FORCE_TRANSACTION_FEE,
    estimateWalletFees,
    ForwardPrices,
    payoutArrived,
    QUEUE_FEE_MAX_DOUBLINGS,
    trafficCosts,
    trafficPlan,
    TrafficPrices,
} from '../wrappers/testnetPlan';
import { accountOf, DEFAULT_TRAFFIC_DIR, loadL2Keys, newL2Account, signBridgeWithdrawal, storeL2Key } from '../sequencer/l2Keys';
import { writeAtomically } from '../sequencer/state';
import { claimProofCell, recipientHashOf, withdrawalClaims, WithdrawalsMismatch } from '../sequencer/withdrawals';
import { assertNotServiceWallet, passToncenterKey, TrafficRefused, withRetries } from '../sequencer/trafficSafety';

// Нагрузка на сервис-секвенсор в testnet: очередь L1 контракта получает депозиты на новые счета
// L2 и принудительные выводы с них через мост, а выводы, попавшие в принятые батчи, забираются на
// L1 сообщением Withdraw по Merkle-доказательству (sequencer/withdrawals.ts — по отчётам блоков
// сервиса, сверенным с контрактом). Кошелёк — кошелёк прогонов (WALLET_MNEMONIC в .env, Blueprint
// загружает его сам), НЕ кошелёк сервиса: у них общий seqno был бы гонкой. Отказ во всех режимах
// (и report, и settle), если кошелёк нагрузки — секвенсор контракта или адрес из SEQUENCER_MNEMONIC
// (круг 23, пункт 1). TONCENTER_API_KEY из .env вписывается в клиент Blueprint (passToncenterKey).
//
//   npx blueprint run sequencerTraffic --testnet --mnemonic <адрес контракта> [check | report | settle]
//       [interval=<с>] [duration=<с>] [budget=<TON>] [deposit=<TON>] [withdraw=<TON>]
//       [withdrawEvery=<k>] [drain=<с>] [stateDir=<каталог сервиса>] [trafficDir=<каталог>]
//       [retryPause=<с>] [maxFailures=<n>]
//
// Раз в interval секунд (3600) — одно действие: принудительный вывод withdraw TON (0,05) со
// счёта, чей депозит уже обработан, если такой есть и прошлое действие было депозитом; иначе
// депозит deposit TON (0,06) на новый счёт L2. Ключ хранится (keys.json, права 600) только у
// каждого withdrawEvery-го счёта (1 — у всех; 0 — выводов нет): без ключа вывод не подписать. У
// остальных в журнале только адрес. Новые действия — пока не истекло duration (86400) с начала
// нагрузки и не исчерпан budget (2 TON); затем до drain секунд (7200) — только ожидание обработки и
// выплаты. Вместе с паузами между действиями забираются выводы на этот кошелёк.
//
// Сбой шага (toncenter, сеть, «не дождался») не роняет нагрузку: строка журнала, пауза retryPause
// (60 с) и повтор; подряд maxFailures (10) — выход с текстом. Защиты (чужой кошелёк, бюджет) —
// выход сразу. Свой элемент очереди ищется по хешу в окне после отметки, а не по ожидаемому
// номеру: чужой элемент мог встать между чтением головы и постановкой.
//
// Режимы: check — план по бюджету и проверки, ничего не отправляет; report — сводка по журналу и
// контракту, ничего не отправляет и журнал НЕ пишет (можно во время run); settle — без новых элементов: забрать выводы на этот кошелёк,
// а если rollup заморожен, вернуть необработанные депозиты нагрузки (CancelDeposit по квитанциям).
// Балансы счетов L2 (депозит минус вывод) после заморозки этим скриптом не вернуть: выход счёта
// EVM требует доказательства счёта от узла сервиса (ForceExitEvm) — на стенде это потеря. Журнал (возобновление, сводка) —
// <trafficDir>/journal-<адрес>.json; запуск после остановки продолжает с него.

const POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 3000;
const ton = (nano: bigint) => `${fromNano(nano)} TON`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

type Options = {
    mode: 'run' | 'check' | 'report' | 'settle';
    address: Address;
    interval: number;
    duration: number;
    drain: number;
    budget: bigint;
    deposit: bigint;
    withdraw: bigint;
    withdrawEvery: number;
    stateDir: string;
    trafficDir: string;
    retryPause: number;
    maxFailures: number;
};

/** Элемент очереди, поставленный нагрузкой. `number` — номер в очереди L1; null — ещё не найден. */
type Item = {
    kind: 'deposit' | 'withdrawal';
    l2Address: string;
    /** Депозит: сумма на L2 при плате из расчёта; вывод: сумма вывода. */
    amountNano: string;
    valueNano: string;
    status: 'sent' | 'queued' | 'lost';
    prev: { count: string; hash: string };
    /** Вывод: байты транзакции (hex) — по ним хеш очереди. */
    bytes?: string;
    keyStored?: boolean;
    number: number | null;
    sentAt: number;
    queuedAt: number | null;
    processedSeenAt: number | null;
};

type Claim = { leafIndex: number; amountNano: string; status: 'sent' | 'paid' | 'owed'; sentAt: number; paidAt: number | null };

type Journal = { rollup: string; startedAt: number; spentNano: string; returnedNano: string; items: Item[]; claims: Claim[]; summary?: object };

type Run = {
    provider: NetworkProvider;
    ui: UIProvider;
    rollup: OpenedContract<Rollup>;
    wallet: Address;
    options: Options;
    journal: Journal;
    file: string;
    chainId: bigint;
    /** report: журнал не пишется (run может идти параллельно). */
    readOnly: boolean;
};

function parseOptions(args: string[]): Options {
    const named = new Map<string, string>();
    let mode: Options['mode'] = 'run';
    let address: Address | null = null;
    for (const arg of args) {
        if (arg === 'check' || arg === 'report' || arg === 'settle') mode = arg;
        else if (arg.includes('=')) {
            const [name, value] = arg.split('=', 2);
            named.set(name, value);
        } else if (address === null && Address.isFriendly(arg)) address = Address.parse(arg);
        else throw new Error(`Непонятный аргумент «${arg}»: см. комментарий в начале scripts/sequencerTraffic.ts.`);
    }
    const known = ['interval', 'duration', 'drain', 'budget', 'deposit', 'withdraw', 'withdrawEvery', 'stateDir', 'trafficDir', 'retryPause', 'maxFailures'];
    for (const name of named.keys()) if (!known.includes(name)) throw new Error(`Непонятный параметр ${name}: см. комментарий в начале scripts/sequencerTraffic.ts.`);
    if (!address) throw new Error('Нужен адрес контракта (тот, что напечатал sequencer/main.ts deploy).');
    const int = (name: string, fallback: number) => {
        const value = named.get(name);
        if (value === undefined) return fallback;
        if (!/^\d+$/.test(value)) throw new Error(`Параметр ${name} — целое число, получено «${value}».`);
        return Number(value);
    };
    const coins = (name: string, fallback: string) => {
        const value = named.get(name) ?? fallback;
        if (!/^\d+(\.\d{1,9})?$/.test(value)) throw new Error(`Параметр ${name} — сумма в TON, получено «${value}».`);
        return toNano(value);
    };
    return {
        mode,
        address,
        interval: int('interval', 3600),
        duration: int('duration', 86400),
        drain: int('drain', 7200),
        budget: coins('budget', '2'),
        deposit: coins('deposit', '0.06'),
        withdraw: coins('withdraw', '0.05'),
        withdrawEvery: int('withdrawEvery', 1),
        stateDir: path.resolve(named.get('stateDir') ?? path.join(__dirname, '..', '.tools', 'sequencer')),
        trafficDir: path.resolve(named.get('trafficDir') ?? DEFAULT_TRAFFIC_DIR),
        retryPause: int('retryPause', 60),
        maxFailures: Math.max(1, int('maxFailures', 10)),
    };
}

/** Не дождался; `lastError` — ошибка последнего опроса (пусто — опрос прошёл, условия нет). */
class WaitTimeout extends Error {
    constructor(message: string, readonly lastError: string) {
        super(message);
    }
}

async function waitFor(description: string, check: () => Promise<boolean>) {
    let lastError = '';
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_DELAY_MS);
        try {
            if (await check()) return;
            lastError = '';
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    throw new WaitTimeout(`Не дождался: ${description}.${lastError ? ` Последняя ошибка запроса: ${lastError}.` : ''} Запусти скрипт ещё раз: он продолжит по журналу.`, lastError);
}

const save = (run: Run) => {
    if (!run.readOnly) writeAtomically(run.file, JSON.stringify(run.journal, null, 1) + '\n');
};
const spend = (run: Run, nano: bigint) => (run.journal.spentNano = (BigInt(run.journal.spentNano) + nano).toString());

/** Комиссия кошелька за сообщение с таким телом (оценка сверху, testnetPlan.ts). */
const walletFeeOf = (forward: ForwardPrices, body = beginCell().endCell()) => estimateWalletFees([body], 0, forward);

/** Сколько элементов после отметки `prev` просматривать в поисках своего (чужие могли встать раньше). */
const LOCATE_WINDOW = 64n;

/** Хеши очереди после элемента, если перед ним хеш `before`: так его поставил бы этот элемент журнала. */
function hashesAfter(item: Item, before: bigint): bigint[] {
    return item.kind === 'withdrawal'
        ? [forcedTransactionHash(before, Buffer.from(item.bytes!, 'hex'))]
        : // Плата могла упасть между чтением и постановкой (батч обработал хвост): сумма на L2 — value минус плата.
          Array.from({ length: QUEUE_FEE_MAX_DOUBLINGS + 1 }, (_, d) => depositHash(before, BigInt(item.l2Address), BigInt(item.valueNano) - (BASE_DEPOSIT_FEE << BigInt(d))));
}

/**
 * Номер элемента в очереди: первый номер n после отметки `prev` (в окне LOCATE_WINDOW), у которого
 * хеш после n — тот, что дал бы этот элемент поверх хеша до n (круг 23, пункт 3: чужой элемент
 * мог встать между чтением головы и постановкой). null — ещё не видно; 'foreign' — окно занято
 * чужими или записи очереди уже нет (сверить нечем).
 */
async function locate(run: Run, item: Item): Promise<number | null | 'foreign'> {
    const prev = { count: BigInt(item.prev.count), hash: BigInt(item.prev.hash) };
    const queue = await run.rollup.getDepositQueue();
    if (queue.head.count <= prev.count) return null;
    const last = queue.head.count < prev.count + LOCATE_WINDOW ? queue.head.count : prev.count + LOCATE_WINDOW;
    let before = prev.hash;
    for (let number = prev.count + 1n; number <= last; number++) {
        const after = number === queue.head.count ? queue.head.hash : (await run.rollup.getQueueItem(number + 1n))?.hashBefore;
        if (after === undefined) return 'foreign';
        if (hashesAfter(item, before).includes(after)) return Number(number);
        before = after;
    }
    return last === prev.count + LOCATE_WINDOW ? 'foreign' : null;
}

/** Дождаться, пока отправленный элемент встанет в очередь, и записать его номер и время постановки. */
async function confirm(run: Run, item: Item, patient: boolean) {
    let found: number | null | 'foreign' = null;
    const check = async () => {
        found = await locate(run, item);
        // Окно занято чужими сейчас — но свой мог ещё не дойти: ждать до конца опроса.
        return found !== null && found !== 'foreign';
    };
    try {
        await waitFor(`элемент очереди (${item.kind}, ${item.l2Address})`, check);
    } catch (error) {
        // Последний опрос не прошёл (toncenter): «не найден» не доказан — сбой шага, не «потерян».
        if (patient || (error instanceof WaitTimeout && error.lastError !== '')) throw error;
    }
    if (found === null || found === 'foreign') {
        item.status = 'lost';
        run.ui.write(
            found === 'foreign'
                ? `ВНИМАНИЕ: после отметки ${item.prev.count} в окне ${LOCATE_WINDOW} элементов — только чужие: ${item.kind} ${item.l2Address} не опознан (в сводке — «не найден»)`
                : `ВНИМАНИЕ: ${item.kind} ${item.l2Address} в очереди не появился (в обозревателе: 7326 — плата выросла, 7307 — мало монет, 7312 — заморожен)`,
        );
    } else {
        item.number = found;
        item.status = 'queued';
        item.queuedAt = (await run.rollup.getQueueItem(found))?.queuedAt ?? nowSeconds();
        run.ui.write(`Очередь L1, элемент ${found}: ${item.kind === 'deposit' ? 'депозит' : 'принудительный вывод'} ${ton(BigInt(item.amountNano))} (${item.l2Address})`);
    }
    save(run);
}

async function deposit(run: Run, prices: TrafficPrices, forward: ForwardPrices) {
    const account = newL2Account();
    const deposits = run.journal.items.filter((item) => item.kind === 'deposit').length + 1;
    const keyStored = run.options.withdrawEvery > 0 && deposits % run.options.withdrawEvery === 0;
    // Ключ — на диск ДО отправки: иначе сбой после неё оставил бы монеты на счёте, вывести которые нечем.
    if (keyStored)
        storeL2Key(path.join(run.options.trafficDir, 'keys.json'), {
            address: account.address, secret: account.secret.toString('hex'), rollup: run.rollup.address.toString(), createdAt: new Date().toISOString(),
        });
    const head = (await run.rollup.getDepositQueue()).head;
    const value = prices.depositAmount + prices.depositFee;
    const item: Item = {
        kind: 'deposit', l2Address: account.address, amountNano: prices.depositAmount.toString(), valueNano: value.toString(), status: 'sent',
        prev: { count: head.count.toString(), hash: head.hash.toString() }, keyStored, number: null, sentAt: nowSeconds(), queuedAt: null, processedSeenAt: null,
    };
    run.journal.items.push(item);
    spend(run, value + walletFeeOf(forward));
    save(run);
    await run.rollup.sendDeposit(run.provider.sender(), { l2Recipient: BigInt(account.address), value, maxFee: prices.depositFee });
    await confirm(run, item, true);
}

async function forcedWithdrawal(run: Run, from: Item, prices: TrafficPrices, forward: ForwardPrices) {
    const stored = loadL2Keys(path.join(run.options.trafficDir, 'keys.json')).find((key) => key.address === from.l2Address);
    if (!stored) throw new Error(`ключа счёта ${from.l2Address} нет в keys.json: вывод не подписать`);
    // Каждый счёт выводит один раз: nonce 0 и никакого учёта исходов прежних транзакций.
    const bytes = signBridgeWithdrawal(accountOf(stored), { chainId: run.chainId, nonce: 0, amountNano: prices.withdrawAmount, recipientHash: recipientHashOf(run.wallet) });
    const head = (await run.rollup.getDepositQueue()).head;
    const item: Item = {
        kind: 'withdrawal', l2Address: from.l2Address, amountNano: prices.withdrawAmount.toString(), valueNano: prices.forceValue.toString(), status: 'sent',
        prev: { count: head.count.toString(), hash: head.hash.toString() }, bytes: bytes.toString('hex'), number: null, sentAt: nowSeconds(), queuedAt: null, processedSeenAt: null,
    };
    const cell = forcedTransactionCell(bytes);
    run.journal.items.push(item);
    spend(run, prices.forceValue + walletFeeOf(forward, cell));
    save(run);
    await run.rollup.sendForceTransaction(run.provider.sender(), { l2Transaction: cell, value: prices.forceValue });
    await confirm(run, item, true);
}

/** Отметить обработанные контрактом элементы (время — по опросу). */
async function observe(run: Run): Promise<{ processed: number; head: number; batchIndex: number }> {
    const [queue, state] = [await run.rollup.getDepositQueue(), await run.rollup.getRollupState()];
    const processed = Number(queue.processed.count);
    for (const item of run.journal.items)
        if (item.number !== null && item.number <= processed && item.processedSeenAt === null) item.processedSeenAt = nowSeconds();
    save(run);
    return { processed, head: Number(queue.head.count), batchIndex: state.batchIndex };
}

/** Забрать выводы на этот кошелёк из принятых батчей: Withdraw, пометка нуллификатора, выплата. */
async function claimPayouts(run: Run, minimumValue: bigint, forward: ForwardPrices, send: boolean) {
    let claims;
    try {
        claims = withdrawalClaims(run.options.stateDir, await run.rollup.getRollupState());
    } catch (error) {
        if (!(error instanceof WithdrawalsMismatch)) throw error;
        run.ui.write(`Выводы не забрать: ${error.message}`);
        return;
    }
    const mine = recipientHashOf(run.wallet);
    for (const claim of claims.filter((leaf) => leaf.recipientHash === mine)) {
        const recorded = run.journal.claims.find((entry) => entry.leafIndex === claim.leafIndex);
        if (recorded && recorded.status !== 'sent') continue;
        const nullifier = await run.rollup.getNullifierAddress(claim.leafIndex);
        const claimed = async () => (await run.provider.isContractDeployed(nullifier)) && (await run.provider.open(RollupNullifier.createFromAddress(nullifier)).getIsClaimed());
        const owed = async () => (await run.rollup.getOwedPayout(BigInt(claim.leafIndex))) !== null;
        if (await claimed()) {
            const entry = recorded ?? { leafIndex: claim.leafIndex, amountNano: claim.amount.toString(), status: 'sent' as const, sentAt: nowSeconds(), paidAt: null };
            entry.status = (await owed()) ? 'owed' : 'paid';
            entry.paidAt ??= nowSeconds();
            if (!recorded) run.journal.claims.push(entry);
            save(run);
            continue;
        }
        if (!send) continue;
        const before = (await run.provider.getContractState(run.wallet)).balance;
        const entry: Claim = recorded ?? { leafIndex: claim.leafIndex, amountNano: claim.amount.toString(), status: 'sent', sentAt: nowSeconds(), paidAt: null };
        if (!recorded) run.journal.claims.push(entry);
        const proof = claimProofCell(claim);
        spend(run, minimumValue + walletFeeOf(forward, proof));
        save(run);
        run.ui.write(`Вывод через мост, лист ${claim.leafIndex}: ${ton(claim.amount)}`);
        await run.rollup.sendWithdraw(run.provider.sender(), { leafIndex: claim.leafIndex, recipient: run.wallet, amount: claim.amount, merkleProof: proof, value: minimumValue });
        await waitFor(`лист ${claim.leafIndex} погашен (7308 — доказательство, 7203 — мало монет у нуллификатора)`, claimed);
        const tolerance = claim.amount / 2n < 20_000_000n ? claim.amount / 2n : 20_000_000n;
        let indebted = false;
        await waitFor(`выплата по листу ${claim.leafIndex}`, async () => {
            indebted = await owed();
            return indebted || payoutArrived({ before, after: (await run.provider.getContractState(run.wallet)).balance, sent: minimumValue, amount: claim.amount, tolerance });
        });
        entry.status = indebted ? 'owed' : 'paid';
        entry.paidAt = nowSeconds();
        if (!indebted) run.journal.returnedNano = (BigInt(run.journal.returnedNano) + claim.amount).toString();
        save(run);
    }
}

/** После заморозки: вернуть депозиты нагрузки, не попавшие в батч (по квитанциям контракта). */
async function refundDeposits(run: Run, forward: ForwardPrices) {
    const processed = Number((await run.rollup.getDepositQueue()).processed.count);
    for (const item of run.journal.items.filter((entry) => entry.kind === 'deposit' && entry.number !== null && entry.number > processed)) {
        const receipt = await run.rollup.getDepositReceipt(item.number!);
        if (receipt === null || !receipt.depositor.equals(run.wallet)) continue;
        run.ui.write(`Возврат необработанного депозита №${item.number}: ${ton(receipt.amount)}`);
        spend(run, ESCAPE_SERVICE_VALUE + walletFeeOf(forward));
        save(run);
        await run.rollup.sendCancelDeposit(run.provider.sender(), { depositIndex: item.number!, value: ESCAPE_SERVICE_VALUE });
        await waitFor(`депозит №${item.number} возвращён (7320 — контракту не хватило баланса)`, async () => (await run.rollup.getDepositReceipt(item.number!)) === null);
        run.journal.returnedNano = (BigInt(run.journal.returnedNano) + receipt.amount).toString();
        save(run);
    }
}

/** Счёт с обработанным депозитом и ключом, с которого ещё не выводили. */
function withdrawable(run: Run, processed: number): Item | null {
    const used = new Set(run.journal.items.filter((item) => item.kind === 'withdrawal').map((item) => item.l2Address));
    return run.journal.items.find((item) => item.kind === 'deposit' && item.keyStored && item.number !== null && item.number <= processed && !used.has(item.l2Address)) ?? null;
}

/** Сводка: поставлено, обработано, задержки, выводы и выплаты. */
function summary(run: Run, marks: { processed: number; head: number; batchIndex: number }) {
    const { items, claims } = run.journal;
    const queued = items.filter((item) => item.number !== null);
    const processed = queued.filter((item) => item.number! <= marks.processed);
    const delays = processed.map((item) => ({ number: item.number!, kind: item.kind, delaySeconds: (item.processedSeenAt ?? nowSeconds()) - item.queuedAt! }));
    const sum = (values: string[]) => values.reduce((total, value) => total + BigInt(value), 0n);
    const result = {
        at: new Date().toISOString(),
        contract: { batchIndex: marks.batchIndex, queueHead: marks.head, queueProcessed: marks.processed },
        deposits: { queued: queued.filter((item) => item.kind === 'deposit').length, amountNano: sum(queued.filter((item) => item.kind === 'deposit').map((item) => item.amountNano)).toString() },
        withdrawals: { queued: queued.filter((item) => item.kind === 'withdrawal').length },
        lost: items.filter((item) => item.status === 'lost').length,
        processed: processed.length,
        pending: queued.length - processed.length,
        delaysSeconds: delays,
        payouts: { paid: claims.filter((claim) => claim.status === 'paid').length, owed: claims.filter((claim) => claim.status === 'owed').length, unpaid: claims.filter((claim) => claim.status === 'sent').length, amountNano: sum(claims.filter((claim) => claim.status === 'paid').map((claim) => claim.amountNano)).toString() },
        spentNano: run.journal.spentNano,
        returnedNano: run.journal.returnedNano,
    };
    run.journal.summary = result;
    save(run);
    const { ui } = run;
    ui.write(`Сводка (${run.file}):`);
    ui.write(`  контракт: батчей ${marks.batchIndex}, очередь L1 — поставлено ${marks.head}, обработано ${marks.processed}`);
    ui.write(`  нагрузка: депозитов ${result.deposits.queued} (${ton(BigInt(result.deposits.amountNano))} на L2), выводов ${result.withdrawals.queued}, не найдено в очереди ${result.lost}`);
    ui.write(`  обработано контрактом ${processed.length} из ${queued.length}; ждут ${result.pending}`);
    for (const delay of delays) ui.write(`    элемент ${delay.number} (${delay.kind}): от постановки до батча ${delay.delaySeconds} с (по опросу; точно — zk/sequencer-run-report.mjs)`);
    ui.write(`  выплаты по выводам: выплачено ${result.payouts.paid} (${ton(BigInt(result.payouts.amountNano))}), долг ${result.payouts.owed}, в пути ${result.payouts.unpaid}`);
    ui.write(`  потрачено (оценка, с комиссиями) ${ton(BigInt(run.journal.spentNano))}, вернулось ${ton(BigInt(run.journal.returnedNano))}`);
}

export async function run(provider: NetworkProvider, args: string[]) {
    assertTestnetWithMnemonic(provider);
    const ui = provider.ui();
    const options = parseOptions(args);
    const wallet = provider.sender().address;
    if (!wallet) throw new Error('У отправителя нет адреса: подключи кошелёк.');
    const key = passToncenterKey(provider as { api?: () => unknown }, process.env.TONCENTER_API_KEY);
    if (key === 'passed') ui.write('Ключ API toncenter (TONCENTER_API_KEY) передан клиенту Blueprint.');
    if (key === 'unsupported') ui.write('ВНИМАНИЕ: TONCENTER_API_KEY задан, но клиенту Blueprint его не передать — запросы без ключа (1 в секунду).');
    const rollup = provider.open(Rollup.createFromAddress(options.address));
    if (!(await provider.isContractDeployed(rollup.address))) throw new Error(`По адресу ${rollup.address.toString()} контракта нет: сначала sequencer/main.ts deploy.`);
    const [deployment, keyHash, escape, fees, budgets, minimum] = [
        await rollup.getDeployment(), await rollup.getKeyHash(), await rollup.getEscapeState(),
        await rollup.getQueueFees(), await rollup.getQueueBudgets(), await rollup.getMinimumValues(),
    ];
    // Во всех режимах, и в report и settle: они тоже шлют (settle) или пишут сводку о «своих» выводах.
    await assertNotServiceWallet(wallet, deployment.sequencer);
    const forward: ForwardPrices = JSON.parse(readFileSync(path.join(__dirname, '..', 'bench', 'network-config.json'), 'utf8')).basechain.forward;
    const prices: TrafficPrices = {
        depositAmount: options.deposit,
        depositFee: fees.depositFee,
        withdrawAmount: options.withdraw,
        // Плата за место — текущая (растёт с хвостом очереди), газ постановки — как в rollupValues.ts.
        forceValue: fees.forceTransactionFee + (FORCE_TRANSACTION_VALUE - BASE_FORCE_TRANSACTION_FEE),
        withdrawValue: minimum.withdraw,
        walletFee: walletFeeOf(forward, forcedTransactionCell(Buffer.alloc(160))),
    };
    const plan = trafficPlan({ interval: options.interval, duration: options.duration, budget: options.budget, withdrawEvery: options.withdrawEvery, prices });
    const costs = trafficCosts(prices);
    const balance = (await provider.getContractState(wallet)).balance;
    ui.write(`Нагрузка на rollup ${rollup.address.toString()} (секвенсор ${deployment.sequencer.toString()}), кошелёк нагрузки ${wallet.toString()}: ${ton(balance)}`);
    ui.write(`  депозит ${ton(costs.deposit)} (на L2 ${ton(prices.depositAmount)}, плата ${ton(prices.depositFee)}); вывод с выплатой ${ton(costs.withdrawal)} (вернётся ${ton(prices.withdrawAmount)})`);
    ui.write(
        `  план на ${options.duration} с, действие раз в ${options.interval} с: депозитов ${plan.deposits}, выводов ${plan.withdrawals}; уйдёт ${ton(plan.spend)}, вернётся ${ton(plan.returns)}, ` +
            `не вернётся ${ton(plan.lost)}${plan.truncated ? ' — бюджет кончится раньше срока' : ''}`,
    );
    const refusals = [...plan.problems];
    if (keyHash === 0n) refusals.push('ключ контракта не зафиксирован: очередь не принимает элементы');
    if (escape.frozen) refusals.push('rollup заморожен: очередь закрыта');
    if (fees.depositFee !== BASE_DEPOSIT_FEE) refusals.push(`плата за место уже удвоена (${ton(fees.depositFee)}): очередь перегружена, сервис отстаёт`);
    if (options.mode === 'run' && balance < options.budget) refusals.push(`на кошельке ${ton(balance)}, бюджет ${ton(options.budget)}: не хватает ${ton(options.budget - balance)}`);
    if ((options.mode === 'run' || options.mode === 'check') && refusals.length > 0) throw new TrafficRefused(`Нагрузка не начата, ничего не отправлено:\n  - ${refusals.join('\n  - ')}`);
    if (options.mode === 'check') {
        ui.write('Проверки пройдены. Режим check: ничего не отправлено.');
        return;
    }

    const readOnly = options.mode === 'report';
    if (!readOnly) mkdirSync(options.trafficDir, { recursive: true, mode: 0o700 });
    const file = path.join(options.trafficDir, `journal-${rollup.address.toRawString().replace(':', '_')}.json`);
    const journal: Journal = existsSync(file)
        ? JSON.parse(readFileSync(file, 'utf8'))
        : { rollup: rollup.address.toRawString(), startedAt: nowSeconds(), spentNano: '0', returnedNano: '0', items: [], claims: [] };
    if (journal.rollup !== rollup.address.toRawString()) throw new Error(`${file} — журнал другого контракта (${journal.rollup})`);
    const context: Run = { provider, ui, rollup, wallet, options, journal, file, chainId: deployment.chainId, readOnly };
    if (options.mode === 'settle') {
        for (const item of journal.items.filter((entry) => entry.status === 'sent')) await confirm(context, item, false);
        await claimPayouts(context, minimum.withdraw, forward, true);
        if ((await rollup.getEscapeState()).frozen) await refundDeposits(context, forward);
        else ui.write('rollup не заморожен: необработанные депозиты обработает сервис (возврат — только после заморозки)');
        summary(context, await observe(context));
        return;
    }
    if (options.mode === 'report') {
        // Только чтение: журнал не пишется — run мог идти параллельно и писать его сам.
        await claimPayouts(context, minimum.withdraw, forward, false);
        summary(context, await observe(context));
        ui.write('Режим report: ничего не отправлено, журнал не изменён.');
        return;
    }
    // Каждый шаг — с повтором после сбоя (круг 23, пункт 3); защиты — выход сразу.
    const retrying = <T>(what: string, step: () => Promise<T>) =>
        withRetries(what, step, { maxFailures: options.maxFailures, pauseSeconds: options.retryPause, sleep: async (ms) => void (await sleep(ms)), log: (line) => ui.write(line) });
    // Отправленное раньше, но не подтверждённое: найти в очереди (без повтора отправки).
    const confirmSent = async () => {
        for (const item of journal.items.filter((entry) => entry.status === 'sent')) await confirm(context, item, false);
    };
    await retrying('подтверждение отправленного', confirmSent);

    for (;;) {
        const decision = await retrying('подготовка действия', async () => {
            await confirmSent();
            const marks = await observe(context);
            await claimPayouts(context, minimum.withdraw, forward, true);
            if (nowSeconds() >= journal.startedAt + options.duration) return 'done' as const;
            const lastWasDeposit = journal.items.length > 0 && journal.items[journal.items.length - 1].kind === 'deposit';
            const from = lastWasDeposit ? withdrawable(context, marks.processed) : null;
            const cost = from ? costs.withdrawal : costs.deposit;
            if (BigInt(journal.spentNano) + cost > options.budget) {
                ui.write(`Бюджет исчерпан: потрачено ${ton(BigInt(journal.spentNano))} из ${ton(options.budget)}`);
                return 'done' as const;
            }
            const current = await rollup.getQueueFees();
            if (current.depositFee !== prices.depositFee || current.forceTransactionFee !== fees.forceTransactionFee) {
                ui.write(`Плата за место выросла (${ton(current.depositFee)} / ${ton(current.forceTransactionFee)}): очередь перегружена — новых элементов не ставлю`);
                return 'done' as const;
            }
            return { from };
        });
        if (decision === 'done') break;
        // Отправка — один раз за действие: повтор после сбоя только дожидается отправленного
        // (найден — поставлен, нет — «не найден»), второго элемента не ставит.
        let attempted = false;
        await retrying('действие нагрузки', async () => {
            if (attempted) return confirmSent();
            attempted = true;
            if (decision.from) await forcedWithdrawal(context, decision.from, prices, forward);
            else await deposit(context, prices, forward);
        });
        await sleep(options.interval * 1000);
    }
    // Ожидание обработки и выплат: не дольше drain секунд.
    const drainUntil = nowSeconds() + options.drain;
    for (;;) {
        const waiting = await retrying('ожидание обработки', async () => {
            await confirmSent();
            const marks = await observe(context);
            await claimPayouts(context, minimum.withdraw, forward, true);
            return journal.items.some((item) => item.number !== null && item.number > marks.processed) || journal.claims.some((claim) => claim.status === 'sent');
        });
        if (!waiting || nowSeconds() >= drainUntil) break;
        await sleep(Math.min(options.interval, 300) * 1000);
    }
    summary(context, await retrying('сводка', () => observe(context)));
    ui.write(`Готово. Отчёт по сети: node zk/sequencer-run-report.mjs ${rollup.address.toString()}`);
}
