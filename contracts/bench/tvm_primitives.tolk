// Микробенчмарк примитивов TVM для оценки пути «проверять STARK прямо в TVM,
// без SNARK-обёртки». Не часть rollup'а: только get-методы, состояния нет.
// Каждый метод крутит цикл из n операций; чистая цена операции =
// (газ метода − газ benchEmptyLoop) / n. Считает тест tests/TvmPrimitives.spec.ts.

contract TvmPrimitivesBench {
  description: "Stage 0+: gas cost of hash and small-field primitives"
  storage: TvmPrimitivesBenchStorage
}

struct TvmPrimitivesBenchStorage {}

/// Модуль поля BabyBear: 15 * 2^27 + 1 (используют SP1 и RISC Zero).
const BABYBEAR_P: int = 2013265921

/// Модуль базового поля BN254 (254 бита) — помещается в 257-битное целое TVM.
const BN254_P: int = 21888242871839275222246405745257275088696311157297823662689037894645226208583

/// (x * y) mod z одной инструкцией: промежуточное произведение 513 бит.
@pure fun mulMod(x: int, y: int, z: int): int asm "MULMOD"

@pure fun sha256OfBuilders1(b: builder, count: int): uint256 asm "HASHEXT_SHA256"
@pure fun keccak256OfBuilders1(b: builder, count: int): uint256 asm "HASHEXT_KECCAK256"

fun onInternalMessage(inMsg: InMessage) {
  // Контракт существует только ради get-методов.
}

/// Базовая линия: пустой цикл с тем же счётчиком и одной лёгкой операцией.
get fun benchEmptyLoop(n: int, seed: int): int {
  var acc = seed;
  repeat (n) {
    acc = acc + 1;
  }
  return acc;
}

/// Шаг Merkle-пути: h = sha256(h ‖ sibling), 64 байта на входе.
get fun benchSha256Merkle(n: int, seed: int): int {
  var acc = seed;
  repeat (n) {
    acc = sha256OfBuilders1(beginCell().storeUint(acc, 256).storeUint(seed, 256), 1);
  }
  return acc;
}

/// То же на Keccak-256.
get fun benchKeccak256Merkle(n: int, seed: int): int {
  var acc = seed;
  repeat (n) {
    acc = keccak256OfBuilders1(beginCell().storeUint(acc, 256).storeUint(seed, 256), 1);
  }
  return acc;
}

/// Умножение со сложением в поле BabyBear: acc = (acc * acc + seed) mod p.
get fun benchBabyBearMulAdd(n: int, seed: int): int {
  var acc = seed;
  repeat (n) {
    acc = (acc * acc + seed) % BABYBEAR_P;
  }
  return acc;
}

/// Умножение в расширении степени 4 над BabyBear (x^4 − 11), «в лоб»:
/// 16 произведений, редукция один раз на координату — 257-битные целые TVM
/// вмещают суммы без промежуточных редукций.
get fun benchBabyBearExt4Mul(n: int, seed: int): int {
  var (a0, a1, a2, a3) = (seed, seed + 1, seed + 2, seed + 3);
  val (b0, b1, b2, b3) = (seed + 4, seed + 5, seed + 6, seed + 7);
  repeat (n) {
    val c0 = (a0 * b0 + 11 * (a1 * b3 + a2 * b2 + a3 * b1)) % BABYBEAR_P;
    val c1 = (a0 * b1 + a1 * b0 + 11 * (a2 * b3 + a3 * b2)) % BABYBEAR_P;
    val c2 = (a0 * b2 + a1 * b1 + a2 * b0 + 11 * (a3 * b3)) % BABYBEAR_P;
    val c3 = (a0 * b3 + a1 * b2 + a2 * b1 + a3 * b0) % BABYBEAR_P;
    a0 = c0;
    a1 = c1;
    a2 = c2;
    a3 = c3;
  }
  return a0 + a1 + a2 + a3;
}

/// Умножение в базовом поле BN254 одной инструкцией MULMOD.
/// Модуль лежит в локальной переменной (на стеке), а не константой в коде.
get fun benchBn254FpMul(n: int, seed: int): int {
  val p = BN254_P;
  var acc = seed;
  repeat (n) {
    acc = mulMod(acc, acc, p);
  }
  return acc;
}

/// То же, но модуль — константа в коде (PUSHINT на каждой итерации).
get fun benchBn254FpMulConstModulus(n: int, seed: int): int {
  var acc = seed;
  repeat (n) {
    acc = mulMod(acc, acc, BN254_P);
  }
  return acc;
}

/// Сложение в поле BN254 с редукцией.
get fun benchBn254FpAdd(n: int, seed: int): int {
  val p = BN254_P;
  var acc = seed;
  repeat (n) {
    acc = (acc + acc) % p;
  }
  return acc;
}

@noinline
fun addOneViaDictionary(x: int): int {
  return x + 1;
}

@inline_ref
fun addOneViaRef(x: int): int {
  return x + 1;
}

/// Цена вызова обычной (не встроенной) функции: CALLDICT ищет её в словаре кода.
get fun benchCallDictionary(n: int, seed: int): int {
  var acc = seed;
  repeat (n) {
    acc = addOneViaDictionary(acc);
  }
  return acc;
}

/// Цена вызова функции, вынесенной в отдельную ячейку (CALLREF).
get fun benchCallRef(n: int, seed: int): int {
  var acc = seed;
  repeat (n) {
    acc = addOneViaRef(acc);
  }
  return acc;
}

global benchModulus: int

/// Цена загрузки 254-битной константы из кода: acc + P против acc + 1 в пустом цикле.
get fun benchPushBigConstant(n: int, seed: int): int {
  var acc = seed;
  repeat (n) {
    acc = (acc + BN254_P) & 0xffffffff;
  }
  return acc;
}

/// То же, но константа лежит в глобальной переменной (GETGLOB).
get fun benchReadGlobal(n: int, seed: int): int {
  benchModulus = BN254_P;
  var acc = seed;
  repeat (n) {
    acc = (acc + benchModulus) & 0xffffffff;
  }
  return acc;
}

/// База для двух предыдущих: та же маска, но со сложением малой константы.
get fun benchMaskOnly(n: int, seed: int): int {
  var acc = seed;
  repeat (n) {
    acc = (acc + 7) & 0xffffffff;
  }
  return acc;
}
