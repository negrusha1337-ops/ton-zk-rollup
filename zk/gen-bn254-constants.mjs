// Генерирует contracts/bn254/constants.tolk: константы башни полей BN254,
// посчитанные эталонной библиотекой @noble/curves. Руками не править.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bn254 } from '@noble/curves/bn254.js';
import { ATE_NAF } from './bn254-params.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Fp, Fp2, Fp6, Fp12 } = bn254.fields;
const p = Fp.ORDER;
const xi = Fp2.NONRESIDUE; // 9 + u

const naf = ATE_NAF;
// Цифра i (от старшей) лежит в бите (len - 1 - i).
const mask = (pred) => naf.reduce((acc, d, i) => (pred(d) ? acc | (1n << BigInt(naf.length - 1 - i)) : acc), 0n);

const fp2 = (name, v) => `const ${name}_C0: int = ${v.c0}\nconst ${name}_C1: int = ${v.c1}`;

const lines = [
    '// СГЕНЕРИРОВАНО: node zk/gen-bn254-constants.mjs (значения из @noble/curves). Не править руками.',
    '',
    '/// Модуль базового поля BN254.',
    `const BN254_P: int = ${p}`,
    '/// Порядок группы (скалярное поле).',
    `const BN254_R: int = ${bn254.fields.Fr.ORDER}`,
    '/// 1/2 mod p.',
    `const BN254_INV2: int = ${Fp.inv(2n)}`,
    '',
    '/// Коэффициент b скрученной кривой: 3 / (9 + u).',
    fp2('BN254_TWIST_B', Fp2.div(Fp2.fromBigTuple([3n, 0n]), xi)),
    '',
    '/// NAF-разложение 6x+2: длина и битовые маски (старшая цифра — в старшем бите).',
    `const BN254_NAF_LEN: int = ${naf.length}`,
    `const BN254_NAF_NONZERO: int = ${mask((d) => d !== 0)}`,
    `const BN254_NAF_NEGATIVE: int = ${mask((d) => d === -1)}`,
    '',
    '/// Коэффициенты эндоморфизма psi (Фробениус на скрученной кривой).',
    fp2('BN254_PSI_X', Fp2.pow(xi, (p - 1n) / 3n)),
    fp2('BN254_PSI_Y', Fp2.pow(xi, (p - 1n) / 2n)),
    '',
    '/// Коэффициенты Фробениуса для Fp6 (степени 1..3) и Fp12 (степени 1..3).',
];
for (const power of [1, 2, 3]) {
    lines.push(fp2(`BN254_FROB6_1_P${power}`, Fp6.FROBENIUS_COEFFICIENTS_1[power]));
    lines.push(fp2(`BN254_FROB6_2_P${power}`, Fp6.FROBENIUS_COEFFICIENTS_2[power]));
    lines.push(fp2(`BN254_FROB12_P${power}`, Fp12.FROBENIUS_COEFFICIENTS[power]));
}

// Фробениус в представлении Fp[x]/(x¹² − 18x⁶ + 82): (x^k)^(p^j) = x^k · ξ^(k(p^j − 1)/6).
lines.push('');
lines.push('/// Множители Фробениуса степени j для x^k: ξ^(k·(p^j − 1)/6), j = 1..3, k = 1..5.');
for (const power of [1, 2, 3]) {
    for (let k = 1; k <= 5; k++) {
        lines.push(fp2(`BN254_FROBX_P${power}_K${k}`, Fp2.pow(xi, (BigInt(k) * (p ** BigInt(power) - 1n)) / 6n)));
    }
}

const file = path.join(ROOT, 'contracts', 'bn254', 'constants.tolk');
writeFileSync(file, lines.join('\n') + '\n');
console.log(
    `Записано: ${path.relative(ROOT, file)} (NAF: ${naf.length} цифр, ненулевых ${naf.filter(Boolean).length})`,
);
