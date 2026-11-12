// Арифметика базового поля BN254 и его квадратичного расширения Fp2 = Fp[u]/(u² + 1).
// Порт формул из @noble/curves (abstract/tower.js), адаптированный под TVM.
//
// ИНВАРИАНТ ГРАНИЦ (важен: переполнение 257-битного целого в TVM — это исключение):
//   • функции-умножения возвращают координаты в диапазоне |x| < p;
//   • add / sub / neg НЕ редуцируют результат;
//   • на вход любой функции можно подавать суммы не более чем четырёх таких
//     значений (|x| < 4p < 2^256): MULMOD принимает любые целые, в том числе
//     отрицательные, и возвращает остаток в [0, p).
// MULADDDIVMOD здесь не годится: он вычисляет ещё и частное, а частное от
// произведения двух «сумм четырёх» не помещается в 257 бит (исключение 4).
// Поэтому сумма двух произведений считается как разность:
//   a·b + c·d ≡ (a·b mod p) − ((−c)·d mod p), результат в (−p, p).
import "constants"

/// (x * y) mod z, промежуточное произведение 513 бит.
@pure fun mulMod(x: int, y: int, z: int): int asm "MULMOD"

@inline
fun fpMul(a: int, b: int): int {
  return mulMod(a, b, BN254_P);
}

/// Обратный элемент: a^(p-2). Около 380 умножений; вызывается один раз на проверку.
@inline_ref
fun fpInv(a: int): int {
  var result = 1;
  var base = a % BN254_P;
  var exponent = BN254_P - 2;
  while (exponent > 0) {
    if ((exponent & 1) != 0) {
      result = fpMul(result, base);
    }
    base = fpMul(base, base);
    exponent = exponent >> 1;
  }
  return result;
}

struct Fp2 {
  c0: int
  c1: int
}

@inline
fun Fp2.zero(): Fp2 {
  return Fp2 { c0: 0, c1: 0 };
}

@inline
fun Fp2.one(): Fp2 {
  return Fp2 { c0: 1, c1: 0 };
}

@inline
fun Fp2.add(self, b: Fp2): Fp2 {
  return Fp2 { c0: self.c0 + b.c0, c1: self.c1 + b.c1 };
}

@inline
fun Fp2.sub(self, b: Fp2): Fp2 {
  return Fp2 { c0: self.c0 - b.c0, c1: self.c1 - b.c1 };
}

@inline
fun Fp2.neg(self): Fp2 {
  return Fp2 { c0: -self.c0, c1: -self.c1 };
}

/// Сопряжение (оно же Фробениус нечётной степени).
@inline
fun Fp2.conj(self): Fp2 {
  return Fp2 { c0: self.c0, c1: -self.c1 };
}

/// Приведение координат в [0, p).
@inline
fun Fp2.reduce(self): Fp2 {
  return Fp2 { c0: self.c0 % BN254_P, c1: self.c1 % BN254_P };
}

/// Умножение «в лоб»: 4 модульных умножения, результат в (−p, p).
/// В TVM это выгоднее Карацубы: MULMOD стоит как сложение, а входы не растут.
@inline
fun Fp2.mul(self, b: Fp2): Fp2 {
  return Fp2 {
    c0: fpMul(self.c0, b.c0) - fpMul(self.c1, b.c1),
    c1: fpMul(self.c0, b.c1) - fpMul(-self.c1, b.c0),
  };
}

@inline
fun Fp2.sqr(self): Fp2 {
  return Fp2 {
    c0: fpMul(self.c0, self.c0) - fpMul(self.c1, self.c1),
    c1: fpMul(self.c0, self.c1) - fpMul(-self.c0, self.c1),
  };
}

/// Квадрат комплексным методом: 2 умножения вместо 4, результат в [0, p).
/// Только для входов с |x| < 2p: суммы c0 + c1 и c0 + c0 не должны переполниться.
@inline
fun Fp2.sqrFast(self): Fp2 {
  return Fp2 {
    c0: fpMul(self.c0 + self.c1, self.c0 - self.c1),
    c1: fpMul(self.c0 + self.c0, self.c1),
  };
}

/// Умножение на элемент базового поля.
@inline
fun Fp2.mulFp(self, k: int): Fp2 {
  return Fp2 { c0: fpMul(self.c0, k), c1: fpMul(self.c1, k) };
}

/// Умножение на невычет ξ = 9 + u: (9·c0 − c1, 9·c1 + c0).
@inline
fun Fp2.mulXi(self): Fp2 {
  return Fp2 {
    c0: fpMul(self.c0, 9) - self.c1 % BN254_P,
    c1: fpMul(self.c1, 9) - (-self.c0) % BN254_P,
  };
}

/// ξ · self + w, результат в (−p, p). Экономит отдельные сложение и редукцию.
@inline
fun Fp2.mulXiAdd(self, w: Fp2): Fp2 {
  return Fp2 {
    c0: fpMul(self.c0, 9) - (self.c1 - w.c0) % BN254_P,
    c1: fpMul(self.c1, 9) - (-(w.c1 + self.c0)) % BN254_P,
  };
}

@inline_ref
fun Fp2.inv(self): Fp2 {
  val norm = fpMul(self.c0, self.c0) + fpMul(self.c1, self.c1);
  val t = fpInv(norm);
  return Fp2 { c0: fpMul(self.c0, t), c1: fpMul(-self.c1, t) };
}
