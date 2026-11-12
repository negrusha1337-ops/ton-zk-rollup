// Импорт настоящего пруфа RISC Zero в раскладку snarkjs.
//
// Вход (скачивается вручную, см. fixtures/risc0_v3_test_receipt/source.json) —
// файлы из risc0/risc0-ethereum:
//   • contracts/src/groth16/Groth16Verifier.sol — ключ верификации;
//   • contracts/src/groth16/ControlID.sol — CONTROL_ROOT и BN254_CONTROL_ID;
//   • contracts/test/TestReceiptV3_1.sol — тестовая квитанция (seal, journal, image id).
// Публичные входы строятся так же, как в RiscZeroGroth16Verifier._verifyIntegrity.
//
// Запуск: node zk/import-risc0-fixture.mjs <Groth16Verifier.sol> <ControlID.sol> <TestReceipt.sol>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGroth16, g1Point, g2FromParts, solidityConstant, words32, writeFixture } from './import-common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'fixtures', 'risc0_v3_test_receipt');
const [verifierPath, controlPath, receiptPath] = process.argv.slice(2);
if (!verifierPath || !controlPath || !receiptPath) {
    console.error('Нужны три пути: Groth16Verifier.sol, ControlID.sol, TestReceipt.sol');
    process.exit(1);
}

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const hexConstant = (source, name, fileLabel) => {
    const match = new RegExp(`constant\\s+${name}\\s*=\\s*hex"([0-9a-fA-F]+)"`).exec(source);
    if (!match) throw new Error(`В ${fileLabel} нет константы ${name}`);
    return Buffer.from(match[1], 'hex');
};

// --- ключ (шаблон верификатора snarkjs: β, γ, δ лежат без отрицания) ---
const verifier = readFileSync(verifierPath, 'utf8');
const constant = (name) => solidityConstant(verifier, name, path.basename(verifierPath));
const g2 = (prefix) =>
    g2FromParts(
        [constant(`${prefix}x1`), constant(`${prefix}x2`)],
        [constant(`${prefix}y1`), constant(`${prefix}y2`)],
        prefix,
    );
const key = {
    alpha: g1Point(constant('alphax'), constant('alphay')),
    beta: g2('beta'),
    gamma: g2('gamma'),
    delta: g2('delta'),
    ic: [],
};
for (let i = 0; verifier.includes(`constant IC${i}x`); i++) {
    key.ic.push(g1Point(constant(`IC${i}x`), constant(`IC${i}y`)));
}

// --- квитанция ---
const control = readFileSync(controlPath, 'utf8');
const receipt = readFileSync(receiptPath, 'utf8');
const controlRoot = hexConstant(control, 'CONTROL_ROOT', path.basename(controlPath));
const bn254ControlId = hexConstant(control, 'BN254_CONTROL_ID', path.basename(controlPath));
const seal = hexConstant(receipt, 'SEAL', path.basename(receiptPath));
const journal = hexConstant(receipt, 'JOURNAL', path.basename(receiptPath));
const imageId = hexConstant(receipt, 'IMAGE_ID', path.basename(receiptPath));

// seal = selector ‖ abi(a[2], b[2][2], c[2])
const [ax, ay, b00, b01, b10, b11, cx, cy] = words32(seal.subarray(4).toString('hex'));
const proof = {
    A: g1Point(ax, ay),
    B: g2FromParts([b00, b01], [b10, b11], 'B'),
    C: g1Point(cx, cy),
};

// --- claim digest: ReceiptClaimLib.ok(imageId, sha256(journal)).digest() ---
const ZERO32 = Buffer.alloc(32);
const SYSTEM_STATE_ZERO_DIGEST = Buffer.from('a3acc27117418996340b84e5a90f3ef4c49d22c79e44aad822ec9c313e1eb8e2', 'hex');
const outputDigest = sha256(sha256(Buffer.from('risc0.Output')), sha256(journal), ZERO32, Buffer.from([0x02, 0x00]));
const claimDigest = sha256(
    sha256(Buffer.from('risc0.ReceiptClaim')),
    ZERO32, // input
    imageId, // состояние до
    SYSTEM_STATE_ZERO_DIGEST, // состояние после (остановлен)
    outputDigest,
    Buffer.alloc(4), // системный код выхода: Halted
    Buffer.alloc(4), // пользовательский код выхода: 0
    Buffer.from([0x04, 0x00]),
);

/** splitDigest: байты в обратном порядке, затем младшие и старшие 128 бит. */
function splitDigest(digest) {
    const reversed = BigInt('0x' + Buffer.from(digest).reverse().toString('hex'));
    return [reversed & ((1n << 128n) - 1n), reversed >> 128n];
}
const inputs = [
    ...splitDigest(controlRoot),
    ...splitDigest(claimDigest),
    BigInt('0x' + bn254ControlId.toString('hex')),
];

assertGroth16(key, proof, inputs, 'RISC Zero');

writeFixture(OUT, key, proof, inputs, {
    description: 'Настоящая квитанция RISC Zero (тестовая, из risc0-ethereum) и ключ её Groth16-верификатора',
    verifier: 'https://github.com/risc0/risc0-ethereum/blob/main/contracts/src/groth16/Groth16Verifier.sol',
    controlId: 'https://github.com/risc0/risc0-ethereum/blob/main/contracts/src/groth16/ControlID.sol',
    receipt: 'https://github.com/risc0/risc0-ethereum/blob/main/contracts/test/TestReceiptV3_1.sol',
    selector: '0x' + seal.subarray(0, 4).toString('hex'),
    imageId: '0x' + imageId.toString('hex'),
    journal: '0x' + journal.toString('hex'),
    claimDigest: '0x' + claimDigest.toString('hex'),
    // Корень управления и BN254_CONTROL_ID — константы версии; меняются только две половины claim digest.
    inputNames: ['controlRoot0', 'controlRoot1', 'claimDigest0', 'claimDigest1', 'bn254ControlId'],
    variableInputs: [2, 3],
});
console.log(
    `Квитанция RISC Zero проверена эталонной библиотекой и записана в fixtures/risc0_v3_test_receipt (входов: ${inputs.length}).`,
);
console.log('Публичные входы:', inputs.map((v) => '0x' + v.toString(16)).join(', '));
