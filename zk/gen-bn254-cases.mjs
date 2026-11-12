// Набор разных пруфов одной схемы (Multiplier на BN254) для прогона верификатора:
// крайние значения публичного входа и несколько случайных. Нужен, чтобы поймать
// отказы, зависящие от данных (переполнения ленивой арифметики), и увидеть разброс газа.
//
// Требует локальных артефактов сборки схемы: сначала `node zk/build.mjs multiplier_bn254`.
// Результат: fixtures/multiplier_bn254/cases.json (ключ — тот же, что в onchain.json).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { bn254 } from '@noble/curves/bn254.js';
import { buildProofHints, buildVerificationKeyData, parseProof, parseVerificationKey } from './bn254-onchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'circuits', 'build', 'multiplier_bn254');
const DIR = path.join(ROOT, 'fixtures', 'multiplier_bn254');
const wasm = path.join(BUILD, 'Multiplier_js', 'Multiplier.wasm');
const zkey = path.join(BUILD, 'circuit_final.zkey');
if (!existsSync(wasm) || !existsSync(zkey)) {
    console.error(
        'Нет артефактов схемы. Сначала: node zk/build.mjs multiplier_bn254, затем gen-bn254-groth16-fixture.',
    );
    process.exit(1);
}

const r = bn254.fields.Fr.ORDER;
const random = (label) => BigInt('0x' + createHash('sha256').update(label).digest('hex')) % r;
// Публичный выход схемы c = a · b; берём b = 1, чтобы задавать c напрямую.
const publicValues = [
    { label: 'ноль', value: 0n },
    { label: 'единица', value: 1n },
    { label: 'r − 1 (наибольший скаляр)', value: r - 1n },
    { label: 'все цифры окна ненулевые', value: (1n << 252n) - 1n },
    ...[0, 1, 2, 3].map((i) => ({ label: `случайный ${i}`, value: random(`stage0:bn254-case:${i}`) })),
];

const vkJson = JSON.parse(readFileSync(path.join(DIR, 'verification_key.json'), 'utf8'));
const key = parseVerificationKey(vkJson);
const prepared = buildVerificationKeyData(key, [0n], [0]);
const expectedVk = JSON.parse(readFileSync(path.join(DIR, 'onchain.json'), 'utf8')).hinted.vkDataBoc;
if (prepared.vkData.toBoc().toString('base64') !== expectedVk) {
    console.error('Ключ не совпал с onchain.json — перегенерируй фикстуру.');
    process.exit(1);
}

const cases = [];
for (const { label, value } of publicValues) {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve({ a: value.toString(), b: '1' }, wasm, zkey);
    if (!(await snarkjs.groth16.verify(vkJson, publicSignals, proof))) {
        throw new Error(`snarkjs отверг собственный пруф для случая «${label}» — ключ и zkey из разных сборок`);
    }
    const { hints, onchainInputs } = buildProofHints(key, prepared, parseProof(proof), publicSignals.map(BigInt));
    cases.push({
        label,
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
        inputs: onchainInputs.map(String),
        hintsBoc: hints.toBoc().toString('base64'),
    });
    console.log(`  ${label}: готово`);
}

writeFileSync(
    path.join(DIR, 'cases.json'),
    JSON.stringify({ source: 'Сгенерировано zk/gen-bn254-cases.mjs; не редактировать вручную', cases }) + '\n',
);
console.log(`Записано: fixtures/multiplier_bn254/cases.json (случаев: ${cases.length})`);
process.exit(0); // snarkjs держит воркеры кривой
