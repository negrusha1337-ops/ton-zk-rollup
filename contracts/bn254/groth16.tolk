// Проверка Groth16 на BN254 программным спариванием — наивный (без подсказок
// и предвычислений) вариант, точка отсчёта для оптимизаций.
//
// НЕ ДЛЯ ПРОДАКШЕНА: нет проверок, что точки лежат на кривой и в подгруппе,
// ключ верификации передаётся аргументами, всё считается в одном вызове.
import "constants"
import "fp2"
import "fp6"
import "fp12"
import "pairing"

/// Точка G1 в якобиевых координатах; z == 0 — бесконечность.
struct G1Jac {
  x: int
  y: int
  z: int
}

@inline_ref
fun g1Double(p: G1Jac): G1Jac {
  val a = fpMul(p.x, p.x);
  val b = fpMul(p.y, p.y);
  val c = fpMul(b, b);
  val xb = p.x + b;
  val d = fpMul(2, fpMul(xb, xb) - a - c);
  val e = fpMul(3, a);
  val x3 = (fpMul(e, e) - 2 * d) % BN254_P;
  val y3 = (fpMul(e, d - x3) - fpMul(8, c)) % BN254_P;
  return G1Jac { x: x3, y: y3, z: fpMul(2 * p.y, p.z) };
}

/// Смешанное сложение: якобиева точка + аффинная.
@inline_ref
fun g1AddAffine(p: G1Jac, qx: int, qy: int): G1Jac {
  if (p.z == 0) {
    return G1Jac { x: qx, y: qy, z: 1 };
  }
  val zz = fpMul(p.z, p.z);
  val h = (fpMul(qx, zz) - p.x) % BN254_P;
  val r = (fpMul(qy, fpMul(p.z, zz)) - p.y) % BN254_P;
  if (h == 0) {
    if (r == 0) {
      return g1Double(p);
    }
    return G1Jac { x: 0, y: 1, z: 0 };
  }
  val hh = fpMul(h, h);
  val hhh = fpMul(h, hh);
  val v = fpMul(p.x, hh);
  val x3 = (fpMul(r, r) - hhh - 2 * v) % BN254_P;
  val y3 = (fpMul(r, v - x3) - fpMul(p.y, hhh)) % BN254_P;
  return G1Jac { x: x3, y: y3, z: fpMul(p.z, h) };
}

/// Умножение точки на скаляр: удвоение-сложение по 254 битам.
@inline_ref
fun g1ScalarMul(px: int, py: int, scalar: int): G1Jac {
  var acc = G1Jac { x: 0, y: 1, z: 0 };
  var i = 253;
  while (i >= 0) {
    acc = g1Double(acc);
    if (((scalar >> i) & 1) != 0) {
      acc = g1AddAffine(acc, px, py);
    }
    i -= 1;
  }
  return acc;
}

@inline_ref
fun g1ToAffine(p: G1Jac): (int, int) {
  assert (p.z != 0) throw 7002;
  val zInv = fpInv(p.z);
  val zInv2 = fpMul(zInv, zInv);
  return (fpMul(p.x, zInv2), fpMul(p.y, fpMul(zInv, zInv2)));
}

/// e(−A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) == 1, где vk_x = IC0 + pub · IC1.
/// Один публичный вход — как у схемы Multiplier.
@inline_ref
fun groth16VerifyBn254(
  ax: int, ay: int, b: G2Affine, cx: int, cy: int,
  alphaX: int, alphaY: int, beta: G2Affine, gamma: G2Affine, delta: G2Affine,
  ic0x: int, ic0y: int, ic1x: int, ic1y: int,
  publicInput: int
): bool {
  assert (publicInput >= 0 && publicInput < BN254_R) throw 7003;
  val (vkX, vkY) = g1ToAffine(g1AddAffine(g1ScalarMul(ic1x, ic1y, publicInput), ic0x, ic0y));

  var pairs: array<array<Line>> = [];
  pairs.push(computeLines(b, ax, BN254_P - ay));
  pairs.push(computeLines(beta, alphaX, alphaY));
  pairs.push(computeLines(gamma, vkX, vkY));
  pairs.push(computeLines(delta, cx, cy));
  return finalExponentiation(multiMillerLoop(pairs)).isOne();
}

// ---------------------------------------------------------------------------
// Оптимизированная проверка: константы ключа + свидетель вместо финальной степени
// ---------------------------------------------------------------------------

/// Читает очередной элемент поля (254 бита) из цепочки ячеек: по 4 значения
/// на ячейку, продолжение — по единственной ссылке.
@inline
fun readFp(mutate s: slice): int {
  if (s.remainingBitsCount() == 0) {
    s = s.loadRef().beginParse();
  }
  return s.loadUint(254);
}

