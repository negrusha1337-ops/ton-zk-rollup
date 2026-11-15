// Батчи для сквозного теста rollup-контракта протокола v2 с НАСТОЯЩЕЙ проверкой пруфа.
//
// Пруф здесь строится игрушечной схемой Multiplier (BN254): её единственный публичный
// вход можно сделать равным любому числу, и мы делаем его равным дайджесту публичных
// значений батча (одиннадцать слов, PROTOCOL-V2.md). Переход состояния такой пруф НЕ
// доказывает — он нужен, чтобы контракт прошёл весь настоящий путь: дайджест → верификатор →
// смена состояния, и чтобы измерить газ SubmitBatch без пруфов SP1.
//
// Что в фикстуре:
//   • три батча полного пути (очередь L1 с депозитом и принудительной транзакцией, отметка
//     очереди в середине и на голове, данные, дерево выводов) — у каждого «лучшая подделка»
//     и пруф с испорченной точкой;
//   • wordForgeries — пруф батча 3 с ЧЕСТНЫМИ подсказками под дайджест, в котором подменено
//     одно из одиннадцати слов: тест приводит контракт в состояние, где он требует именно этот
//     дайджест, и ждёт отказа замыкающим равенством (7300) — по случаю на слово;
//   • fullQueue — батч для замера газа на словаре очереди, заполненном до предела;
//   • attacks — честный пруф батча, построенного от поддельного прежнего дерева выводов.
//
// Требует локальных артефактов: node zk/build.mjs multiplier_bn254.
// Результат: fixtures/rollup_batches/batches.json. Сценарий должен совпадать с
// tests/RollupProof.spec.ts.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3';
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

/** Слова публичных значений по порядку — как batchPublicValueWords в wrappers/rollupMath.ts. */
const WORDS = [
    'chainId',
    'prevStateRoot',
    'newStateRoot',
    'batchHash',
    'prevWithdrawalsRoot',
    'withdrawalsRoot',
    'prevDepositHash',
    'newDepositHash',
    'prevWithdrawalsCount',
    'withdrawalsCount',
    'blockTimestamp',
];
const batchDigest = (v) => sha256Int(...WORDS.map((word) => v[word])) & MASK_253;

// Очередь L1 — как в contracts/rollup/logic.tolk (pushQueueItem) и wrappers/rollupMath.ts.
const FORCED_TRANSACTION_MARKER = 1n << 255n;
const depositHash = (previous, l2Recipient, amount) => sha256Int(previous, l2Recipient, amount);
const forcedTransactionHash = (previous, bytes) =>
    sha256Int(previous, FORCED_TRANSACTION_MARKER, BigInt('0x' + Buffer.from(keccak_256(bytes)).toString('hex')));

// Дерево выводов: лист sha256(номер ‖ хеш получателя ‖ сумма), пустой лист — 0; корень дерева
// из первых n листьев (n > 0) — свёртка с хешами пустых поддеревьев.
const emptySubtrees = [0n];
for (let level = 0; level < TREE_DEPTH; level++) emptySubtrees.push(sha256Int(emptySubtrees[level], emptySubtrees[level]));
const leafHash = (leaf) => sha256Int(BigInt(leaf.leafIndex), leaf.recipientHash, leaf.amount);
function withdrawalsRootOf(leaves) {
    if (leaves.length === 0) return 0n;
    let level = leaves.map(leafHash);
    for (let depth = 0; depth < TREE_DEPTH; depth++) {
        const next = [];
        for (let index = 0; index < level.length; index += 2) {
            next.push(sha256Int(level[index], level[index + 1] ?? emptySubtrees[depth]));
        }
        level = next;
    }
    return level[0];
}

// --- сценарий ---
const TON = 1_000_000_000n;
// Идентификатор rollup'а этого сценария: тест развёртывает контракт с ним же.
const CHAIN_ID = 20261113n;
// Начальное слово состояния — хеш генезиса протокола: с другим контракт v2 не фиксирует ключ.
// Берётся у цепочки L2 (тест сверяет его с константой контракта).
const genesisStateRoot = BigInt(
    JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'evm_batches', 'reth', 'expected.json'), 'utf8')).genesisHash,
);
// Время блоков L2: тест принимает батч через минуту после времени его блока.
const BLOCK_TIME = [1_900_000_000n, 1_900_000_600n, 1_900_001_200n];

