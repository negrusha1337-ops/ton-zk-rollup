// Отчёт о прогоне сервиса-секвенсора в testnet (TESTNET.md, «Секвенсор как сервис»): по
// транзакциям rollup-контракта из toncenter v3 — батчи (газ, время между батчами, возраст блока
// при приёме, сколько элементов очереди L1 в каждом), задержка обработки каждого элемента очереди
// (от его постановки до батча, который его обработал), отказы контракта, выплаты.
//
//   node zk/sequencer-run-report.mjs <адрес контракта> [--out=<файл>]
//
// Только чтение публичного API testnet; ничего не отправляет. TONCENTER_API_KEY — по желанию
// (без него — запрос в секунду). Результат — bench/testnet-sequencer-run.json (или --out).
//
// Номер элемента очереди — порядок успешных транзакций DepositTon и ForceTransaction контракта по
// lt (так их нумерует сам контракт: неуспешная постановка элемента не создаёт). Сколько элементов
// обработал батч — отметка queueProcessedUpTo из тела SubmitBatch минус отметка прежнего батча.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cell } from '@ton/core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://testnet.toncenter.com/api/v3';
const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const outArg = process.argv.slice(2).find((arg) => arg.startsWith('--out='));
const unknown = process.argv.slice(2).filter((arg) => arg.startsWith('--') && !arg.startsWith('--out='));
if (positional.length !== 1 || unknown.length > 0) {
    console.error('Использование: node zk/sequencer-run-report.mjs <адрес контракта> [--out=<файл>]');
    process.exit(1);
}
const address = positional[0];
const out = path.resolve(outArg ? outArg.slice('--out='.length) : path.join(ROOT, 'bench', 'testnet-sequencer-run.json'));
// Опкоды сообщений: wrappers/Rollup.ts и wrappers/Bn254Groth16Verifier.ts.
const STEPS = {
    '0x42543235': 'keyPart',
    '0x42543236': 'keyFinalize',
    '0x52420001': 'submitBatch',
    '0x52420002': 'deposit',
    '0x52420003': 'publishData',
    '0x52420004': 'withdraw',
    '0x52420005': 'forceTransaction',
    '0x52420006': 'activateEscapeHatch',
    '0x52420008': 'cancelDeposit',
    '0x5242000a': 'pruneDepositReceipts',
    '0x5242000b': 'discardBatchData',
    '0x5242000c': 'payOwed',
    '0x5242000d': 'forceExitEvm',
    '0x52420011': 'nullifierClaimed',
};
const headers = process.env.TONCENTER_API_KEY ? { 'X-API-Key': process.env.TONCENTER_API_KEY } : {};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function page(offset) {
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(`${API}/transactions?account=${encodeURIComponent(address)}&limit=100&offset=${offset}&sort=asc`, {
            headers,
            signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) return (await response.json()).transactions ?? [];
        // 429 — предел частоты без ключа: подождать и повторить, не бросать отчёт.
        if (response.status !== 429 || attempt >= 5) {
            console.error(`API testnet ответил ${response.status}. Попробуй ещё раз через минуту.`);
            process.exit(1);
        }
        await pause(2000 * (attempt + 1));
    }
}

const transactions = [];
for (let offset = 0; ; offset += 100) {
    const batch = await page(offset);
    transactions.push(...batch);
    if (batch.length < 100) break;
    await pause(headers['X-API-Key'] ? 150 : 1100);
}
if (transactions.length === 0) {
    console.error('У контракта нет транзакций: адрес неверный или прогон ещё не начинался.');
    process.exit(1);
}

