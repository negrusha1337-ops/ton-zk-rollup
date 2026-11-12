// Свидетель для проверки спаривания без финального возведения в степень
// (Novakovic, Eagen — «On Proving Pairings», eprint 2024/640).
//
// Если произведение спариваний равно 1, то для выхода цикла Миллера f существуют
// c ∈ Fp12 и w ∈ Fp6 такие, что  f · w = c^λ,  λ = 6x + 2 + q − q² + q³.
// Контракту достаточно проверить это равенство — оно дешевле возведения в
// степень (q¹² − 1)/r. Алгоритм поиска (c, w) перенесён из эталонной реализации
// Garaga (hydra/garaga/hints/multi_miller_witness.py).
import { bn254 } from '@noble/curves/bn254.js';

const { Fp, Fp12, Fr } = bn254.fields;
const q = Fp.ORDER;
const r = Fr.ORDER;
const BN_X = 4965661367192848881n;

export const LAMBDA = 6n * BN_X + 2n + q - q ** 2n + q ** 3n;
const GROUP_ORDER = q ** 12n - 1n;
const h = GROUP_ORDER / r;

function gcd(a, b) {
    while (b !== 0n) [a, b] = [b, a % b];
    return a;
}

function modInverse(value, modulus) {
    let [oldR, rem] = [((value % modulus) + modulus) % modulus, modulus];
    let [oldS, s] = [1n, 0n];
    while (rem !== 0n) {
        const quotient = oldR / rem;
        [oldR, rem] = [rem, oldR - quotient * rem];
        [oldS, s] = [s, oldS - quotient * s];
    }
    if (oldR !== 1n) throw new Error('modInverse: числа не взаимно просты');
    return ((oldS % modulus) + modulus) % modulus;
}

/** scalar = base^k · l, где l не делится на base. */
function splitPowers(scalar, base) {
    let k = 0n;
    let l = scalar;
    while (l % base === 0n) {
        l /= base;
        k += 1n;
    }
    return { k, l };
}

const fp2 = (c0, c1) => ({ c0, c1 });
const ZERO2 = fp2(0n, 0n);

/** Корень 27-й степени из единицы (не являющийся корнем 9-й), лежит в Fp6. */
export const ROOT_27 = {
    c0: {
        c0: ZERO2,
        c1: ZERO2,
        c2: fp2(
            8204864362109909869166472767738877274689483185363591877943943203703805152849n,
            17912368812864921115467448876996876278487602260484145953989158612875588124088n,
        ),
    },
    c1: { c0: ZERO2, c1: ZERO2, c2: ZERO2 },
};

const isOne = (value) => Fp12.eql(value, Fp12.ONE);

function checkConstants() {
    if (!isOne(Fp12.pow(ROOT_27, 27n)) || isOne(Fp12.pow(ROOT_27, 9n))) {
        throw new Error('ROOT_27 не является первообразным корнем 27-й степени в этой башне полей');
    }
    if (LAMBDA % r !== 0n) throw new Error('λ должно делиться на r');
}

/** Порядок элемента как степени тройки: наименьшее t, при котором a^(3^t) = 1. */
function cubeOrderExponent(value) {
    let t = 0;
    let current = value;
    while (!isOne(current)) {
        current = Fp12.pow(current, 3n);
        t += 1;
        if (t > 8) throw new Error('cubeOrderExponent: элемент вне 3-силовской подгруппы');
    }
    return t;
}

function cubeRoot(value) {
    const { l } = splitPowers(GROUP_ORDER, 3n);
    if ((l + 1n) % 3n !== 0n) throw new Error('cubeRoot: неожиданная структура порядка группы');
    const exponent = (l + 1n) / 3n;
    const inverse = Fp12.inv(value);
    const rootStep = Fp12.pow(ROOT_27, exponent);
    let x = Fp12.pow(value, exponent);
    for (let guard = 0; guard < 32; guard++) {
        if (cubeOrderExponent(Fp12.mul(Fp12.pow(x, 3n), inverse)) === 0) return x;
        x = Fp12.mul(x, rootStep);
    }
    throw new Error('cubeRoot: корень не найден');
}

/**
 * По выходу цикла Миллера f (для которого произведение спариваний равно 1)
 * возвращает { c, w }: f · w = c^λ, w ∈ Fp6.
 */
export function finalExpWitness(f) {
    checkConstants();
    if (!isOne(Fp12.pow(f, h))) {
        throw new Error('Произведение спариваний не равно 1 — свидетеля не существует');
    }

    // 1. Домножаем на степень корня 27-й степени, чтобы получить кубический вычет.
    const cubicTest = GROUP_ORDER / 3n;
    let shift = 0;
    let scaled = f;
    while (!isOne(Fp12.pow(scaled, cubicTest))) {
        shift += 1;
        if (shift > 2) throw new Error('Не удалось получить кубический вычет');
        scaled = Fp12.mul(scaled, ROOT_27);
    }

    // 2. Корень степени r, затем степени m' = λ / (3r), затем кубический.
    const m = LAMBDA / r;
    const d = gcd(m, h);
    if (d !== 3n) throw new Error(`Ожидался gcd(m, h) = 3, получено ${d}`);
    const mDash = m / d;
    let c = Fp12.pow(scaled, modInverse(r, h));
    c = Fp12.pow(c, modInverse(mDash, h));
    c = cubeRoot(c);

    const w = Fp12.pow(ROOT_27, BigInt(shift));
    if (!Fp12.eql(Fp12.mul(f, w), Fp12.pow(c, LAMBDA))) {
        throw new Error('Самопроверка свидетеля не прошла: f · w ≠ c^λ');
    }
    return { c, w };
}
