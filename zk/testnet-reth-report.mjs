// Отчёт о прогоне полного цикла протокола v2 на блоках Reth в testnet
// (scripts/runRethCycleTestnet.ts): транзакции контракта из сети, выплаты и сравнение газа с Sandbox.
//
//   node zk/testnet-reth-report.mjs <адрес контракта>
//
// Читает транзакции через публичный API testnet (toncenter v3), ничего не отправляет. Замеры
// Sandbox — bench/rollup-evm-reth-proof.json (tests/RollupEvmRethProof.spec.ts, те же пруфы):
// submitBatch1..3, forceExitEvm1..2, withdrawStep (в Sandbox измерен вывод первого листа).
// Выплатой считается исходящее сообщение контракта получателю на точную сумму — а не отсутствие
// ошибок; причитается вывод по каждому листу моста и выход каждого счёта против последнего
// принятого блока, каждая выплата — ровно один раз. Результат: bench/testnet-run-reth.json.
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
    '0x52420005': 'forceTransaction',
    '0x52420006': 'activateEscapeHatch',
    '0x52420008': 'cancelDeposit',
    '0x5242000a': 'pruneDepositReceipts',
    '0x5242000b': 'discardBatchData',
    '0x5242000c': 'payOwed',
    '0x5242000d': 'forceExitEvm',
    '0x52420011': 'nullifierClaimed',
};
/** Сколько батчей прогон обязан принять: блоки 1–3 (RETH_PROVEN_BLOCKS в wrappers/evmProofs.ts). */
const BATCHES = 3;
const readJson = (...parts) => {
    const file = path.join(ROOT, ...parts);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};
const expected = readJson('fixtures', 'evm_batches', 'reth', 'expected.json');
if (expected.protocolVersion !== 2 || !expected.exitsByBlock || !expected.withdrawals) {
    console.error('Нет fixtures/evm_batches/reth/expected.json протокола v2: отчёт сверять не с чем.');
    process.exit(1);
}
const recipientHash = expected.exitRecipientHash.replace(/^0x/, '').toLowerCase();

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
const batches = gasOf('submitBatch');
// Что получатель обязан получить: вывод по каждому листу моста из принятых блоков и выход каждого
// счёта против последнего принятого блока (в полном прогоне — пять листьев и два счёта).
const accepted = batches.length;
const due = [
    ...expected.withdrawals
        .filter((leaf) => leaf.block <= accepted)
        .map((leaf) => ({ what: `вывод через мост, лист ${leaf.leafIndex}`, amount: BigInt(leaf.amount) })),
    ...(expected.exitsByBlock.find(({ block }) => block === accepted)?.exits ?? []).map((exit) => ({
        what: `выход ${exit.account}`,
        amount: BigInt(exit.balanceWei) / 1_000_000_000n,
    })),
];
// Выплаты делает шаг после подтверждения нуллификатора (либо PayOwed, если был записан долг).
// Суммы у разных выплат могут совпадать (два листа по 0,05), поэтому сверяются счётом: выплат на
// каждую сумму обязано быть ровно столько, сколько причитается, и ни одной лишней.
const paid = rows
    .filter((row) => (row.step === 'nullifierClaimed' || row.step === 'payOwed') && row.success)
    .flatMap((row) => row.out)
    .filter((message) => message.to === recipientHash)
    .map((message) => BigInt(message.valueNano));
const countOf = (values, amount) => values.filter((value) => value === amount).length;
const dueAmounts = due.map(({ amount }) => amount);
const payouts = due.map(({ what, amount }) => ({
    what,
    amountNano: amount.toString(),
    dueWithThisAmount: countOf(dueAmounts, amount),
    paidWithThisAmount: countOf(paid, amount),
}));
const batchSandbox = [sandbox.submitBatch1, sandbox.submitBatch2, sandbox.submitBatch3];
const exitsGas = gasOf('forceExitEvm');
const exitSandbox = [sandbox.forceExitEvm1, sandbox.forceExitEvm2];
const withdrawGas = gasOf('withdraw');
const same = (testnet, expectedGas) =>
    testnet.length === expectedGas.length && testnet.every((gas, index) => gas === expectedGas[index]);
const out = {
    source: 'Сгенерировано zk/testnet-reth-report.mjs из транзакций testnet; не редактировать вручную',
    note: 'Прогон в testnet полного цикла rollup протокола v2 на блоках узла Reth: очередь L1 (депозиты и принудительные транзакции), три батча по Groth16-пруфам SP1, вывод через мост по каждому листу, заморозка, аварийные выходы двух счетов L2, возврат позднего депозита. Генезис цепочки — только мост: все монеты L2 — из депозитов прогона. Честный сценарий, не проверка безопасности.',
    protocolVersion: expected.protocolVersion,
    batchesAccepted: accepted,
    network: 'testnet',
    contract: address,
    genesisHash: expected.genesisHash,
    transactions: rows.length,
    failed: rows.filter((row) => !row.success).length,
    totalFeesNano: rows.reduce((sum, row) => sum + row.totalFeesNano, 0),
    valueReceivedNano: rows.reduce((sum, row) => sum + row.valueNano, 0),
    payouts,
    allPaidOnce: payouts.every((payout) => payout.paidWithThisAmount === payout.dueWithThisAmount) && paid.length === due.length,
    gas: {
        submitBatch: { testnet: batches, sandbox: batchSandbox, equal: same(batches, batchSandbox) },
        forceExitEvm: { testnet: exitsGas, sandbox: exitSandbox, equal: same(exitsGas, exitSandbox) },
        // В Sandbox измерен вывод первого листа: с ним сравнивается первый вывод прогона.
        withdraw: { testnet: withdrawGas, sandbox: sandbox.withdrawStep ?? null, firstEqual: withdrawGas[0] === sandbox.withdrawStep },
        publishData: { testnet: gasOf('publishData') },
        deposit: { testnet: gasOf('deposit') },
        forceTransaction: { testnet: gasOf('forceTransaction') },
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
console.log(`Выводы через мост: testnet ${withdrawGas.join(', ')} gas, Sandbox (первый лист) ${sandbox.withdrawStep} — ${out.gas.withdraw.firstEqual ? 'первый совпал' : 'первый НЕ совпал'}`);
console.log(`Очередь L1: депозитов ${out.gas.deposit.testnet.length}, принудительных транзакций ${out.gas.forceTransaction.testnet.length}`);
for (const payout of payouts) {
    const ok = payout.paidWithThisAmount === payout.dueWithThisAmount;
    console.log(`Выплата, ${payout.what}: ${(Number(payout.amountNano) / 1e9).toFixed(4)} TON — ${ok ? 'есть' : `выплат на эту сумму ${payout.paidWithThisAmount}, причитается ${payout.dueWithThisAmount}`}`);
}
if (accepted !== BATCHES) console.log(`ВНИМАНИЕ: принято батчей ${accepted} из ${BATCHES} — выплаты сверены для неполного прогона.`);
console.log(`Комиссии всего: ${(out.totalFeesNano / 1e9).toFixed(4)} TON; получено контрактом: ${(out.valueReceivedNano / 1e9).toFixed(4)} TON`);
console.log('Записано: bench/testnet-run-reth.json');
if (!out.allPaidOnce || out.failed > 0 || accepted !== BATCHES) process.exit(1);
