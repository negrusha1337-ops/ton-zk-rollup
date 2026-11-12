// Спаривание optimal ate на BN254 (alt_bn128), целиком программно в TVM.
// Порт алгоритма из @noble/curves (abstract/bls.js, bn254.js):
//   1. для каждой пары (P ∈ G1, Q ∈ G2) считаются коэффициенты линий;
//   2. общий цикл Миллера по NAF-разложению 6x+2 с общим возведением в квадрат;
//   3. финальное возведение в степень (p¹² − 1) / r.
// Проверка Groth16 сводится к тому, что произведение спариваний равно 1.
import "constants"
import "fp2"
import "fp6"
import "fp12"

struct G2Affine {
  x: Fp2
  y: Fp2
}

/// Точка G2 в проективных координатах (состояние цикла Миллера).
struct G2Proj {
  x: Fp2
  y: Fp2
  z: Fp2
}

/// Линия, уже вычисленная в точке P: разреженный элемент Fp12 с тремя
/// ненулевыми коэффициентами (позиции 0, 3, 4).
struct Line {
  o0: Fp2
  o3: Fp2
  o4: Fp2
}

/// Умножение на разреженный элемент (mul034 в noble).
@inline_ref
fun Fp12.mulByLine(self, l: Line): Fp12 {
  val a = self.c0;
  val b = self.c1;
  val aC0 = a.c0.mul(l.o0);
  val aC1 = a.c1.mul(l.o0);
  val aC2 = a.c2.mul(l.o0);
  val b0m = b.c0.mul(l.o3);
  val b1m = b.c1.mul(l.o4);
  val bC0 = b.c1.add(b.c2).mul(l.o4).sub(b1m).mulXiAdd(b0m);
  val bC1 = l.o3.add(l.o4).mul(b.c0.add(b.c1)).sub(b0m).sub(b1m);
  val bC2 = b.c0.add(b.c2).mul(l.o3).sub(b0m).add(b1m);
  val s0 = a.c0.add(b.c0);
  val s1 = a.c1.add(b.c1);
  val s2 = a.c2.add(b.c2);
  val o03 = l.o0.add(l.o3);
  val e0m = s0.mul(o03);
  val e1m = s1.mul(l.o4);
  val eC0 = s1.add(s2).mul(l.o4).sub(e1m).mulXiAdd(e0m);
  val eC1 = o03.add(l.o4).mul(s0.add(s1)).sub(e0m).sub(e1m);
  val eC2 = s0.add(s2).mul(o03).sub(e0m).add(e1m);
  return Fp12 {
    c0: Fp6 {
      c0: bC2.mulXiAdd(aC0),
      c1: bC0.add(aC1).reduce(),
      c2: bC1.add(aC2).reduce(),
    },
    c1: Fp6 {
      c0: eC0.sub(aC0).sub(bC0).reduce(),
      c1: eC1.sub(aC1).sub(bC1).reduce(),
      c2: eC2.sub(aC2).sub(bC2).reduce(),
    },
  };
}

/// Удвоение R и линия касательной в точке P = (px, py).
@inline_ref
fun doubleStep(mutate r: G2Proj, px: int, py: int): Line {
  val t0 = r.y.sqr();
  val t1 = r.z.sqr();
  val t2 = t1.add(t1).add(t1).mul(Fp2 { c0: BN254_TWIST_B_C0, c1: BN254_TWIST_B_C1 });
  val t3 = t2.add(t2).add(t2);
  val t4 = r.y.add(r.z).sqr().sub(t1).sub(t0);
  val c0 = t2.sub(t0);
  val rxSquared = r.x.sqr();
  val c1 = rxSquared.add(rxSquared).add(rxSquared);
  val t2Squared = t2.sqr();

  val newX = t0.sub(t3).mul(r.x).mul(r.y).mulFp(BN254_INV2);
  val newY = t0.add(t3).mulFp(BN254_INV2).sqr().sub(t2Squared.add(t2Squared).add(t2Squared)).reduce();
  val newZ = t0.mul(t4);
  r = G2Proj { x: newX, y: newY, z: newZ };

  return Line { o0: t4.neg().mulFp(py), o3: c1.mulFp(px), o4: c0 };
}

/// Сложение R += Q и линия через R и Q в точке P = (px, py).
@inline_ref
fun addStep(mutate r: G2Proj, q: G2Affine, px: int, py: int): Line {
  val t0 = r.y.sub(q.y.mul(r.z));
  val t1 = r.x.sub(q.x.mul(r.z));
  val c0 = t0.mul(q.x).sub(t1.mul(q.y));
  val t2 = t1.sqr();
  val t3 = t2.mul(t1);
  val t4 = t2.mul(r.x);
  val t5 = t3.sub(t4).sub(t4).add(t0.sqr().mul(r.z));

  val newX = t1.mul(t5);
  val newY = t4.sub(t5).mul(t0).sub(t3.mul(r.y));
  val newZ = r.z.mul(t3);
  r = G2Proj { x: newX, y: newY, z: newZ };

  return Line { o0: t1.mulFp(py), o3: t0.neg().mulFp(px), o4: c0 };
}

