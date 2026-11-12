// Два батча для сквозного теста rollup-контракта с НАСТОЯЩЕЙ проверкой пруфа.
//
// Пруф здесь строится игрушечной схемой Multiplier (BN254): её единственный публичный
// вход можно сделать равным любому числу, и мы делаем его равным дайджесту публичных
// значений батча. Настоящие пруфы программы перехода состояния — в fixtures/sp1_rollup_batch*.
// Переход состояния такой пруф НЕ доказывает — он нужен, чтобы контракт прошёл весь
// настоящий путь: дайджест → верификатор → смена корня, и чтобы измерить газ.
//
// Требует локальных артефактов: node zk/build.mjs multiplier_bn254.
// Результат: fixtures/rollup_batches/batches.json. Сценарий должен совпадать с
// tests/RollupProof.spec.ts.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import ton from '@ton/core';
import { buildProofHints, buildVerificationKeyData, parseProof, parseVerificationKey } from './bn254-onchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'circuits', 'build', 'multiplier_bn254');
const KEY_DIR = path.join(ROOT, 'fixtures', 'multiplier_bn254');
const OUT = path.join(ROOT, 'fixtures', 'rollup_batches');
const wasm = path.join(BUILD, 'Multiplier_js', 'Multiplier.wasm');
const zkey = path.join(BUILD, 'circuit_final.zkey');
if (!existsSync(wasm) || !existsSync(zkey)) {
    console.error('Нет артефактов схемы. Сначала: node zk/build.mjs multiplier_bn254 и перегенерация фикстур.');
    process.exit(1);
}

// --- арифметика протокола (как в contracts/rollup/logic.tolk и wrappers/rollupMath.ts) ---
const MASK_253 = (1n << 253n) - 1n;
const TREE_DEPTH = 32;
const bytes32 = (value) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
const sha256Int = (...values) =>
    BigInt(
        '0x' +
            createHash('sha256')
                .update(Buffer.concat(values.map(bytes32)))
                .digest('hex'),
    );
const label = (text) => BigInt('0x' + createHash('sha256').update(text).digest('hex'));
// Порция данных батча как дерево ячеек — копия dataChunkCell из wrappers/rollupMath.ts.
const DATA_CELL_BYTES = 127;
const DATA_CELL_REFS = 4;
function dataChunkCell(data) {
    const cellCount = Math.max(1, Math.ceil(data.length / DATA_CELL_BYTES));
    const cells = new Array(cellCount);
    for (let index = cellCount - 1; index >= 0; index--) {
        const builder = ton
            .beginCell()
            .storeBuffer(data.subarray(index * DATA_CELL_BYTES, (index + 1) * DATA_CELL_BYTES));
        for (let child = DATA_CELL_REFS * index + 1; child <= DATA_CELL_REFS * index + DATA_CELL_REFS; child++) {
            if (child < cellCount) builder.storeRef(cells[child]);
        }
        cells[index] = builder.endCell();
    }
    return cells[0];
}
/** Накопительный хеш порций — как dataHashStep в контракте; 0, если данных нет. */
const batchDataHash = (chunks) =>
    chunks.reduce((hash, chunk) => sha256Int(hash, BigInt('0x' + dataChunkCell(chunk).hash().toString('hex'))), 0n);
/** Детерминированные байты порции: поток sha256(метка ‖ счётчик). */
const chunkBytes = (text, length) => {
    const blocks = [];
    for (let counter = 0; blocks.length * 32 < length; counter++) {
        blocks.push(createHash('sha256').update(`${text}:${counter}`).digest());
    }
    return Buffer.concat(blocks).subarray(0, length);
};

const batchDigest = (v) =>
    sha256Int(
        CHAIN_ID,
        v.prevStateRoot,
        v.newStateRoot,
        v.batchHash,
        v.withdrawalsRoot,
        v.prevDepositHash,
        v.newDepositHash,
    ) & MASK_253;

// --- сценарий ---
const TON = 1_000_000_000n;
// Идентификатор rollup'а этого сценария: тест развёртывает контракт с ним же.
const CHAIN_ID = 20261113n;
const genesisStateRoot = label('stage1:genesis');
const deposit = { l2Recipient: label('stage1:l2-recipient') >> 96n, value: 1n * TON, fee: TON / 100n };
const depositAmount = deposit.value - deposit.fee;
const depositHashAfter = sha256Int(0n, deposit.l2Recipient, depositAmount);

