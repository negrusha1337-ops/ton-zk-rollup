// Отчёт о прогоне rollup-контракта в testnet: газ и коды выхода каждой транзакции,
// сравнение с Sandbox. Запуск:
//
//   node zk/testnet-rollup-report.mjs <адрес rollup-контракта>
//
// Данные берутся из публичного API testnet (toncenter v3); наружу уходит только адрес
// контракта. Результат: bench/testnet-run-rollup.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://testnet.toncenter.com/api/v3';
const address = process.argv[2];
if (!address) {
    console.error('Укажи адрес контракта: node zk/testnet-rollup-report.mjs <адрес>');
    process.exit(1);
}

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
    '0x52420007': 'forceExit',
    '0x52420008': 'cancelDeposit',
    '0x52420009': 'setExitKey',
    '0x5242000a': 'pruneDepositReceipts',
    '0x5242000b': 'discardBatchData',
    '0x5242000c': 'payOwed',
    '0x52420011': 'withdrawPayout',
};

async function getJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`API testnet ответил ${response.status} на ${url}`);
    return response.json();
}

// API отдаёт не больше PAGE транзакций за запрос: читаем страницами, пока не кончатся.
const PAGE = 100;
let transactions = [];
try {
    for (let offset = 0; ; offset += PAGE) {
        const query = `${API}/transactions?account=${encodeURIComponent(address)}&limit=${PAGE}&offset=${offset}&sort=asc`;
        const page = (await getJson(query)).transactions ?? [];
        transactions.push(...page);
        if (page.length < PAGE) break;
    }
} catch (err) {
    console.error(`Не удалось получить транзакции: ${err.message}. Попробуй ещё раз через минуту.`);
    process.exit(1);
}
if (!transactions?.length) {
    console.error('У контракта нет транзакций: адрес неверный или прогон ещё не начинался.');
    process.exit(1);
}

const rows = transactions.map((tx) => {
    const compute = tx.description?.compute_ph ?? {};
    const opcode = tx.in_msg?.opcode ?? null;
    return {
        step: STEPS[opcode] ?? (tx.orig_status !== 'active' ? 'deploy' : 'other'),
        hash: Buffer.from(tx.hash, 'base64').toString('hex'),
        time: new Date(tx.now * 1000).toISOString(),
        success: compute.skipped ? false : Boolean(compute.success) && !tx.description?.aborted,
        exitCode: compute.skipped ? null : compute.exit_code,
        gasUsed: compute.skipped ? 0 : Number(compute.gas_used),
        gasFeeNano: compute.skipped ? 0 : Number(compute.gas_fees),
        totalFeesNano: Number(tx.total_fees),
        valueNano: Number(tx.in_msg?.value ?? 0),
        // Сколько монет ушло исходящими сообщениями: у подтверждения от нуллификатора это
        // отличает выплату от записи долга (долг — успешная транзакция без исходящих монет).
        sentNano: (tx.out_msgs ?? []).reduce((sum, message) => sum + Number(message.value ?? 0), 0),
    };
});

// Замеры Sandbox годятся для сравнения, только если сняты для тех же программ, что и пруфы
// прогона: тесты записывают рядом с замерами хеш исходников программ. Замеры прежней версии
// (без этого поля или с другим хешем) в сравнение не идут.
const readJson = (...parts) => {
    const file = path.join(ROOT, ...parts);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};
const sourcesSha256 = readJson('fixtures', 'zkvm_batches', 'program.json').sourcesSha256 ?? null;
const currentBench = (name) => {
    const bench = readJson('bench', name);
    return sourcesSha256 !== null && bench.sourcesSha256 === sourcesSha256 ? bench : {};
};
const sandbox = currentBench('rollup-zkvm-proof.json');
const sandboxBatchGas = [sandbox.submitBatch, sandbox.submitBatchWithDeposit];
const escapeSandbox = currentBench('rollup-escape.json');

