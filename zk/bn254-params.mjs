// Общие параметры BN254 для скриптов zk/: параметр кривой и NAF-разложение
// длины цикла Миллера. Порядок цифр — как в @noble/curves (abstract/bls.js).
export const BN_X = 4965661367192848881n;

/** NAF-разложение без старшей единицы, старшая цифра первой. */
export function nafDecomposition(value) {
    const digits = [];
    for (let a = value; a > 1n; a >>= 1n) {
        if ((a & 1n) === 0n) digits.unshift(0);
        else if ((a & 3n) === 3n) {
            digits.unshift(-1);
            a += 1n;
        } else digits.unshift(1);
    }
    return digits;
}

/** Цифры для 6x + 2 — длины цикла optimal ate. */
export const ATE_NAF = nafDecomposition(6n * BN_X + 2n);