// Очередь L1: депозит встаёт до батча 1, принудительная транзакция — между батчами 1 и 2.
const deposit = { l2Recipient: label('stage1:l2-recipient') >> 96n, value: 1n * TON, fee: TON / 100n };
const depositAmount = deposit.value - deposit.fee;
const forcedTransaction = chunkBytes('stage1:forced-transaction', 150);
const queueHash = [0n];
queueHash.push(depositHash(queueHash[0], deposit.l2Recipient, depositAmount));
queueHash.push(forcedTransactionHash(queueHash[1], forcedTransaction));

// Дерево выводов: батч 2 публикует первый лист, батч 3 дозаписывает второй.
const withdrawals = [
    { leafIndex: 0, recipientHash: label('stage1:withdraw-recipient'), amount: TON / 4n },
    { leafIndex: 1, recipientHash: label('stage1:withdraw-recipient-2'), amount: TON / 10n },
];
const rootAfter = [0n, withdrawalsRootOf(withdrawals.slice(0, 1)), withdrawalsRootOf(withdrawals)];

// Данные батчей (data availability): батч 1 — без данных, батч 2 — две порции, вторая
// длиннее одной ячейки, батч 3 — одна. Содержимое произвольное: игрушечная схема его не исполняет.
const batchData = [
    [],
    [chunkBytes('stage1:data-2a', 100), chunkBytes('stage1:data-2b', 700)],
    [chunkBytes('stage1:data-3', 300)],
];

const batchValues = [
    {
        // Батч 1: в очереди депозит, но блок его не обработал — отметка N = 0 в середине очереди
        // (хеш в точке N контракт берёт из словаря очереди).
        chainId: CHAIN_ID,
        prevStateRoot: genesisStateRoot,
        newStateRoot: label('stage1:state-1'),
        batchHash: batchDataHash(batchData[0]),
        prevWithdrawalsRoot: 0n,
        withdrawalsRoot: 0n,
        prevDepositHash: queueHash[0],
        newDepositHash: queueHash[0],
        prevWithdrawalsCount: 0n,
        withdrawalsCount: 0n,
        blockTimestamp: BLOCK_TIME[0],
        queueProcessedUpTo: 0n,
    },
    {
        // Батч 2: обрабатывает депозит (N = 1; в очереди уже два элемента — отметка снова в
        // середине), публикует данные и первый лист дерева выводов.
        chainId: CHAIN_ID,
        prevStateRoot: label('stage1:state-1'),
        newStateRoot: label('stage1:state-2'),
        batchHash: batchDataHash(batchData[1]),
        prevWithdrawalsRoot: rootAfter[0],
        withdrawalsRoot: rootAfter[1],
        prevDepositHash: queueHash[0],
        newDepositHash: queueHash[1],
        prevWithdrawalsCount: 0n,
        withdrawalsCount: 1n,
        blockTimestamp: BLOCK_TIME[1],
        queueProcessedUpTo: 1n,
    },
    {
        // Батч 3: обрабатывает принудительную транзакцию (N = 2 — голова очереди) и продолжает
        // НЕнулевые прежние корень и счётчик выводов. Все одиннадцать слов ненулевые: на нём
        // проверяется подмена каждого слова.
        chainId: CHAIN_ID,
        prevStateRoot: label('stage1:state-2'),
        newStateRoot: label('stage1:state-3'),
        batchHash: batchDataHash(batchData[2]),
        prevWithdrawalsRoot: rootAfter[1],
        withdrawalsRoot: rootAfter[2],
        prevDepositHash: queueHash[1],
        newDepositHash: queueHash[2],
        prevWithdrawalsCount: 1n,
        withdrawalsCount: 2n,
        blockTimestamp: BLOCK_TIME[2],
        queueProcessedUpTo: 2n,
    },
];
if (WORDS.some((word) => batchValues[2][word] === 0n)) throw new Error('В батче 3 все слова обязаны быть ненулевыми');

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
const proofArray = (proof) => [
    proof.pi_a[0],
    proof.pi_a[1],
    proof.pi_b[0][0],
    proof.pi_b[0][1],
    proof.pi_b[1][0],
    proof.pi_b[1][1],
    proof.pi_c[0],
    proof.pi_c[1],
];
/** Пруф игрушечной схемы, чей публичный вход равен `digest`, и подсказки к нему. */
async function proveDigest(digest, what) {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve({ a: digest.toString(), b: '1' }, wasm, zkey);
    if (BigInt(publicSignals[0]) !== digest || !(await snarkjs.groth16.verify(vkJson, publicSignals, proof))) {
        throw new Error(`${what}: пруф не сошёлся с дайджестом`);
    }
    const points = parseProof(proof);
    return { proof, points, hints: buildProofHints(key, prepared, points, [digest]).hints };
}
/**
 * «Лучшая подделка»: настоящий пруф предъявлен под другой публичный вход, а все
 * подсказки посчитаны честно для этого ложного утверждения. Не сходится только
 * замыкающее равенство — контракт обязан отказать именно на нём (WrongProof).
 */
