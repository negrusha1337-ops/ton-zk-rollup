// Профили сценария цепочки Reth (profile.mjs): чистые функции, без узла.
//
//   node --test zkvm-evm/scenario/profile.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    BAD_SIGNATURE_KINDS,
    bridgeWithdrawals,
    FORCED_CASES,
    keepsForced,
    keptForced,
    MIN_WITHDRAWAL,
    PRICES,
    profileNamed,
    profileProblems,
    PROFILES,
    queuePlan,
    userSpending,
    walletNeed,
} from './profile.mjs';

const { default: defaults, testnet } = PROFILES;
const kindsOf = (profile, block) => keptForced(profile, block).map((id) => FORCED_CASES[block][id].kind);

test('профиль default оставляет все принудительные случаи блоков 2 и 3', () => {
    assert.deepEqual(keptForced(defaults, 2), Object.keys(FORCED_CASES[2]));
    assert.deepEqual(keptForced(defaults, 3), Object.keys(FORCED_CASES[3]));
    assert.deepEqual(profileProblems(defaults), []);
    // Столько же, сколько в цепочке, под которую построены нынешние пруфы: 2 депозита и 37 принудительных.
    const queue = queuePlan(defaults);
    assert.equal(queue.length, 39);
    assert.equal(queue.filter((item) => item.kind === 'forced' && item.batch === 2).length, 6);
    assert.equal(queue.filter((item) => item.kind === 'forced' && item.batch === 3).length, 21 + BAD_SIGNATURE_KINDS);
});

test('профиль default повторяет нынешнюю цепочку: депозиты и листья моста блоков 2–3', () => {
    const expected = JSON.parse(readFileSync(new URL('../../fixtures/evm_batches/reth/expected.json', import.meta.url), 'utf8'));
    const deposits = expected.queue.filter((item) => item.kind === 'deposit' && item.batch <= 3).map((item) => BigInt(item.amount));
    assert.deepEqual(deposits, [defaults.userDeposit, defaults.otherDeposit]);
    const leaves = expected.withdrawals.filter((leaf) => leaf.block <= 3).map((leaf) => BigInt(leaf.amount));
    assert.deepEqual(bridgeWithdrawals(defaults), leaves);
    assert.equal(expected.queue.filter((item) => item.batch <= 3).length, queuePlan(defaults).length);
    assert.equal(BigInt(expected.transferWei), defaults.transferWei);
    // Остаток счёта A после блока 3 — не меньше оценки снизу, на которой стоит расчёт возврата.
    const left = BigInt(expected.exitsByBlock.find(({ block }) => block === 3).exits[0].balanceWei) / 1_000_000_000n;
    const need = walletNeed(defaults);
    assert.ok(left + defaults.otherDeposit >= need.exitedAtLeast);
    assert.ok(left + defaults.otherDeposit - need.exitedAtLeast < 10_000_000n);
});

test('профиль testnet сохраняет в блоке 3 то, ради чего он идёт в сеть', () => {
    assert.deepEqual(profileProblems(testnet), []);
    const kinds = kindsOf(testnet, 3);
    // Включённый принудительный вывод и по одному пропуску каждого рода; подписи — отдельно, все десять.
    assert.deepEqual([...kinds].sort(), ['form', 'includedWithdrawal', 'revm']);
    assert.equal(queuePlan(testnet).filter((item) => item.batch === 3).length, 3 + BAD_SIGNATURE_KINDS);
    assert.equal(BAD_SIGNATURE_KINDS, 10);
    // Вывод из контракта L2: две части, обе не меньше наименьшего вывода.
    const leaves = bridgeWithdrawals(testnet);
    assert.deepEqual(leaves.slice(-2), [testnet.splitterValue / 4n, testnet.splitterValue - testnet.splitterValue / 4n]);
    assert.ok(leaves.every((amount) => amount >= MIN_WITHDRAWAL));
    // В блоке 2 принудительных нет: за место в очереди платить не за что.
    assert.deepEqual(keptForced(testnet, 2), []);
    assert.equal(keepsForced(testnet, 3, 'starved'), false);
    assert.equal(keepsForced(testnet, 3, 'minimumWithdrawal'), true);
});

test('профиль testnet дешевле default: меньше депозиты и плата за места в очереди', () => {
    const [cheap, full] = [walletNeed(testnet), walletNeed(defaults)];
    assert.equal(cheap.forcedFees, BigInt(3 + BAD_SIGNATURE_KINDS) * PRICES.forceTransactionFee);
    assert.equal(full.forcedFees, 37n * PRICES.forceTransactionFee);
    assert.equal(cheap.depositFees, 2n * PRICES.depositFee);
    assert.ok(cheap.deposited < full.deposited / 5n);
    assert.ok(cheap.total < full.total / 2n);
    // Итоги сходятся: нужно = постоянная часть + депозиты + платы + комиссии; не вернётся = нужно − вернётся.
    for (const need of [cheap, full]) {
        assert.equal(need.total, need.fixed + need.deposited + need.depositFees + need.forcedFees + need.walletFees);
        assert.equal(need.lost, need.total - need.returns);
        assert.equal(need.returns, need.withdrawn + need.exitedAtLeast + PRICES.lateDeposit - PRICES.depositFee);
        assert.ok(need.withdrawn + need.exitedAtLeast <= need.deposited);
    }
});

test('монет счёта A хватает на его транзакции; негодный профиль назван', () => {
    assert.ok(testnet.userDeposit >= userSpending(testnet) + MIN_WITHDRAWAL);
    assert.ok(testnet.topUp > 0n && defaults.topUp === 0n);
    const problems = (changes) => profileProblems({ ...testnet, ...changes });
    assert.match(problems({ userDeposit: 300_000_000n })[0], /не хватает на его транзакции/);
    assert.match(problems({ splitterValue: 199_999_999n })[0], /четверть суммы/);
    assert.match(problems({ keepForced: { 2: [], 3: ['notBridge', 'otherNonceHigh'] } })[0], /нет включённого принудительного вывода/);
    assert.match(problems({ keepForced: { 2: [], 3: ['minimumWithdrawal', 'otherNonceHigh'] } })[0], /нет пропуска по форме/);
    assert.match(problems({ keepForced: { 2: [], 3: ['minimumWithdrawal', 'notBridge'] } })[0], /нет пропуска по отказу revm/);
    assert.match(problems({ keepForced: { 2: [], 3: ['нет такого'] } })[0], /нет случая/);
    assert.match(problems({ otherDeposit: MIN_WITHDRAWAL })[0], /депозит счёта B/);
    assert.match(problems({ sequencerWithdrawal: MIN_WITHDRAWAL - 1n })[0], /вывод меньше наименьшего/);
    assert.throws(() => profileNamed('mainnet'), /неизвестный профиль/);
    assert.throws(() => keepsForced(testnet, 3, 'нет такого'), /в перечне блока 3 нет/);
});

test('плата за место удваивается, когда хвост очереди дорастает до шага', () => {
    // Шаг 4 вместо 64: в отрезке блока 3 (13 элементов) плата удваивается на пятом и девятом, учетверяется… и так далее.
    const need = walletNeed(testnet, { ...PRICES, queueFeeStep: 4 });
    const fee = PRICES.forceTransactionFee;
    assert.equal(need.forcedFees, 4n * fee + 4n * 2n * fee + 4n * 4n * fee + 8n * fee);
    assert.equal(need.depositFees, 2n * PRICES.depositFee);
});
