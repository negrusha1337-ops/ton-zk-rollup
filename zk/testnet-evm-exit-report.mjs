// Отчёт о прогоне аварийного выхода счёта EVM в testnet: транзакции контракта из сети,
// факт выплаты и сравнение газа с Sandbox.
//
//   node zk/testnet-evm-exit-report.mjs <адрес контракта>
//
// Читает транзакции через публичный API testnet (toncenter v3), ничего не отправляет.
// Замер Sandbox — bench/rollup-evm-exit.json (тест tests/RollupEvmExit.spec.ts, тот же счёт и
// то же сообщение, что в прогоне). Выплатой считается исходящее сообщение контракта получателю
// из фикстуры на сумму выхода — а не отсутствие ошибок. Результат: bench/testnet-run-evm-exit.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://testnet.toncenter.com/api/v3';
const address = process.argv[2];
if (!address) {
    console.error('Укажи адрес контракта: node zk/testnet-evm-exit-report.mjs <адрес>');
    process.exit(1);
}
// Опкоды сообщений: wrappers/Rollup.ts и wrappers/Bn254Groth16Verifier.ts.
const STEPS = {
    '0x42543235': 'keyPart',
    '0x42543236': 'keyFinalize',
    '0x52420002': 'deposit',
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
const fixture = readJson('fixtures', 'evm_exit', 'exit.json');
if (!fixture.testnet) {
    console.error('В fixtures/evm_exit/exit.json нет раздела testnet: отчёт сверять не с чем.');
    process.exit(1);
}
const amountNano = BigInt(fixture.testnet.balanceWei) / 1_000_000_000n;
const recipientHash = fixture.testnet.recipientHash.replace(/^0x/, '').toLowerCase();

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

const sandbox = readJson('bench', 'rollup-evm-exit.json');
const gasOf = (step) => rows.filter((row) => row.step === step && row.success).map((row) => row.gasUsed);
const exitGas = gasOf('forceExitEvm');
// Выплата: шаг после подтверждения нуллификатора шлёт получателю ровно сумму выхода.
const payouts = rows
    .filter((row) => row.step === 'nullifierClaimed' && row.success)
    .flatMap((row) => row.out)
    .filter((message) => message.to === recipientHash && BigInt(message.valueNano) === amountNano);
const out = {
    source: 'Сгенерировано zk/testnet-evm-exit-report.mjs из транзакций testnet; не редактировать вручную',
    note: 'Прогон в testnet аварийного выхода счёта EVM без пруфа zkVM: контракт заморожен, проверил заголовок блока, доказательство счёта и подпись и выплатил баланс. Слово состояния задано при развёртывании (батчей нет), обеспечения на L1 у баланса счёта нет. Прогон — честный сценарий, не проверка безопасности.',
    network: 'testnet',
    contract: address,
    blockHash: fixture.blockHash,
    account: fixture.testnet.account,
    amountNano: amountNano.toString(),
    paid: payouts.length === 1,
    transactions: rows.length,
    failed: rows.filter((row) => !row.success).length,
    totalFeesNano: rows.reduce((sum, row) => sum + row.totalFeesNano, 0),
    valueReceivedNano: rows.reduce((sum, row) => sum + row.valueNano, 0),
    gas: {
        forceExitEvm: {
            testnet: exitGas,
            sandbox: sandbox.forceExitEvmTestnetAccount ?? null,
            equal: exitGas.length > 0 && exitGas.every((gas) => gas === sandbox.forceExitEvmTestnetAccount),
        },
        activateEscapeHatch: { testnet: gasOf('activateEscapeHatch') },
        cancelDeposit: { testnet: gasOf('cancelDeposit') },
        deposit: { testnet: gasOf('deposit') },
        payoutStep: { testnet: gasOf('nullifierClaimed') },
    },
    steps: rows,
};
writeFileSync(path.join(ROOT, 'bench', 'testnet-run-evm-exit.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Транзакций: ${out.transactions}, неуспешных: ${out.failed}`);
console.log(`Выход счёта EVM: testnet ${exitGas.join(', ')} gas, Sandbox ${out.gas.forceExitEvm.sandbox} — ${out.gas.forceExitEvm.equal ? 'совпало' : 'НЕ совпало'}`);
console.log(`Выплата ${(Number(amountNano) / 1e9).toFixed(4)} TON получателю: ${out.paid ? 'есть' : 'НЕ НАЙДЕНА'}`);
console.log(`Комиссии всего: ${(out.totalFeesNano / 1e9).toFixed(4)} TON; получено контрактом: ${(out.valueReceivedNano / 1e9).toFixed(4)} TON`);
console.log('Записано: bench/testnet-run-evm-exit.json');
if (!out.paid || out.failed > 0) process.exit(1);