@inline
fun readFp2(mutate s: slice): Fp2 {
  val c0 = readFp(mutate s);
  val c1 = readFp(mutate s);
  return Fp2 { c0: c0, c1: c1 };
}

/// Читает коэффициенты линии фиксированной точки G2 и вычисляет её в точке (px, py).
@inline_ref
fun readLineAt(mutate s: slice, px: int, py: int): Line {
  val c0 = readFp2(mutate s);
  val c1 = readFp2(mutate s);
  val c2 = readFp2(mutate s);
  return Line { o0: c2.mulFp(py), o3: c1.mulFp(px), o4: c0 };
}

@inline_ref
fun readFp12(mutate s: slice): Fp12 {
  val a0 = readFp2(mutate s);
  val a1 = readFp2(mutate s);
  val a2 = readFp2(mutate s);
  val b0 = readFp2(mutate s);
  val b1 = readFp2(mutate s);
  val b2 = readFp2(mutate s);
  return Fp12 { c0: Fp6 { c0: a0, c1: a1, c2: a2 }, c1: Fp6 { c0: b0, c1: b1, c2: b2 } };
}

/// Один шаг цикла: линия переменной точки B и линии фиксированных γ, δ.
@inline_ref
fun applyStep(
  f: Fp12, bLines: array<Line>, index: int, mutate fixedLines: slice,
  vkX: int, vkY: int, cx: int, cy: int
): Fp12 {
  var acc = f.mulByLine(bLines.get(index));
  acc = acc.mulByLine(readLineAt(mutate fixedLines, vkX, vkY));
  return acc.mulByLine(readLineAt(mutate fixedLines, cx, cy));
}

/// Проверка Groth16 без финального возведения в степень.
///
/// Прувер дополнительно присылает свидетель (c, c⁻¹, w): f · w = c^λ,
/// λ = 6x + 2 + q − q² + q³. Контракт проверяет равенство
///   f · w · (c⁻¹)^(6x+2) · (c⁻¹)^q · c^(q²) · (c⁻¹)^(q³) = 1,
/// причём степень 6x+2 набирается теми же возведениями в квадрат, что и f.
/// w принимается только из подполя Fp6 — этого достаточно для корректности
/// (eprint 2024/640, теорема 3): любой элемент Fp6 обнуляется финальной степенью.
///
/// vkData: корневая ячейка = IC0, IC1; первая ссылка — результат цикла Миллера
/// для (α, β); вторая — коэффициенты линий γ и δ (см. zk/gen-bn254-groth16-fixture.mjs).
@inline_ref
fun groth16VerifyBn254Witness(
  ax: int, ay: int, b: G2Affine, cx: int, cy: int,
  publicInput: int,
  c: Fp12, cInv: Fp12, w: Fp6,
  vkData: cell
): bool {
  assert (publicInput >= 0 && publicInput < BN254_R) throw 7003;
  var root = vkData.beginParse();
  val ic0x = root.loadUint(254);
  val ic0y = root.loadUint(254);
  val ic1x = root.loadUint(254);
  val ic1y = root.loadUint(254);
  var alphaBetaSlice = root.loadRef().beginParse();
  var fixedLines = root.loadRef().beginParse();

  val (vkX, vkY) = g1ToAffine(g1AddAffine(g1ScalarMul(ic1x, ic1y, publicInput), ic0x, ic0y));
  val bLines = computeLines(b, ax, BN254_P - ay);

  var f = cInv;
  var index = 0;
  var i = BN254_NAF_LEN - 1;
  while (i >= 0) {
    f = f.sqr();
    f = applyStep(f, bLines, index, mutate fixedLines, vkX, vkY, cx, cy);
    index += 1;
    if (((BN254_NAF_NONZERO >> i) & 1) != 0) {
      f = applyStep(f, bLines, index, mutate fixedLines, vkX, vkY, cx, cy);
      index += 1;
      if (((BN254_NAF_NEGATIVE >> i) & 1) != 0) {
        f = f.mul(c);
      } else {
        f = f.mul(cInv);
      }
    }
    i -= 1;
  }
  f = applyStep(f, bLines, index, mutate fixedLines, vkX, vkY, cx, cy);
  f = applyStep(f, bLines, index + 1, mutate fixedLines, vkX, vkY, cx, cy);

  f = f.mul(readFp12(mutate alphaBetaSlice));
  f = f.mul(cInv.frobenius(1)).mul(c.frobenius(2)).mul(cInv.frobenius(3));
  f = Fp12 { c0: f.c0.mul(w), c1: f.c1.mul(w) };

  return c.mul(cInv).isOne() && f.isOne();
}
