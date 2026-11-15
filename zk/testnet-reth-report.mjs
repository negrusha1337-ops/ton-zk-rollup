// Отчёт о прогоне полного цикла на блоках Reth в testnet: транзакции контракта из сети,
// выплаты и сравнение газа с Sandbox.
//
//   node zk/testnet-reth-report.mjs <адрес контракта>
//
// Читает транзакции через публичный API testnet (toncenter v3), ничего не отправляет. Замеры
// Sandbox — bench/rollup-evm-reth-proof.json (tests/RollupEvmRethProof.spec.ts, те же пруфы).
// Выплатой считается исходящее сообщение контракта получателю на точную сумму — а не отсутствие
// ошибок. Результат: bench/testnet-run-reth.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://testnet.toncenter.com/api/v3';
const address = process.argv[2];
if (!address) {
    console.error('Укажи адрес контракта: node zk/testnet-reth-report.mjs <адрес>');
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
    '0x52420006': 'activateEscapeHatch',
    '0x52420008': 'cancelDeposit',
    '0x52420009': 'setExitKey',
    '0x5242000d': 'forceExitEvm',
    '0x52420011': 'nullifierClaimed',
};
const readJson = (...parts) => {
    const file = path.join(ROOT, ...parts);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};
const expected = readJson('fixtures', 'evm_batches', 'reth', 'expected.json');
if (!expected.exits) {
    console.error('Нет fixtures/evm_batches/reth/expected.json: отчёт сверять не с чем.');
    process.exit(1);
}
const recipientHash = expected.exitRecipientHash.replace(/^0x/, '').toLowerCase();
// Что получатель обязан получить: вывод через мост и оба аварийных выхода.
const due = [
    { what: 'вывод через мост', amount: BigInt(expected.withdrawal.amount) },
    ...expected.exits.map((exit) => ({ what: `выход ${exit.account}`, amount: BigInt(exit.balanceWei) / 1_000_000_000n })),
];

const transactions = [];
for (let offset = 0; ; offset += 100) {
    const response = await fetch(
        `${API}/transactions?account=${encodeURIComponent(address)}&limit=100&offset=${offset}&sort=asc`,
        { signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok) {
        console.error(`API testnet ответил ${response.status}. Попробуй ещё раз через минуту.`);
        process.exit(1);
    }
    const page = (await response.json()).transactions ?? [];
    transactions.push(...page);
    if (page.length < 100) break;
}
if (transactions.length === 0) {
    console.error('У контракта нет транзакций: адрес неверный или прогон ещё не начинался.');
    process.exit(1);
}
/** Хеш-часть адреса вида «0:ABCD…» в нижнем регистре. */
const hashPart = (raw) => (raw ?? '').split(':')[1]?.toLowerCase() ?? '';
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
        out: (tx.out_msgs ?? []).map((message) => ({ to: hashPart(message.destination), valueNano: String(message.value ?? 0) })),
    };
});

const sandbox = readJson('bench', 'rollup-evm-reth-proof.json');
const gasOf = (step) => rows.filter((row) => row.step === step && row.success).map((row) => row.gasUsed);
// Выплаты делает шаг после подтверждения нуллификатора. Каждой причитающейся сумме обязана
// соответствовать ровно одна выплата получателю.
const paid = rows
    .filter((row) => row.step === 'nullifierClaimed' && row.success)
    .flatMap((row) => row.out)
    .filter((message) => message.to === recipientHash)
    .map((message) => BigInt(message.valueNano));
const payouts = due.map(({ what, amount }) => ({ what, amountNano: amount.toString(), count: paid.filter((value) => value === amount).length }));
const batches = gasOf('submitBatch');
const batchSandbox = [sandbox.submitBatch1, sandbox.submitBatch2, sandbox.submitBatch3];
const exitsGas = gasOf('forceExitEvm');
const exitSandbox = [sandbox.forceExitEvm1, sandbox.forceExitEvm2];
const same = (testnet, expectedGas) =>
    testnet.length === expectedGas.length && testnet.every((gas, index) => gas === expectedGas[index]);
const out = {
    source: 'Сгенерировано zk/testnet-reth-report.mjs из транзакций testnet; не редактировать вручную',
    note: 'Прогон в testnet полного цикла rollup на блоках узла Reth: депозиты на L1, три батча по Groth16-пруфам SP1, вывод через мост, заморозка, аварийные выходы двух счетов L2, возврат позднего депозита. Генезис цепочки пуст: все монеты L2 — из депозитов прогона. Честный сценарий, не проверка безопасности.',
    network: 'testnet',
    contract: address,
    genesisHash: expected.genesisHash,
    transactions: rows.length,
    failed: rows.filter((row) => !row.success).length,
    totalFeesNano: rows.reduce((sum, row) => sum + row.totalFeesNano, 0),
    valueReceivedNano: rows.reduce((sum, row) => sum + row.valueNano, 0),
    payouts,
    allPaidOnce: payouts.every((payout) => payout.count === 1) && paid.length === due.length,
    gas: {
        submitBatch: { testnet: batches, sandbox: batchSandbox, equal: same(batches, batchSandbox) },
        forceExitEvm: { testnet: exitsGas, sandbox: exitSandbox, equal: same(exitsGas, exitSandbox) },
        withdraw: { testnet: gasOf('withdraw'), sandbox: sandbox.withdrawStep ?? null },
        publishData: { testnet: gasOf('publishData') },
        deposit: { testnet: gasOf('deposit') },
        activateEscapeHatch: { testnet: gasOf('activateEscapeHatch') },
        cancelDeposit: { testnet: gasOf('cancelDeposit') },
        payoutStep: { testnet: gasOf('nullifierClaimed') },
    },
    steps: rows,
};
writeFileSync(path.join(ROOT, 'bench', 'testnet-run-reth.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Транзакций: ${out.transactions}, неуспешных: ${out.failed}`);
console.log(`Батчи: testnet ${batches.join(', ')} gas, Sandbox ${batchSandbox.join(', ')} — ${out.gas.submitBatch.equal ? 'совпало' : 'НЕ совпало'}`);
console.log(`Выходы счетов EVM: testnet ${exitsGas.join(', ')} gas, Sandbox ${exitSandbox.join(', ')} — ${out.gas.forceExitEvm.equal ? 'совпало' : 'НЕ совпало'}`);
for (const payout of payouts) console.log(`Выплата, ${payout.what}: ${(Number(payout.amountNano) / 1e9).toFixed(4)} TON — ${payout.count === 1 ? 'есть' : `найдено ${payout.count}`}`);
console.log(`Комиссии всего: ${(out.totalFeesNano / 1e9).toFixed(4)} TON; получено контрактом: ${(out.valueReceivedNano / 1e9).toFixed(4)} TON`);
console.log('Записано: bench/testnet-run-reth.json');
if (!out.allPaidOnce || out.failed > 0) process.exit(1);