const hashPart = (raw) => (raw ?? '').split(':')[1]?.toLowerCase() ?? '';
/** Отметка очереди и время блока из тела SubmitBatch (Rollup.buildSubmitBatchBody: третья ссылка — BatchRoots). */
function submittedRoots(tx) {
    const boc = tx.in_msg?.message_content?.body;
    if (!boc) return null;
    try {
        const roots = Cell.fromBase64(boc).refs[2].beginParse();
        roots.skip(256 + 256 + 64);
        return { queueProcessedUpTo: Number(roots.loadUintBig(64)), blockTimestamp: Number(roots.loadUintBig(64)) };
    } catch {
        return null;
    }
}
const rows = transactions.map((tx) => {
    const compute = tx.description?.compute_ph ?? {};
    const step = STEPS[tx.in_msg?.opcode ?? null] ?? (tx.orig_status !== 'active' ? 'deploy' : tx.in_msg?.source ? 'other' : 'external');
    return {
        step,
        lt: tx.lt,
        hash: Buffer.from(tx.hash, 'base64').toString('hex'),
        now: tx.now,
        time: new Date(tx.now * 1000).toISOString(),
        from: hashPart(tx.in_msg?.source),
        success: compute.skipped ? false : Boolean(compute.success) && !tx.description?.aborted,
        exitCode: compute.skipped ? null : compute.exit_code,
        gasUsed: compute.skipped ? 0 : Number(compute.gas_used),
        totalFeesNano: Number(tx.total_fees),
        valueNano: String(tx.in_msg?.value ?? 0),
        roots: STEPS[tx.in_msg?.opcode] === 'submitBatch' ? submittedRoots(tx) : null,
        out: (tx.out_msgs ?? []).map((message) => ({ to: hashPart(message.destination), valueNano: String(message.value ?? 0) })),
    };
});
rows.sort((a, b) => (BigInt(a.lt) < BigInt(b.lt) ? -1 : 1));

// --- очередь L1 и батчи ---
const queue = rows
    .filter((row) => row.success && (row.step === 'deposit' || row.step === 'forceTransaction'))
    .map((row, index) => ({ number: index + 1, kind: row.step === 'deposit' ? 'deposit' : 'forced', queuedAt: row.now, valueNano: row.valueNano, from: row.from }));
let previousUpTo = 0;
let previousAt = null;
const batches = rows
    .filter((row) => row.success && row.step === 'submitBatch')
    .map((row, index) => {
        const upTo = row.roots?.queueProcessedUpTo ?? null;
        const batch = {
            batch: index + 1,
            time: row.time,
            gasUsed: row.gasUsed,
            secondsSincePrevious: previousAt === null ? null : row.now - previousAt,
            blockAgeSeconds: row.roots ? row.now - row.roots.blockTimestamp : null,
            queueProcessedUpTo: upTo,
            queueItems: upTo === null ? null : upTo - previousUpTo,
            at: row.now,
        };
        if (upTo !== null) previousUpTo = upTo;
        previousAt = row.now;
        return batch;
    });
const delays = queue.map((item) => {
    const batch = batches.find((entry) => entry.queueProcessedUpTo !== null && entry.queueProcessedUpTo >= item.number);
    return { ...item, batch: batch?.batch ?? null, delaySeconds: batch ? batch.at - item.queuedAt : null };
});
const processed = delays.filter((item) => item.delaySeconds !== null).map((item) => item.delaySeconds).sort((a, b) => a - b);
const stats = (values) =>
    values.length === 0
        ? null
        : { count: values.length, min: values[0], median: values[Math.floor(values.length / 2)], max: values[values.length - 1] };
const sorted = (values) => [...values].sort((a, b) => a - b);

// --- выплаты и отказы ---
const payouts = rows
    .filter((row) => (row.step === 'nullifierClaimed' || row.step === 'payOwed') && row.success)
    .flatMap((row) => row.out.map((message) => ({ time: row.time, step: row.step, to: message.to, valueNano: message.valueNano })));
const failures = rows.filter((row) => !row.success).map((row) => ({ time: row.time, step: row.step, exitCode: row.exitCode, from: row.from, hash: row.hash }));
const count = (step) => rows.filter((row) => row.step === step && row.success).length;