const forgedHints = (points, falseDigest) =>
    buildProofHints(key, prepared, points, [falseDigest], { forge: true }).hints.toBoc().toString('base64');
/**
 * Подделка второго вида: вход верный, а сам пруф испорчен — к точке C прибавлена образующая
 * (точка остаётся на кривой). Подсказки снова честные для этого негодного пруфа.
 */
function tamperedProof(points, digest) {
    const tampered = { ...points, C: points.C.add(points.C.constructor.BASE) };
    const { x, y } = tampered.C.toAffine();
    return {
        c: [s(x), s(y)],
        hintsBoc: buildProofHints(key, prepared, tampered, [digest], { forge: true }).hints.toBoc().toString('base64'),
    };
}
const rootsOf = (values) => ({
    newStateRoot: s(values.newStateRoot),
    withdrawalsRoot: s(values.withdrawalsRoot),
    withdrawalsCount: s(values.withdrawalsCount),
    queueProcessedUpTo: s(values.queueProcessedUpTo),
    blockTimestamp: s(values.blockTimestamp),
});
const wordsOf = (values) => Object.fromEntries(WORDS.map((word) => [word, s(values[word])]));

const batches = [];
let batch3Points;
for (const [index, values] of batchValues.entries()) {
    const digest = batchDigest(values);
    const { proof, points, hints } = await proveDigest(digest, `Батч ${index + 1}`);
    if (index === 2) batch3Points = points;
    // Подделка: тот же пруф под батч с другим новым словом состояния.
    const forgedStateRoot = label(`stage1:forged-state-${index + 1}`);
    batches.push({
        forgery: {
            newStateRoot: s(forgedStateRoot),
            publicInput: s(batchDigest({ ...values, newStateRoot: forgedStateRoot })),
            hintsBoc: forgedHints(points, batchDigest({ ...values, newStateRoot: forgedStateRoot })),
        },
        tamperedProof: tamperedProof(points, digest),
        roots: rootsOf(values),
        // Порции данных, которые секвенсор публикует до батча, и их накопительный хеш.
        dataChunksHex: batchData[index].map((chunk) => chunk.toString('hex')),
        publicValues: wordsOf(values),
        publicInput: s(digest),
        proof: proofArray(proof),
        hintsBoc: hints.toBoc().toString('base64'),
    });
    console.log(`  батч ${index + 1}: готово`);
}

// --- подмена каждого из одиннадцати слов ---
// Пруф батча 3 остаётся настоящим — для настоящих слов. Для каждого слова считается дайджест,
// в котором подменено только оно, и ЧЕСТНЫЕ подсказки пруфа батча 3 под этот дайджест. Тест
// приводит контракт в состояние, где он требует именно такой дайджест (слово из сообщения —
// меняет сообщение; слово из хранилища — меняет хранилище), и ждёт отказа замыкающим
// равенством: пруф привязан к каждому слову, а не только к тем, что приходят в сообщении.
// Подмена — прибавление единицы: счётчики и время остаются правдоподобными.
const wordForgeries = WORDS.map((word, index) => {
    const altered = { ...batchValues[2], [word]: batchValues[2][word] + 1n };
    return {
        word,
        index,
        alteredValue: s(altered[word]),
        publicInput: s(batchDigest(altered)),
        hintsBoc: forgedHints(batch3Points, batchDigest(altered)),
    };
});
console.log('  подмена каждого слова: готово');