const pick = ({ hash, time, success, exitCode, gasUsed, gasFeeNano }) => ({
    transactionHash: hash,
    time,
    success,
    exitCode,
    gasUsed,
    gasFeeNano,
});
const of = (step) => rows.filter((row) => row.step === step);
const batches = of('submitBatch')
    .filter((row) => row.success)
    .map((row, index) => ({
        batch: index + 1,
        ...pick(row),
        sandboxGasUsed: sandboxBatchGas[index] ?? null,
        matchesSandbox: sandboxBatchGas[index] === row.gasUsed,
    }));
const keyParts = of('keyPart').filter((row) => row.success);

const report = {
    source: 'Сгенерировано zk/testnet-rollup-report.mjs из https://testnet.toncenter.com/api/v3; не редактировать вручную',
    network: 'testnet',
    contract: address,
    gasLimitPerTransaction: 1_000_000,
    programSourcesSha256: sourcesSha256,
    sandboxComparison:
        sandbox.submitBatch === undefined
            ? 'нет: замеры Sandbox сняты для другой версии программ или отсутствуют'
            : 'bench/rollup-zkvm-proof.json, bench/rollup-escape.json',
    transactions: rows.length,
    failedTransactions: rows.filter((row) => !row.success).map(pick),
    keyUpload: {
        parts: keyParts.length,
        partsGasUsed: keyParts.reduce((sum, row) => sum + row.gasUsed, 0),
        finalizeGasUsed: of('keyFinalize').find((row) => row.success)?.gasUsed ?? null,
    },
    deposit: of('deposit')
        .filter((row) => row.success)
        .map(pick),
    publishData: of('publishData')
        .filter((row) => row.success)
        .map(pick),
    submitBatch: batches,
    withdraw: of('withdraw')
        .filter((row) => row.success)
        .map(pick),
    // Подтверждение от нуллификатора: выплата получателю либо запись долга (монет не ушло).
    withdrawPayout: of('withdrawPayout')
        .filter((row) => row.success && row.sentNano > 0)
        .map(pick),
    payoutRecordedAsDebt: of('withdrawPayout')
        .filter((row) => row.success && row.sentNano === 0)
        .map(pick),
    payOwed: of('payOwed')
        .filter((row) => row.success)
        .map(pick),
    forceTransaction: of('forceTransaction')
        .filter((row) => row.success)
        .map(pick),
    setExitKey: of('setExitKey')
        .filter((row) => row.success)
        .map(pick),
    discardBatchData: of('discardBatchData')
        .filter((row) => row.success)
        .map(pick),
    escape: {
        activateEscapeHatch: of('activateEscapeHatch')
            .filter((row) => row.success)
            .map(pick),
        forceExit: of('forceExit')
            .filter((row) => row.success)
            .map((row) => ({
                ...pick(row),
                sandboxGasUsed: escapeSandbox.forceExit ?? null,
                // Газ зависит от пруфа; с Sandbox сравним только выход первого счёта сценария.
            })),
        cancelDeposit: of('cancelDeposit')
            .filter((row) => row.success)
            .map(pick),
    },
    totalFeesNano: rows.reduce((sum, row) => sum + row.totalFeesNano, 0),
    valueReceivedNano: rows.reduce((sum, row) => sum + row.valueNano, 0),
};

const outPath = path.join(ROOT, 'bench', 'testnet-run-rollup.json');
writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

console.table(
    rows.map(({ step, success, exitCode, gasUsed, gasFeeNano }) => ({
        step,
        success,
        exitCode,
        gasUsed,
        'gasFee, TON': (gasFeeNano / 1e9).toFixed(4),
    })),
);
for (const batch of batches) {
    console.log(
        `Батч ${batch.batch}: ${batch.gasUsed} gas в testnet, ${batch.sandboxGasUsed ?? '—'} в Sandbox — ` +
            (batch.matchesSandbox ? 'совпало' : 'НЕ совпало'),
    );
}
console.log(`Записано: ${path.relative(ROOT, outPath)}`);