const withdrawal = { leafIndex: 0, recipientHash: label('stage1:withdraw-recipient'), amount: TON / 4n };
// Дерево выводов с единственным листом 0: соседи — хеши пустых поддеревьев.
const siblings = [0n];
for (let level = 1; level < TREE_DEPTH; level++) siblings.push(sha256Int(siblings[level - 1], siblings[level - 1]));
let withdrawalsRoot = sha256Int(BigInt(withdrawal.leafIndex), withdrawal.recipientHash, withdrawal.amount);
for (const sibling of siblings) withdrawalsRoot = sha256Int(withdrawalsRoot, sibling);

// Данные батчей (data availability): батч 1 — без данных, батч 2 — две порции, вторая
// длиннее одной ячейки. Содержимое произвольное: игрушечная схема его не исполняет.
const batchData = [[], [chunkBytes('stage1:data-2a', 100), chunkBytes('stage1:data-2b', 700)]];

const batchValues = [
    {
        // Батч 1: депозит уже в очереди, но цель зафиксирована на генезисе — депозиты не обрабатываются.
        prevStateRoot: genesisStateRoot,
        newStateRoot: label('stage1:state-1'),
        batchHash: batchDataHash(batchData[0]),
        withdrawalsRoot: 0n,
        prevDepositHash: 0n,
        newDepositHash: 0n,
    },
    {
        // Батч 2: обязан обработать депозит и публикует корень дерева выводов.
        prevStateRoot: label('stage1:state-1'),
        newStateRoot: label('stage1:state-2'),
        batchHash: batchDataHash(batchData[1]),
        withdrawalsRoot,
        prevDepositHash: 0n,
        newDepositHash: depositHashAfter,
    },
];

// --- ключ и пруфы ---
const vkJson = JSON.parse(readFileSync(path.join(KEY_DIR, 'verification_key.json'), 'utf8'));
const key = parseVerificationKey(vkJson);
const prepared = buildVerificationKeyData(key, [0n], [0]);
const expectedVk = JSON.parse(readFileSync(path.join(KEY_DIR, 'onchain.json'), 'utf8')).hinted.vkDataBoc;
if (prepared.vkData.toBoc().toString('base64') !== expectedVk) {
    console.error('Ключ не совпал с fixtures/multiplier_bn254/onchain.json — перегенерируй фикстуру.');
    process.exit(1);
}

const s = (v) => v.toString();
const batches = [];
for (const [index, values] of batchValues.entries()) {
    const digest = batchDigest(values);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve({ a: digest.toString(), b: '1' }, wasm, zkey);
    if (BigInt(publicSignals[0]) !== digest || !(await snarkjs.groth16.verify(vkJson, publicSignals, proof))) {
        throw new Error(`Батч ${index + 1}: пруф не сошёлся с дайджестом`);
    }
    const { hints } = buildProofHints(key, prepared, parseProof(proof), [digest]);
    batches.push({
        roots: {
            newStateRoot: s(values.newStateRoot),
            withdrawalsRoot: s(values.withdrawalsRoot),
        },
        // Порции данных, которые секвенсор публикует до батча, и их накопительный хеш.
        dataChunksHex: batchData[index].map((chunk) => chunk.toString('hex')),
        batchHash: s(values.batchHash),
        publicInput: s(digest),
        proof: [
            proof.pi_a[0],
            proof.pi_a[1],
            proof.pi_b[0][0],
            proof.pi_b[0][1],
            proof.pi_b[1][0],
            proof.pi_b[1][1],
            proof.pi_c[0],
            proof.pi_c[1],
        ],
        hintsBoc: hints.toBoc().toString('base64'),
    });
    console.log(`  батч ${index + 1}: готово`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(
    path.join(OUT, 'batches.json'),
    JSON.stringify({
        source: 'Сгенерировано zk/gen-rollup-batches.mjs; не редактировать вручную',
        note: 'Пруфы игрушечной схемы Multiplier: публичный вход равен дайджесту батча, переход состояния НЕ доказывается',
        chainId: s(CHAIN_ID),
        genesisStateRoot: s(genesisStateRoot),
        deposit: {
            l2Recipient: s(deposit.l2Recipient),
            value: s(deposit.value),
            amount: s(depositAmount),
            hashAfter: s(depositHashAfter),
        },
        withdrawal: {
            leafIndex: withdrawal.leafIndex,
            recipientHash: s(withdrawal.recipientHash),
            amount: s(withdrawal.amount),
            siblings: siblings.map(s),
            root: s(withdrawalsRoot),
        },
        batches,
    }) + '\n',
);
console.log(`Записано: fixtures/rollup_batches/batches.json (батчей: ${batches.length})`);
process.exit(0); // snarkjs держит воркеры кривой
