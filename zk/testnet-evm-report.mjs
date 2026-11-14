// Отчёт о прогоне батча EVM в testnet: транзакции контракта из сети и сравнение газа с Sandbox.
//
//   node zk/testnet-evm-report.mjs <адрес контракта>
//
// Читает транзакции через публичный API testnet (toncenter v3), ничего не отправляет.
// Замеры Sandbox — bench/rollup-evm-proof.json (тест tests/RollupEvmProof.spec.ts); сравнение
// делается, только если они сняты для тех же исходников программы, что и нынешний program.json.
// Результат: bench/testnet-run-evm.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://testnet.toncenter.com/api/v3';
const address = process.argv[2];
if (!address) {
    console.error('Укажи адрес контракта: node zk/testnet-evm-report.mjs <адрес>');
    process.exit(1);
}
// Опкоды сообщений: wrappers/Rollup.ts и wrappers/Bn254Groth16Verifier.ts.
const STEPS = {
    '0x42543235': 'keyPart',
    '0x42543236': 'keyFinalize',
    '0x52420001': 'submitBatch',
    '0x52420003': 'publishData',
    '0x52420009': 'setExitKey',
};
const readJson = (...parts) => {
    const file = path.join(ROOT, ...parts);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};

const response = await fetch(
    `${API}/transactions?account=${encodeURIComponent(address)}&limit=100&offset=0&sort=asc`,
    { signal: AbortSignal.timeout(30_000) },
);
if (!response.ok) {
    console.error(`API testnet ответил ${response.status}. Попробуй ещё раз через минуту.`);
    process.exit(1);
}
const transactions = (await response.json()).transactions ?? [];
if (transactions.length === 0) {
    console.error('У контракта нет транзакций: адрес неверный или прогон ещё не начинался.');
    process.exit(1);
}
const rows = transactions.map((tx) => {
    const compute = tx.description?.compute_ph ?? {};
    return {
        step: STEPS[tx.in_msg?.opcode ?? null] ?? (tx.orig_status !== 'active' ? 'deploy' : 'other'),
        hash: Buffer.from(tx.hash, 'base64').toString('hex'),
        time: new Date(tx.now * 1000).toISOString(),
        success: compute.skipped ? false : Boolean(compute.success) && !tx.description?.aborted,
        exitCode: compute.skipped ? null : compute.exit_code,
        gasUsed: compute.skipped ? 0 : Number(compute.gas_used),
        totalFeesNano: Number(tx.total_fees),
        valueNano: Number(tx.in_msg?.value ?? 0),
    };
});

const program = readJson('fixtures', 'evm_batches', 'program.json');
const sandbox = readJson('bench', 'rollup-evm-proof.json');
const comparable = Boolean(program.sourcesSha256) && sandbox.sourcesSha256 === program.sourcesSha256;
const gasOf = (step) => rows.filter((row) => row.step === step && row.success).map((row) => row.gasUsed);
const compare = (step, sandboxGas) => {
    const testnet = gasOf(step);
    return {
        testnet,
        sandbox: comparable ? (sandboxGas ?? null) : null,
        equal: comparable && sandboxGas !== undefined && testnet.length > 0 && testnet.every((gas) => gas === sandboxGas),
    };
};
const out = {
    source: 'Сгенерировано zk/testnet-evm-report.mjs из транзакций testnet; не редактировать вручную',
    note: 'Прогон в testnet одного батча EVM: блок, исполненный Reth внутри SP1, и его Groth16-пруф приняты rollup-контрактом. Демонстрация приёма батча: ключ выхода — заглушка, депозитов нет. Прогон — честный сценарий, не проверка безопасности.',
    network: 'testnet',
    contract: address,
    programVKey: program.programVKey ?? null,
    sourcesSha256: program.sourcesSha256 ?? null,
    transactions: rows.length,
    failed: rows.filter((row) => !row.success).length,
    totalFeesNano: rows.reduce((sum, row) => sum + row.totalFeesNano, 0),
    valueReceivedNano: rows.reduce((sum, row) => sum + row.valueNano, 0),
    gas: {
        submitBatch: compare('submitBatch', sandbox.submitBatch),
        publishData: compare('publishData', sandbox.publishData),
        keyParts: { testnet: gasOf('keyPart').reduce((sum, gas) => sum + gas, 0), count: gasOf('keyPart').length },
        setExitKey: { testnet: gasOf('setExitKey') },
        keyFinalize: { testnet: gasOf('keyFinalize') },
    },
    steps: rows,
};
writeFileSync(path.join(ROOT, 'bench', 'testnet-run-evm.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Транзакций: ${out.transactions}, неуспешных: ${out.failed}`);
console.log(`Батч: testnet ${out.gas.submitBatch.testnet.join(', ')} gas, Sandbox ${out.gas.submitBatch.sandbox} — ${out.gas.submitBatch.equal ? 'совпало' : 'НЕ совпало'}`);
console.log(`Публикация данных: testnet ${out.gas.publishData.testnet.join(', ')} gas, Sandbox ${out.gas.publishData.sandbox} — ${out.gas.publishData.equal ? 'совпало' : 'НЕ совпало'}`);
console.log(`Комиссии всего: ${(out.totalFeesNano / 1e9).toFixed(4)} TON; получено контрактом: ${(out.valueReceivedNano / 1e9).toFixed(4)} TON`);
console.log('Записано: bench/testnet-run-evm.json');