/// Эндоморфизм psi: Фробениус, перенесённый на скрученную кривую.
@inline
fun G2Affine.psi(self): G2Affine {
  return G2Affine {
    x: self.x.conj().mul(Fp2 { c0: BN254_PSI_X_C0, c1: BN254_PSI_X_C1 }),
    y: self.y.conj().mul(Fp2 { c0: BN254_PSI_Y_C0, c1: BN254_PSI_Y_C1 }),
  };
}

/// Все линии цикла Миллера для пары (P, Q): 65 удвоений, 21 сложение
/// и 2 завершающих шага с psi(Q) — всего 88.
@inline_ref
fun computeLines(q: G2Affine, px: int, py: int): array<Line> {
  var lines: array<Line> = [];
  var r = G2Proj { x: q.x, y: q.y, z: Fp2.one() };
  val negQ = G2Affine { x: q.x, y: q.y.neg() };

  var i = BN254_NAF_LEN - 1;
  while (i >= 0) {
    lines.push(doubleStep(mutate r, px, py));
    if (((BN254_NAF_NONZERO >> i) & 1) != 0) {
      if (((BN254_NAF_NEGATIVE >> i) & 1) != 0) {
        lines.push(addStep(mutate r, negQ, px, py));
      } else {
        lines.push(addStep(mutate r, q, px, py));
      }
    }
    i -= 1;
  }

  val q1 = q.psi();
  lines.push(addStep(mutate r, q1, px, py));
  val q2 = q1.psi();
  lines.push(addStep(mutate r, G2Affine { x: q2.x, y: q2.y.neg() }, px, py));
  return lines;
}

/// Умножает f на линию с номером index каждой пары.
@inline_ref
fun applyLines(f: Fp12, pairs: array<array<Line>>, index: int): Fp12 {
  var acc = f;
  var k = 0;
  val count = pairs.size();
  while (k < count) {
    acc = acc.mulByLine(pairs.get(k).get(index));
    k += 1;
  }
  return acc;
}

/// Общий цикл Миллера: возведение в квадрат одно на все пары.
@inline_ref
fun multiMillerLoop(pairs: array<array<Line>>): Fp12 {
  var f = Fp12.one();
  var index = 0;
  var i = BN254_NAF_LEN - 1;
  while (i >= 0) {
    if (i != BN254_NAF_LEN - 1) {
      f = f.sqr();
    }
    f = applyLines(f, pairs, index);
    index += 1;
    if (((BN254_NAF_NONZERO >> i) & 1) != 0) {
      f = applyLines(f, pairs, index);
      index += 1;
    }
    i -= 1;
  }
  f = applyLines(f, pairs, index);
  f = applyLines(f, pairs, index + 1);
  return f;
}

@inline_ref
fun cyclotomicSquareTimes(f: Fp12, count: int): Fp12 {
  var acc = f;
  repeat (count) {
    acc = acc.cyclotomicSquare();
  }
  return acc;
}

/// f^x для параметра кривой x = 4965661367192848881 (аддитивная цепочка из noble).
@inline_ref
fun cyclotomicExpByX(num: Fp12): Fp12 {
  val x10 = num.cyclotomicSquare();
  val x100 = x10.cyclotomicSquare();
  val x1000 = x100.cyclotomicSquare();
  val x10000 = x1000.cyclotomicSquare();
  val x10001 = x10000.mul(num);
  val x10011 = x10001.mul(x10);
  val x10100 = x10011.mul(num);
  val x11001 = x1000.mul(x10001);
  val x100010 = x10001.cyclotomicSquare();
  val x100111 = x10011.mul(x10100);
  val x101001 = x10.mul(x100111);
  var r = cyclotomicSquareTimes(x100010, 6);
  r = r.mul(x100).mul(x11001);
  r = cyclotomicSquareTimes(r, 7).mul(x11001);
  r = cyclotomicSquareTimes(r, 8);
  r = r.mul(x101001).mul(x10);
  r = cyclotomicSquareTimes(r, 6).mul(x10001);
  r = cyclotomicSquareTimes(r, 8).mul(x101001);
  r = cyclotomicSquareTimes(r, 6).mul(x101001);
  r = cyclotomicSquareTimes(r, 10).mul(x100111);
  r = cyclotomicSquareTimes(r, 6).mul(x101001).mul(x1000);
  return r;
}

@inline_ref
fun powMinusX(f: Fp12): Fp12 {
  return cyclotomicExpByX(f).conj();
}

/// Финальное возведение в степень (p¹² − 1) / r — как в noble для bn254.
@inline_ref
fun finalExponentiation(num: Fp12): Fp12 {
  val r0 = num.conj().mul(num.inv());
  val r = r0.frobenius(2).mul(r0);
  val y1 = powMinusX(r).cyclotomicSquare();
  val y2 = y1.cyclotomicSquare().mul(y1);
  val y4 = powMinusX(y2);
  val y6 = powMinusX(y4.cyclotomicSquare());
  val y8 = y6.conj().mul(y4).mul(y2.conj());
  val y9 = y8.mul(y1);
  val left = r.conj().mul(y9).frobenius(3);
  val right = y8.frobenius(2).mul(y9.frobenius(1).mul(y8.mul(y4).mul(r)));
  return left.mul(right);
}
