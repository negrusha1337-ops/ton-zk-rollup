// Сверка выводов прогона сервиса-секвенсора (круг 23, пункт 4) для zk/sequencer-run-report.mjs:
// листья дерева выводов контракта (get-метод rollupState) против подтверждений нуллификаторов и
// выплат по транзакциям контракта, долги — get-методом owedPayout. Отдельный файл CommonJS: его
// берут и отчёт (ESM), и тесты jest (tests/SequencerRound23.spec.ts), которые ESM не импортируют.
//
// Что значит «сошлось»: у каждого подтверждения нуллификатора по листу (NullifierClaimed, ключ <
// 2^32 — номер листа; ключи аварийного выхода — вне этого пространства) лист существует, второго
// подтверждения нет, и ровно одно из двух — выплата той же суммы тому же получателю (сразу или
// позже по PayOwed) либо долг той же суммы у контракта сейчас. PayOwed без подтверждения или после
// выплаты — расхождение. Погашено не больше, чем листьев.
const { Cell } = require('@ton/core');

const OPCODES = { nullifierClaimed: 0x52420011, payOwed: 0x5242000c, withdraw: 0x52420004 };
const LEAF_KEY_LIMIT = 2n ** 32n;

/** Поля тела сообщения контракту, нужные сверке; null — тело не то или не разбирается. */
function parseBody(step, boc) {
    if (!boc || !(step in OPCODES)) return null;
    try {
        const slice = Cell.fromBase64(boc).beginParse();
        if (slice.loadUint(32) !== OPCODES[step]) return null;
        slice.loadUintBig(64);
        if (step === 'nullifierClaimed') {
            const key = slice.loadUintBig(256);
            const recipient = slice.loadAddress();
            return { key: key.toString(), recipientHash: recipient.hash.toString('hex'), amountNano: slice.loadCoins().toString() };
        }
        if (step === 'payOwed') return { key: slice.loadUintBig(256).toString() };
        const leafIndex = slice.loadUint(32);
        const recipient = slice.loadAddress();
        return { leafIndex, recipientHash: recipient.hash.toString('hex'), amountNano: slice.loadCoins().toString() };
    } catch {
        return null;
    }
}

/** Ключи листов, по которым нужен get-метод owedPayout: подтверждённые и не выплаченные сразу. */
function owedKeysToRead(rows) {
    return [
        ...new Set(
            rows
                .filter((row) => row.success && row.step === 'nullifierClaimed' && row.body && BigInt(row.body.key) < LEAF_KEY_LIMIT)
                .map((row) => row.body.key),
        ),
    ];
}

const pays = (row, recipientHash, amount) => row.out.some((message) => message.to === recipientHash && BigInt(message.valueNano) === amount);

/**
 * rows — строки отчёта (step, success, out[{to, valueNano}], body из parseBody); withdrawalsCount —
 * число листьев у контракта; owed — { ключ: сумма долга строкой | null } по owedKeysToRead.
 */
function reconcile({ rows, withdrawalsCount, owed }) {
    const problems = [];
    const leaves = BigInt(withdrawalsCount);
    const entries = new Map();
    let exits = 0;
    for (const row of rows.filter((entry) => entry.success && entry.step === 'nullifierClaimed')) {
        if (!row.body) {
            problems.push(`подтверждение нуллификатора ${row.hash}: тело не разбирается`);
            continue;
        }
        const key = BigInt(row.body.key);
        if (key >= LEAF_KEY_LIMIT) {
            exits++;
            continue;
        }
        if (entries.has(row.body.key)) problems.push(`лист ${key}: второе подтверждение нуллификатора (${row.hash})`);
        if (key >= leaves) problems.push(`лист ${key} погашен, а листьев у контракта ${leaves}`);
        const amount = BigInt(row.body.amountNano);
        entries.set(row.body.key, { key, amount, recipientHash: row.body.recipientHash, paidOnClaim: pays(row, row.body.recipientHash, amount), paidLater: false });
    }
    for (const row of rows.filter((entry) => entry.success && entry.step === 'payOwed')) {
        const key = row.body?.key;
        if (key === undefined) {
            problems.push(`PayOwed ${row.hash}: тело не разбирается`);
            continue;
        }
        if (BigInt(key) >= LEAF_KEY_LIMIT) continue;
        const entry = entries.get(key);
        if (!entry) problems.push(`PayOwed по листу ${key} без подтверждения нуллификатора`);
        else if (entry.paidOnClaim || entry.paidLater) problems.push(`лист ${key}: PayOwed после выплаты — выплачен дважды`);
        else if (!pays(row, entry.recipientHash, entry.amount)) problems.push(`лист ${key}: PayOwed без выплаты ${entry.amount} нанотон получателю листа`);
        else entry.paidLater = true;
    }
    let owedNow = 0;
    let owedNano = 0n;
    for (const entry of entries.values()) {
        const debt = owed[entry.key.toString()];
        if (debt === undefined) {
            problems.push(`лист ${entry.key}: долг не прочитан (get-метод owedPayout)`);
            continue;
        }
        const paid = entry.paidOnClaim || entry.paidLater;
        if (paid && debt !== null) problems.push(`лист ${entry.key}: выплачен, а у контракта записан долг ${debt} нанотон`);
        if (!paid && debt === null) problems.push(`лист ${entry.key}: погашен, не выплачен и долга у контракта нет — выплата потеряна`);
        if (!paid && debt !== null) {
            owedNow++;
            owedNano += BigInt(debt);
            if (BigInt(debt) !== entry.amount) problems.push(`лист ${entry.key}: долг ${debt} нанотон, а в подтверждении ${entry.amount}`);
        }
    }
    const values = [...entries.values()];
    const claimed = values.length;
    return {
        leaves: Number(leaves),
        withdrawRequests: rows.filter((row) => row.success && row.step === 'withdraw').length,
        claimed,
        paidOnClaim: values.filter((entry) => entry.paidOnClaim).length,
        paidOwed: values.filter((entry) => entry.paidLater).length,
        owedNow,
        owedNano: owedNano.toString(),
        unclaimed: Math.max(0, Number(leaves) - claimed),
        exitClaims: exits,
        problems,
        verdict: problems.length === 0 ? 'сошлось' : 'не сошлось',
    };
}

/** Код выхода отчёта: 0 — сошлось, 2 — не сошлось (файл отчёта пишется в обоих случаях). */
const exitCodeOf = (reconciliation) => (reconciliation.problems.length === 0 ? 0 : 2);

module.exports = { parseBody, owedKeysToRead, reconcile, exitCodeOf, LEAF_KEY_LIMIT };
