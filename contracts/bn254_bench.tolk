// Стенд для программного спаривания BN254 в TVM: только get-методы.
// Нужен, чтобы сверить каждую ступень с эталоном (@noble/curves) и снять газ.
// Не часть rollup'а.
import "bn254/fp2"
import "bn254/fp6"
import "bn254/fp12"
import "bn254/pairing"
import "bn254/groth16"
// Копия проверки с отметками газа по стадиям: рабочий hinted.tolk их не содержит.
import "bn254/hinted_profiled"

contract Bn254Bench {
  description: "Stage 0+: software BN254 pairing in TVM, test bench"
  storage: Bn254BenchStorage
}

struct Bn254BenchStorage {}

fun onInternalMessage(inMsg: InMessage) {
  // Контракт существует только ради get-методов.
}

get fun fp12Mul(a: Fp12, b: Fp12): Fp12 {
  return a.mul(b).reduce();
}

get fun fp12Sqr(a: Fp12): Fp12 {
  return a.sqr().reduce();
}

get fun fp12Inv(a: Fp12): Fp12 {
  return a.inv().reduce();
}

get fun fp12Frobenius(a: Fp12, power: int): Fp12 {
  return a.frobenius(power).reduce();
}

get fun fp12CyclotomicSquare(a: Fp12): Fp12 {
  return a.cyclotomicSquare().reduce();
}

/// Цикл Миллера для одной пары, без финального возведения в степень.
get fun millerLoop(px: int, py: int, q: G2Affine): Fp12 {
  var pairs: array<array<Line>> = [];
  pairs.push(computeLines(q, px, py));
  return multiMillerLoop(pairs).reduce();
}

get fun finalExp(f: Fp12): Fp12 {
  return finalExponentiation(f).reduce();
}

/// Полное спаривание одной пары.
get fun pairing(px: int, py: int, q: G2Affine): Fp12 {
  var pairs: array<array<Line>> = [];
  pairs.push(computeLines(q, px, py));
  return finalExponentiation(multiMillerLoop(pairs)).reduce();
}

/// Произведение двух спариваний равно 1? (проверка билинейности)
get fun pairingCheck2(p1x: int, p1y: int, q1: G2Affine, p2x: int, p2y: int, q2: G2Affine): bool {
  var pairs: array<array<Line>> = [];
  pairs.push(computeLines(q1, p1x, p1y));
  pairs.push(computeLines(q2, p2x, p2y));
  return finalExponentiation(multiMillerLoop(pairs)).isOne();
}

/// Только вычисление vk_x = IC0 + pub · IC1 (скалярное умножение в G1).
get fun g1PublicInputCombination(ic0x: int, ic0y: int, ic1x: int, ic1y: int, publicInput: int): (int, int) {
  return g1ToAffine(g1AddAffine(g1ScalarMul(ic1x, ic1y, publicInput), ic0x, ic0y));
}

/// Полная наивная проверка Groth16 на BN254 с одним публичным входом.
get fun groth16Verify(
  ax: int, ay: int, b: G2Affine, cx: int, cy: int,
  alphaX: int, alphaY: int, beta: G2Affine, gamma: G2Affine, delta: G2Affine,
  ic0x: int, ic0y: int, ic1x: int, ic1y: int,
  publicInput: int
): bool {
  return groth16VerifyBn254(ax, ay, b, cx, cy, alphaX, alphaY, beta, gamma, delta, ic0x, ic0y, ic1x, ic1y, publicInput);
}

/// Оптимизированная проверка: константы ключа из ячейки + свидетель (c, c⁻¹, w).
get fun groth16VerifyWitness(
  ax: int, ay: int, b: G2Affine, cx: int, cy: int,
  publicInput: int,
  c: Fp12, cInv: Fp12, w: Fp6,
  vkData: cell
): bool {
  return groth16VerifyBn254Witness(ax, ay, b, cx, cy, publicInput, c, cInv, w, vkData);
}

/// Проверка с подсказками: произведения в Fp12 проверяются в случайной точке.
get fun groth16VerifyHinted(
  ax: int, ay: int, b: G2Affine, cx: int, cy: int,
  input0: int, input1: int,
  vkData: cell, hints: cell
): bool {
  return groth16VerifyBn254Hinted(ax, ay, b, cx, cy, input0, input1, vkData, hints);
}

/// Только линии переменной точки B — чтобы видеть их долю в общей стоимости.
get fun linesOnly(px: int, py: int, q: G2Affine): int {
  return computeLines(q, px, py).size();
}

/// Профиль расхода газа проверки с подсказками: отметки по стадиям.
get fun groth16VerifyHintedProfile(
  ax: int, ay: int, b: G2Affine, cx: int, cy: int,
  input0: int, input1: int,
  vkData: cell, hints: cell
): array<int> {
  groth16VerifyBn254Hinted(ax, ay, b, cx, cy, input0, input1, vkData, hints);
  return hintGasMarks;
}
