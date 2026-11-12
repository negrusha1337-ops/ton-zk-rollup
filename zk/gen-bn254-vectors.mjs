// Эталонные векторы для программного спаривания BN254: считаются библиотекой
// @noble/curves и сохраняются в fixtures/bn254/vectors.json. Тесты сравнивают
// с ними каждую ступень реализации на Tolk. Значения детерминированы.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bn254 } from '@noble/curves/bn254.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Fp, Fp12, Fr } = bn254.fields;

const hashToInt = (label) => BigInt('0x' + createHash('sha256').update(label).digest('hex'));
const fpFrom = (label) => hashToInt(label) % Fp.ORDER;
const scalarFrom = (label) => (hashToInt(label) % (Fr.ORDER - 1n)) + 1n;

/** Fp12 → 12 чисел в порядке полей структуры Tolk (c0.c0.c0, c0.c0.c1, c0.c1.c0, ...). */
const flat12 = (f) =>
    [f.c0, f.c1].flatMap((six) => [six.c0, six.c1, six.c2].flatMap((two) => [two.c0, two.c1])).map(String);

const fp12From = (label) => {
    const v = Array.from({ length: 12 }, (_, i) => fpFrom(`${label}:${i}`));
    const two = (i) => ({ c0: v[i], c1: v[i + 1] });
    const six = (i) => ({ c0: two(i), c1: two(i + 2), c2: two(i + 4) });
    return { c0: six(0), c1: six(6) };
};

const g1 = (scalar) => bn254.G1.Point.BASE.multiply(scalar);
const g2 = (scalar) => bn254.G2.Point.BASE.multiply(scalar);
const g1Flat = (point) => {
    const { x, y } = point.toAffine();
    return [x, y].map(String);
};
const g2Flat = (point) => {
    const { x, y } = point.toAffine();
    return [x.c0, x.c1, y.c0, y.c1].map(String);
};

const a = fp12From('a');
const b = fp12From('b');
const P = g1(scalarFrom('p'));
const Q = g2(scalarFrom('q'));
const miller = bn254.pairing(P, Q, false);
const gt = Fp12.finalExponentiate(miller);

// Билинейность: e(sP, Q) · e(−P, sQ) = 1.
const s = scalarFrom('s');
const bilinear = [
    { g1: g1Flat(P.multiply(s)), g2: g2Flat(Q) },
    { g1: g1Flat(P.negate()), g2: g2Flat(Q.multiply(s)) },
];

const vectors = {
    source: 'Сгенерировано zk/gen-bn254-vectors.mjs из @noble/curves; не редактировать вручную',
    fp12: {
        a: flat12(a),
        b: flat12(b),
        mul: flat12(Fp12.mul(a, b)),
        sqr: flat12(Fp12.sqr(a)),
        inv: flat12(Fp12.inv(a)),
        frobenius: [1, 2, 3].map((power) => flat12(Fp12.frobeniusMap(a, power))),
    },
    pairing: {
        g1: g1Flat(P),
        g2: g2Flat(Q),
        millerLoop: flat12(miller),
        finalExp: flat12(gt),
        // gt лежит в циклотомической подгруппе — на нём проверяется быстрый квадрат.
        gtSquared: flat12(Fp12.mul(gt, gt)),
    },
    bilinear,
};

const dir = path.join(ROOT, 'fixtures', 'bn254');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'vectors.json'), JSON.stringify(vectors, null, 2) + '\n');
console.log('Записано: fixtures/bn254/vectors.json');
