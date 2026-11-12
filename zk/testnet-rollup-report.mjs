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
    '0x52420004': 'withdraw',
    '0x52420011': 'withdrawPayout',
};

async function getJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`API testnet ответил ${response.status} на ${url}`);
    return response.json();
}

let transactions;
try {
    const query = `${API}/transactions?account=${encodeURIComponent(address)}&limit=100&sort=asc`;
    ({ transactions } = await getJson(query));
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
    };
});

const sandboxPath = path.join(ROOT, 'bench', 'rollup-zkvm-proof.json');
const sandbox = existsSync(sandboxPath) ? JSON.parse(readFileSync(sandboxPath, 'utf8')) : {};
const sandboxBatchGas = [sandbox.submitBatch, sandbox.submitBatchWithDeposit];

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
    submitBatch: batches,
    withdraw: of('withdraw')
        .filter((row) => row.success)
        .map(pick),
    withdrawPayout: of('withdrawPayout')
        .filter((row) => row.success)
        .map(pick),
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