const result = {
    source: 'Сгенерировано zk/sequencer-run-report.mjs из транзакций testnet; не редактировать вручную',
    network: 'testnet',
    contract: address,
    generatedAt: new Date().toISOString(),
    period: { first: rows[0].time, last: rows[rows.length - 1].time },
    transactions: rows.length,
    failed: failures.length,
    totalFeesNano: rows.reduce((sum, row) => sum + row.totalFeesNano, 0),
    setup: { deploy: count('deploy'), keyParts: count('keyPart'), keyFinalize: count('keyFinalize') },
    queue: {
        items: queue.length,
        deposits: queue.filter((item) => item.kind === 'deposit').length,
        forced: queue.filter((item) => item.kind === 'forced').length,
        processed: processed.length,
        pending: queue.length - processed.length,
        delaySeconds: stats(processed),
    },
    batches: {
        accepted: batches.length,
        gas: stats(sorted(batches.map((batch) => batch.gasUsed))),
        secondsBetween: stats(sorted(batches.filter((batch) => batch.secondsSincePrevious !== null).map((batch) => batch.secondsSincePrevious))),
        blockAgeSeconds: stats(sorted(batches.filter((batch) => batch.blockAgeSeconds !== null).map((batch) => batch.blockAgeSeconds))),
        queueItems: stats(sorted(batches.filter((batch) => batch.queueItems !== null).map((batch) => batch.queueItems))),
        publishData: count('publishData'),
        discardBatchData: count('discardBatchData'),
        list: batches.map(({ at, ...batch }) => batch),
    },
    withdraws: count('withdraw'),
    // Возвраты необработанных депозитов после заморозки (CancelDeposit): исходящие сообщения вносителю.
    refunds: rows.filter((row) => row.step === 'cancelDeposit' && row.success).flatMap((row) => row.out.map((message) => ({ time: row.time, to: message.to, valueNano: message.valueNano }))),
    payouts: { count: payouts.length, totalNano: payouts.reduce((sum, payout) => sum + BigInt(payout.valueNano), 0n).toString(), list: payouts },
    frozen: count('activateEscapeHatch') > 0,
    failures,
    items: delays,
};
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');

const s = (value) => (value === null || value === undefined ? '—' : `${value} с`);
console.log(`Контракт ${address}: транзакций ${result.transactions} (${result.period.first} — ${result.period.last}), неуспешных ${result.failed}`);
console.log(`Развёртывание: ${result.setup.deploy}, частей ключа ${result.setup.keyParts}, фиксаций ${result.setup.keyFinalize}`);
console.log(`Батчей ${batches.length}; газ ${result.batches.gas ? `${result.batches.gas.min}–${result.batches.gas.max}` : '—'}; порций данных ${result.batches.publishData}, сбросов ${result.batches.discardBatchData}`);
for (const batch of batches)
    console.log(`  батч ${batch.batch} ${batch.time}: ${batch.gasUsed} gas, элементов очереди ${batch.queueItems ?? '?'}, после прежнего ${s(batch.secondsSincePrevious)}, возраст блока ${s(batch.blockAgeSeconds)}`);
const delay = result.queue.delaySeconds;
console.log(
    `Очередь L1: элементов ${result.queue.items} (депозитов ${result.queue.deposits}, принудительных ${result.queue.forced}), обработано ${result.queue.processed}, ждут ${result.queue.pending}` +
        (delay ? `; задержка до батча: мин ${delay.min} с, медиана ${delay.median} с, макс ${delay.max} с` : ''),
);
console.log(`Выводы (Withdraw): ${result.withdraws}; выплат ${payouts.length} на ${(Number(result.payouts.totalNano) / 1e9).toFixed(4)} TON`);
if (result.refunds.length > 0) console.log(`Возвраты депозитов (CancelDeposit): ${result.refunds.length}`);
for (const failure of failures) console.log(`  отказ ${failure.time}: ${failure.step}, код ${failure.exitCode}`);
if (result.frozen) console.log('ВНИМАНИЕ: rollup заморожен (ActivateEscapeHatch)');
console.log(`Записано: ${out.startsWith(ROOT + path.sep) ? path.relative(ROOT, out) : out}`);