// --- батч на словаре очереди, заполненном до предела: замер газа ---
// Состояние контракта подкладывает тест: словарь очереди из MAX_TRACKED_ITEMS − 1 записей,
// отметка батча — в середине очереди, на MAX_BATCH_QUEUE_ITEMS элементов дальше прежней (хеш в
// точке N берётся поиском в полном словаре). Номера элементов в дайджест не входят — их
// выбирает тест; сюда входят только хеши очереди в прежней отметке и в точке N.
const fullQueueValues = {
    chainId: CHAIN_ID,
    prevStateRoot: label('stage1:full-queue-state'),
    newStateRoot: label('stage1:full-queue-state-next'),
    batchHash: batchDataHash([chunkBytes('stage1:full-queue-data', 500)]),
    prevWithdrawalsRoot: label('stage1:full-queue-withdrawals'),
    withdrawalsRoot: label('stage1:full-queue-withdrawals-next'),
    prevDepositHash: label('stage1:full-queue-processed-hash'),
    newDepositHash: label('stage1:full-queue-hash-at-mark'),
    prevWithdrawalsCount: 4_000_000_000n,
    withdrawalsCount: 4_000_000_032n,
    blockTimestamp: BLOCK_TIME[2],
};
const provenFullQueue = await proveDigest(batchDigest(fullQueueValues), 'Батч на полном словаре');
const fullQueue = {
    note: 'Батч для замера газа на словаре очереди, заполненном до предела; состояние контракта подкладывает тест',
    batchIndexBefore: 41,
    dataChunksHex: [chunkBytes('stage1:full-queue-data', 500).toString('hex')],
    publicValues: wordsOf(fullQueueValues),
    publicInput: s(batchDigest(fullQueueValues)),
    proof: proofArray(provenFullQueue.proof),
    hintsBoc: provenFullQueue.hints.toBoc().toString('base64'),
    forgery: {
        newStateRoot: s(label('stage1:full-queue-forged-state')),
        publicInput: s(batchDigest({ ...fullQueueValues, newStateRoot: label('stage1:full-queue-forged-state') })),
        hintsBoc: forgedHints(
            provenFullQueue.points,
            batchDigest({ ...fullQueueValues, newStateRoot: label('stage1:full-queue-forged-state') }),
        ),
    },
};
console.log('  батч на полном словаре: готово');

// --- атака «приписать лист в дерево выводов» (REVIEW.md, круг 1, находка 2; PROTOCOL-V2.md, раздел 4) ---
// Секвенсор строит батч 3 от ПОДДЕЛЬНОГО прежнего дерева выводов (в нём лишний лист в его
// пользу: другой корень и счётчик на единицу больше) и публикует корень, включающий этот лист.
// Пруф честный — для того утверждения, которое секвенсор выбрал сам. Контракт подставляет
// прежние корень и счётчик из своего хранилища, и утверждения расходятся: пруф не подходит.
const forgedPriorValues = {
    ...batchValues[2],
    prevWithdrawalsRoot: label('stage1:forged-prior-withdrawals'),
    prevWithdrawalsCount: 2n,
    withdrawalsRoot: label('stage1:withdrawals-root-with-planted-leaf'),
    withdrawalsCount: 3n,
};
const forgedPrior = await proveDigest(batchDigest(forgedPriorValues), 'Батч 3 от поддельного дерева');
const attacks = {
    forgedPriorWithdrawals: {
        note: 'Честный пруф батча 3, построенного от поддельных прежних корня и счётчика выводов',
        roots: rootsOf(forgedPriorValues),
        claimedPrevWithdrawalsRoot: s(forgedPriorValues.prevWithdrawalsRoot),
        claimedPrevWithdrawalsCount: s(forgedPriorValues.prevWithdrawalsCount),
        publicInput: s(batchDigest(forgedPriorValues)),
        proof: proofArray(forgedPrior.proof),
        hintsBoc: forgedPrior.hints.toBoc().toString('base64'),
    },
};
console.log('  атака на дерево выводов: готово');

mkdirSync(OUT, { recursive: true });
writeFileSync(
    path.join(OUT, 'batches.json'),
    JSON.stringify({
        source: 'Сгенерировано zk/gen-rollup-batches.mjs; не редактировать вручную',
        note: 'Пруфы игрушечной схемы Multiplier под протокол версии 2: публичный вход равен дайджесту одиннадцати слов батча, переход состояния НЕ доказывается',
        protocolVersion: 2,
        chainId: s(CHAIN_ID),
        genesisStateRoot: s(genesisStateRoot),
        words: WORDS,
        deposit: {
            l2Recipient: s(deposit.l2Recipient),
            value: s(deposit.value),
            amount: s(depositAmount),
        },
        forcedTransactionHex: forcedTransaction.toString('hex'),
        queueHashes: queueHash.map(s),
        withdrawals: withdrawals.map((leaf, index) => ({
            leafIndex: leaf.leafIndex,
            recipientHash: s(leaf.recipientHash),
            amount: s(leaf.amount),
            rootAfter: s(rootAfter[index + 1]),
        })),
        batches,
        wordForgeries,
        fullQueue,
        attacks,
    }) + '\n',
);
console.log(`Записано: fixtures/rollup_batches/batches.json (батчей: ${batches.length}, подмен слов: ${wordForgeries.length})`);
process.exit(0); // snarkjs держит воркеры кривой
