// Спайк агрегации: проверка пруфа Groth16 SP1 эталонной библиотекой — ровно те же шаги, что в
// zk/import-sp1-fixture.mjs (selector, exitCode, vkRoot, нонс 0, спаривание под закреплённым
// ключом схемы v6.1.0). Импортёр агрегатный пруф не примет: он сверяет ключ программы с
// program.json EVM, а у агрегатора свой ключ. Общие файлы не меняются: отсюда только вызовы
// экспортов zk/sp1-verifier.mjs.
//
//   node zkvm-evm/spike-aggregate/ton/check-proof.mjs <пруф.json> <каталог> --vkey <0x…> --public-values <0x…>
//
// В <каталог> пишется раскладка snarkjs (verification_key, proof, public, source.json), которую
// читает zk/gen-bn254-groth16-fixture.mjs --dir. Переменные входы — [1, 4] (дайджест и нонс),
// как у фикстуры sp1_v6_fibonacci: общий верификатор contracts/bn254_groth16_verifier.tolk берёт
// ровно два переменных входа.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bn254 } from '@noble/curves/bn254.js';
import { g2FromParts, loadSp1Verifier, sp1CircuitDir, verificationKeyJson } from '../../../zk/sp1-verifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CIRCUIT_VERSION = 'v6.1.0';
const args = process.argv.slice(2);
const flag = (name) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1]) throw new Error(`нужен ${name}`);
    return args[index + 1];
};
const [proofPath, outDir] = args;
if (!proofPath || !outDir) throw new Error('нужны <пруф.json> <каталог>');
if (path.resolve(outDir).startsWith(path.join(ROOT, 'fixtures') + path.sep)) throw new Error('каталог — вне fixtures/');
const expectedVkey = BigInt(flag('--vkey'));
const expectedPublicValues = flag('--public-values').toLowerCase();

const dir = sp1CircuitDir(CIRCUIT_VERSION);
const verifier = loadSp1Verifier(path.join(dir, 'Groth16Verifier.sol'), path.join(dir, 'SP1VerifierGroth16.sol'));
const { alpha, beta, gamma, delta, ic } = verifier.key;
const fixture = JSON.parse(readFileSync(proofPath, 'utf8'));
if (BigInt(fixture.vkey) !== expectedVkey) throw new Error(`ключ программы пруфа ${fixture.vkey} — не ожидаемый`);
if (fixture.publicValues.toLowerCase() !== expectedPublicValues) throw new Error('публичные значения пруфа — не ожидаемые');

const proofBytes = Buffer.from(fixture.proof.slice(2), 'hex');
if (proofBytes.length !== 4 + 11 * 32) throw new Error(`длина пруфа ${proofBytes.length}`);
const selector = '0x' + proofBytes.subarray(0, 4).toString('hex');
if (selector !== verifier.verifierHash.slice(0, 10)) throw new Error(`selector ${selector}`);
const words = [];
for (let offset = 4; offset < proofBytes.length; offset += 32) words.push(BigInt('0x' + proofBytes.subarray(offset, offset + 32).toString('hex')));
const [exitCode, vkRoot, nonce, ax, ay, bx1, bx0, by1, by0, cx, cy] = words;
if (exitCode !== 0n) throw new Error('exitCode не 0');
if (vkRoot !== BigInt(verifier.vkRoot)) throw new Error('vkRoot не совпал');
if (nonce !== 0n) throw new Error(`нонс ${nonce}`);
const G1 = bn254.G1.Point;
const A = G1.fromAffine({ x: ax, y: ay });
const B = g2FromParts([bx1, bx0], [by1, by0], 'B');
const C = G1.fromAffine({ x: cx, y: cy });
A.assertValidity();
C.assertValidity();

const publicValues = Buffer.from(fixture.publicValues.slice(2), 'hex');
const digest = BigInt('0x' + createHash('sha256').update(publicValues).digest('hex')) & ((1n << 253n) - 1n);
const inputs = [BigInt(fixture.vkey), digest, exitCode, vkRoot, nonce];
if (inputs.length + 1 !== ic.length) throw new Error('число входов ≠ числу IC-точек');
const vkX = inputs.reduce((acc, value, i) => (value === 0n ? acc : acc.add(ic[i + 1].multiply(value))), ic[0]);
const check = bn254.pairingBatch([
    { g1: A.negate(), g2: B },
    { g1: alpha, g2: beta },
    { g1: vkX, g2: gamma },
    { g1: C, g2: delta },
]);
if (!bn254.fields.Fp12.eql(check, bn254.fields.Fp12.ONE)) throw new Error('пруф НЕ прошёл проверку спариванием');

const s = (v) => v.toString();
const g1Json = (point) => [s(point.toAffine().x), s(point.toAffine().y), '1'];
const { x, y } = B.toAffine();
mkdirSync(outDir, { recursive: true });
const write = (file, data) => writeFileSync(path.join(outDir, file), JSON.stringify(data, null, 1) + '\n');
write('verification_key.json', verificationKeyJson(verifier.key));
write('proof.json', {
    pi_a: g1Json(A),
    pi_b: [[s(x.c0), s(x.c1)], [s(y.c0), s(y.c1)], ['1', '0']],
    pi_c: g1Json(C),
    protocol: 'groth16',
    curve: 'bn128',
});
write('public.json', inputs.map(s));
write('source.json', {
    description: `Спайк агрегации: ${fixture.subject}`,
    verifierHash: verifier.verifierHash,
    programVKey: fixture.vkey,
    publicValues: fixture.publicValues,
    inputNames: ['programVKey', 'publicValuesDigest', 'exitCode', 'vkRoot', 'nonce'],
    variableInputs: [1, 4],
});
console.log(`${proofPath}: пруф SP1 ${CIRCUIT_VERSION} прошёл проверку спариванием (ключ ${fixture.vkey}); раскладка — ${outDir}`);
