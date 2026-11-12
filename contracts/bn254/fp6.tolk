// Fp6 = Fp2[v]/(v³ − ξ), ξ = 9 + u. Порт формул из @noble/curves.
// Инвариант границ — см. fp2.tolk.
import "constants"
import "fp2"

struct Fp6 {
  c0: Fp2
  c1: Fp2
  c2: Fp2
}

@inline
fun Fp6.zero(): Fp6 {
  return Fp6 { c0: Fp2.zero(), c1: Fp2.zero(), c2: Fp2.zero() };
}

@inline
fun Fp6.one(): Fp6 {
  return Fp6 { c0: Fp2.one(), c1: Fp2.zero(), c2: Fp2.zero() };
}

@inline
fun Fp6.add(self, b: Fp6): Fp6 {
  return Fp6 { c0: self.c0.add(b.c0), c1: self.c1.add(b.c1), c2: self.c2.add(b.c2) };
}

@inline
fun Fp6.sub(self, b: Fp6): Fp6 {
  return Fp6 { c0: self.c0.sub(b.c0), c1: self.c1.sub(b.c1), c2: self.c2.sub(b.c2) };
}

@inline
fun Fp6.neg(self): Fp6 {
  return Fp6 { c0: self.c0.neg(), c1: self.c1.neg(), c2: self.c2.neg() };
}

@inline
fun Fp6.reduce(self): Fp6 {
  return Fp6 { c0: self.c0.reduce(), c1: self.c1.reduce(), c2: self.c2.reduce() };
}

/// Умножение (Карацуба по трём коэффициентам): 6 умножений в Fp2.
/// Координаты входов — суммы не более двух приведённых значений.
@inline_ref
fun Fp6.mul(self, r: Fp6): Fp6 {
  val t0 = self.c0.mul(r.c0);
  val t1 = self.c1.mul(r.c1);
  val t2 = self.c2.mul(r.c2);
  // c0 = t0 + ξ·((c1 + c2)(r1 + r2) − t1 − t2)
  val x = self.c1.add(self.c2).mul(r.c1.add(r.c2)).sub(t1).sub(t2);
  // c1 = (c0 + c1)(r0 + r1) − t0 − t1 + ξ·t2
  val y = self.c0.add(self.c1).mul(r.c0.add(r.c1)).sub(t0).sub(t1);
  // c2 = (c0 + c2)(r0 + r2) − t0 − t2 + t1
  val z = self.c0.add(self.c2).mul(r.c0.add(r.c2)).sub(t0).sub(t2).add(t1);
  return Fp6 { c0: x.mulXiAdd(t0), c1: t2.mulXiAdd(y), c2: z.reduce() };
}

/// Умножение на v: (c0, c1, c2) → (ξ·c2, c0, c1).
@inline
fun Fp6.mulByV(self): Fp6 {
  return Fp6 { c0: self.c2.mulXi(), c1: self.c0, c2: self.c1 };
}

@inline
fun Fp6.mulByFp2(self, k: Fp2): Fp6 {
  return Fp6 { c0: self.c0.mul(k), c1: self.c1.mul(k), c2: self.c2.mul(k) };
}

@inline_ref
fun Fp6.inv(self): Fp6 {
  // t0 = c0² − ξ·c2·c1;  t1 = ξ·c2² − c0·c1;  t2 = c1² − c0·c2
  val t0 = self.c0.sqr().sub(self.c2.mul(self.c1).mulXi());
  val t1 = self.c2.sqr().mulXi().sub(self.c0.mul(self.c1));
  val t2 = self.c1.sqr().sub(self.c0.mul(self.c2));
  // t4 = 1 / (ξ·(c2·t1 + c1·t2) + c0·t0)
  val denominator = self.c2.mul(t1).add(self.c1.mul(t2)).mulXiAdd(self.c0.mul(t0));
  val t4 = denominator.inv();
  return Fp6 { c0: t4.mul(t0), c1: t4.mul(t1), c2: t4.mul(t2) };
}

/// Фробениус степени 1, 2 или 3: коэффициенты — из constants.tolk.
@inline_ref
fun Fp6.frobenius(self, power: int): Fp6 {
  if (power == 1) {
    return Fp6 {
      c0: self.c0.conj(),
      c1: self.c1.conj().mul(Fp2 { c0: BN254_FROB6_1_P1_C0, c1: BN254_FROB6_1_P1_C1 }),
      c2: self.c2.conj().mul(Fp2 { c0: BN254_FROB6_2_P1_C0, c1: BN254_FROB6_2_P1_C1 }),
    };
  }
  if (power == 2) {
    return Fp6 {
      c0: self.c0,
      c1: self.c1.mul(Fp2 { c0: BN254_FROB6_1_P2_C0, c1: BN254_FROB6_1_P2_C1 }),
      c2: self.c2.mul(Fp2 { c0: BN254_FROB6_2_P2_C0, c1: BN254_FROB6_2_P2_C1 }),
    };
  }
  assert (power == 3) throw 7001;
  return Fp6 {
    c0: self.c0.conj(),
    c1: self.c1.conj().mul(Fp2 { c0: BN254_FROB6_1_P3_C0, c1: BN254_FROB6_1_P3_C1 }),
    c2: self.c2.conj().mul(Fp2 { c0: BN254_FROB6_2_P3_C0, c1: BN254_FROB6_2_P3_C1 }),
  };
}
