// Fp12 = Fp6[w]/(w² − v). Порт формул из @noble/curves.
// Все функции-умножения возвращают координаты в диапазоне |x| < p.
import "constants"
import "fp2"
import "fp6"

struct Fp12 {
  c0: Fp6
  c1: Fp6
}

@inline
fun Fp12.one(): Fp12 {
  return Fp12 { c0: Fp6.one(), c1: Fp6.zero() };
}

/// Сопряжение: в циклотомической подгруппе совпадает с обращением.
@inline
fun Fp12.conj(self): Fp12 {
  return Fp12 { c0: self.c0, c1: self.c1.neg() };
}

@inline
fun Fp12.reduce(self): Fp12 {
  return Fp12 { c0: self.c0.reduce(), c1: self.c1.reduce() };
}

@inline_ref
fun Fp12.isOne(self): bool {
  val r = self.reduce();
  return (r.c0.c0.c0 == 1) && (r.c0.c0.c1 == 0)
    && (r.c0.c1.c0 == 0) && (r.c0.c1.c1 == 0)
    && (r.c0.c2.c0 == 0) && (r.c0.c2.c1 == 0)
    && (r.c1.c0.c0 == 0) && (r.c1.c0.c1 == 0)
    && (r.c1.c1.c0 == 0) && (r.c1.c1.c1 == 0)
    && (r.c1.c2.c0 == 0) && (r.c1.c2.c1 == 0);
}

/// Умножение (Карацуба): 3 умножения в Fp6.
@inline_ref
fun Fp12.mul(self, r: Fp12): Fp12 {
  val t1 = self.c0.mul(r.c0);
  val t2 = self.c1.mul(r.c1);
  val cross = self.c0.add(self.c1).mul(r.c0.add(r.c1));
  return Fp12 {
    // c0 = t1 + v·t2, где v·t2 = (ξ·t2.c2, t2.c0, t2.c1)
    c0: Fp6 {
      c0: t2.c2.mulXiAdd(t1.c0),
      c1: t1.c1.add(t2.c0).reduce(),
      c2: t1.c2.add(t2.c1).reduce(),
    },
    // c1 = (c0 + c1)(r0 + r1) − t1 − t2
    c1: cross.sub(t1).sub(t2).reduce(),
  };
}

/// Возведение в квадрат (комплексный метод): 2 умножения в Fp6.
@inline_ref
fun Fp12.sqr(self): Fp12 {
  val ab = self.c0.mul(self.c1);
  // (v·c1 + c0)(c0 + c1)
  val left = Fp6 {
    c0: self.c1.c2.mulXiAdd(self.c0.c0),
    c1: self.c1.c0.add(self.c0.c1),
    c2: self.c1.c1.add(self.c0.c2),
  };
  val m = left.mul(self.c0.add(self.c1));
  return Fp12 {
    // c0 = m − ab − v·ab
    c0: Fp6 {
      c0: m.c0.sub(ab.c0).sub(ab.c2.mulXi()).reduce(),
      c1: m.c1.sub(ab.c1).sub(ab.c0).reduce(),
      c2: m.c2.sub(ab.c2).sub(ab.c1).reduce(),
    },
    c1: ab.add(ab).reduce(),
  };
}

@inline_ref
fun Fp12.inv(self): Fp12 {
  // t = 1 / (c0² − v·c1²)
  val t = self.c0.mul(self.c0).sub(self.c1.mul(self.c1).mulByV()).inv();
  return Fp12 { c0: self.c0.mul(t), c1: self.c1.mul(t).neg() };
}

/// Фробениус степени 1, 2 или 3.
@inline_ref
fun Fp12.frobenius(self, power: int): Fp12 {
  var coefficient = Fp2 { c0: BN254_FROB12_P1_C0, c1: BN254_FROB12_P1_C1 };
  if (power == 2) {
    coefficient = Fp2 { c0: BN254_FROB12_P2_C0, c1: BN254_FROB12_P2_C1 };
  }
  if (power == 3) {
    coefficient = Fp2 { c0: BN254_FROB12_P3_C0, c1: BN254_FROB12_P3_C1 };
  }
  return Fp12 {
    c0: self.c0.frobenius(power),
    c1: self.c1.frobenius(power).mulByFp2(coefficient),
  };
}

/// Квадрат в Fp4 (вспомогательный для циклотомического квадрата).
/// Возвращает (ξ·b² + a², 2ab), обе координаты приведены.
@inline
fun fp4Square(a: Fp2, b: Fp2): (Fp2, Fp2) {
  val a2 = a.sqr();
  val b2 = b.sqr();
  return (b2.mulXiAdd(a2), a.add(b).sqr().sub(a2).sub(b2).reduce());
}

/// 3·t − 2·x, приведённое.
@inline
fun tripleMinusDouble(t: Fp2, x: Fp2): Fp2 {
  return t.add(t).add(t).sub(x).sub(x).reduce();
}

/// 3·t + 2·x, приведённое.
@inline
fun triplePlusDouble(t: Fp2, x: Fp2): Fp2 {
  return t.add(t).add(t).add(x).add(x).reduce();
}

/// Квадрат элемента циклотомической подгруппы (Грейнджер — Скотт):
/// втрое дешевле обычного. Корректен только после «лёгкой» части
/// финального возведения в степень.
@inline_ref
fun Fp12.cyclotomicSquare(self): Fp12 {
  val (t3, t4) = fp4Square(self.c0.c0, self.c1.c1);
  val (t5, t6) = fp4Square(self.c1.c0, self.c0.c2);
  val (t7, t8) = fp4Square(self.c0.c1, self.c1.c2);
  val t9 = t8.mulXi();
  return Fp12 {
    c0: Fp6 {
      c0: tripleMinusDouble(t3, self.c0.c0),
      c1: tripleMinusDouble(t5, self.c0.c1),
      c2: tripleMinusDouble(t7, self.c0.c2),
    },
    c1: Fp6 {
      c0: triplePlusDouble(t9, self.c1.c0),
      c1: triplePlusDouble(t4, self.c1.c1),
      c2: triplePlusDouble(t6, self.c1.c2),
    },
  };
}
