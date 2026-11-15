// >>> профиль
// КОПИЯ contracts/bn254/hinted.tolk С ОТМЕТКАМИ ПРОФИЛИРОВАНИЯ — только для стенда
// (contracts/bn254_bench.tolk, get-метод groth16VerifyHintedProfile). Рабочие контракты
// импортируют hinted.tolk, где отметок нет: они стоили газа в самой тесной транзакции.
// Файлы обязаны совпадать построчно, кроме строк между метками «профиль» и строк
// `markGas();` / `hintGasMarks = [];` — за этим следит tests/HintedProfileParity.spec.ts.
// Правка проверки вносится в оба файла.
// <<< профиль
// Проверка Groth16 на BN254 с подсказками: произведения в Fp12 не вычисляются,
// а проверяются как тождества многочленов в случайной точке (приём Garaga).
//
// Fp12 = Fp[x] / P(x), P(x) = x¹² − 18x⁶ + 82; соответствие с башней:
// w ↦ x, v ↦ x², u ↦ x⁶ − 9. Для каждого шага цикла Миллера прувер присылает
// следующее значение аккумулятора R, а для всех шагов разом — частное bigQ.
// Контракт проверяет в точке z:
//     Σ ρ^i · (Π факторов_i(z) − R_i(z)) = bigQ(z) · P(z).
//
// Линии — аффинные, нормированные делением на y_P:
//     1 − λ·(x_P / y_P)·w + μ·(1 / y_P)·w³,   μ = λ·x_T − y_T.
// От линий эталонной реализации они отличаются множителями из Fp2, которые
// исчезают при финальном возведении в степень, поэтому свидетель существует.
//   • для фиксированных точек ключа (γ, δ) пары (λ, μ) лежат в ячейках ключа;
//   • для точки B прувер присылает наклоны λ, контракт проверяет каждый
//     уравнением касательной или секущей и сам ведёт точку T.
//
// Корректность ВЕРОЯТНОСТНАЯ (лемма Шварца — Зиппеля + Fiat–Shamir). Она
// держится на порядке привязки: ρ зависит от пруфа, ключа, свидетеля, наклонов
// и всех R; z зависит ещё и от bigQ. Менять порядок хеширования нельзя.
//
// Проверки точек пруфа:
//   • A и C — на кривой y² = x³ + 3 (у G1 кофактор 1, этого достаточно);
//   • B — на скрученной кривой и в подгруппе G2. Подгруппа проверяется почти
//     бесплатно: цикл Миллера и так считает T = [6x+2]B + ψ(B) − ψ²(B), а для
//     точек G2 и только для них T = −ψ³(B). «Только для них» следует из того,
//     что норма эндоморфизма 6x+2 + ψ − ψ² + ψ³ имеет с порядком E'(Fp2) общий
//     делитель ровно r (проверено численно, см. ROUTES.md).
//
// НЕ ДЛЯ ПРОДАКШЕНА: код не проходил аудит, всё считается одним вызовом.
import "constants"
import "fp2"
import "fp6"
import "fp12"
import "pairing"
import "groth16"
import "@stdlib/gas-payments"

/// Аккумулятор присылается раз в столько шагов цикла (и после последнего шага).
/// Между контрольными точками значение в точке z просто перемножается дальше:
/// растёт только степень тождества, а значит длина bigQ.
/// Должно совпадать с CHECKPOINT_EVERY в zk/bn254-hints.mjs.
const HINT_CHECKPOINT_EVERY: int = 2

/// Ширина окна таблицы публичного входа, бит. Должна совпадать с WINDOW_BITS
/// в zk/bn254-hints.mjs (от неё зависит раскладка дерева таблицы).
const HINT_WINDOW_BITS: int = 6

/// Длина частного bigQ в ячейках (по 4 коэффициента). Она определяется только
/// структурой цикла, поэтому фиксирована: прувер не может удлинить частное и тем
/// самым поднять степень проверяемого многочлена. Должна совпадать с
/// BIG_Q_COEFFICIENTS / 4 в zk/bn254-hints.mjs.
const HINT_BIGQ_CELLS: int = 55

/// Случайная точка z и s = z⁶ − 9.
global hintZ: int
global hintS: int

// >>> профиль
/// Отметки расхода газа по стадиям — только для профилирования на стенде.
global hintGasMarks: array<int>

@inline
fun markGas() {
  hintGasMarks.push(getGasConsumedAtTheMoment());
}

// <<< профиль
/// Константы ключа верификации (раскладка — zk/gen-bn254-groth16-fixture.mjs).
struct HintedVk {
  /// IC0 плюс вклад всех постоянных публичных входов.
  ic0x: uint254
  ic0y: uint254
  /// Результат цикла Миллера для (α, β): 12 чисел в порядке башни.
  alphaBeta: cell
  /// Линии γ и δ: на шаг две ячейки по 4 числа — (λ, μ) для γ, затем для δ.
  fixedLines: cell
  /// Оконные таблицы (окна по HINT_WINDOW_BITS бит, дерево ячеек с прямой адресацией —
  /// раскладка в windowTable, zk/bn254-hints.mjs) для IC-точек двух переменных
  /// публичных входов. Вклад постоянных входов заранее сложен в (ic0x, ic0y).
  table0: cell
  table1: cell
}

@pure
fun sha256OfFiveBuilders(b1: builder, b2: builder, b3: builder, b4: builder, b5: builder, count: int): uint256
  asm "HASHEXT_SHA256"

/// Ссылка ячейки по номеру, без сдвига среза.
@pure
fun preloadRefIndex(s: slice, index: int): cell
  asm "PLDREFVAR"

@pure
fun sha256OfOneBuilder(b: builder, count: int): uint256
  asm "HASHEXT_SHA256"

/// Коэффициент Fp2 (a0 + a1·u) как многочлен от x в точке z: a0 + a1·(z⁶ − 9).
@inline
fun pairAtZ(a0: int, a1: int): int {
  return a0 + fpMul(a1, hintS);
}

/// Элемент башни в точке z, схемой Горнера по степеням x от 5 до 0.
/// Пара (i, j) башни стоит при x^(2j + i).
@inline_ref
fun evalFp12(f: Fp12): int {
  var acc = pairAtZ(f.c1.c2.c0, f.c1.c2.c1);
  acc = fpMul(acc, hintZ) + pairAtZ(f.c0.c2.c0, f.c0.c2.c1);
  acc = fpMul(acc, hintZ) + pairAtZ(f.c1.c1.c0, f.c1.c1.c1);
  acc = fpMul(acc, hintZ) + pairAtZ(f.c0.c1.c0, f.c0.c1.c1);
  acc = fpMul(acc, hintZ) + pairAtZ(f.c1.c0.c0, f.c1.c0.c1);
  return fpMul(acc, hintZ) + pairAtZ(f.c0.c0.c0, f.c0.c0.c1);
}

/// Элемент подполя Fp6 (в башне c1 = 0): только чётные степени x.
@inline_ref
fun evalFp6(f: Fp6): int {
  val z2 = fpMul(hintZ, hintZ);
  var acc = pairAtZ(f.c2.c0, f.c2.c1);
  acc = fpMul(acc, z2) + pairAtZ(f.c1.c0, f.c1.c1);
  return fpMul(acc, z2) + pairAtZ(f.c0.c0, f.c0.c1);
}

/// Константа Fp2 как многочлен от x в точке z.
@inline
fun gammaAtZ(g0: int, g1: int): int {
  return g0 + fpMul(g1, hintS);
}

/// Произведение трёх множителей замыкающего тождества в точке z:
///   (c⁻¹)^p · c^(p²) · (c⁻¹)^(p³).
/// Фробениус степени j от Σ t_k·x^k равен Σ conj^j(t_k)·γ_{j,k}·x^k, где
/// γ_{j,k} = ξ^(k(p^j − 1)/6). Произведение conj(t_k)·γ не редуцируется по
/// u² = −1: тождество и так проверяется по модулю P(x), а (x⁶ − 9)² ≡ −1.
/// Поэтому в точке z это просто произведение двух чисел — без арифметики башни.
@inline_ref
fun frobeniusFactorsAtZ(c: Fp12, cInv: Fp12): int {
  // Коэффициенты c⁻¹ с сопряжением (нечётные степени Фробениуса): a0 − a1·s.
  val i0 = cInv.c0.c0.c0 - fpMul(cInv.c0.c0.c1, hintS);
  val i1 = cInv.c1.c0.c0 - fpMul(cInv.c1.c0.c1, hintS);
  val i2 = cInv.c0.c1.c0 - fpMul(cInv.c0.c1.c1, hintS);
  val i3 = cInv.c1.c1.c0 - fpMul(cInv.c1.c1.c1, hintS);
  val i4 = cInv.c0.c2.c0 - fpMul(cInv.c0.c2.c1, hintS);
  val i5 = cInv.c1.c2.c0 - fpMul(cInv.c1.c2.c1, hintS);
  // Коэффициенты c без сопряжения (чётная степень).
  val d0 = pairAtZ(c.c0.c0.c0, c.c0.c0.c1);
  val d1 = pairAtZ(c.c1.c0.c0, c.c1.c0.c1);
  val d2 = pairAtZ(c.c0.c1.c0, c.c0.c1.c1);
  val d3 = pairAtZ(c.c1.c1.c0, c.c1.c1.c1);
  val d4 = pairAtZ(c.c0.c2.c0, c.c0.c2.c1);
  val d5 = pairAtZ(c.c1.c2.c0, c.c1.c2.c1);

  var f1 = fpMul(i5, gammaAtZ(BN254_FROBX_P1_K5_C0, BN254_FROBX_P1_K5_C1));
  f1 = fpMul(f1, hintZ) + fpMul(i4, gammaAtZ(BN254_FROBX_P1_K4_C0, BN254_FROBX_P1_K4_C1));
  f1 = fpMul(f1, hintZ) + fpMul(i3, gammaAtZ(BN254_FROBX_P1_K3_C0, BN254_FROBX_P1_K3_C1));
  f1 = fpMul(f1, hintZ) + fpMul(i2, gammaAtZ(BN254_FROBX_P1_K2_C0, BN254_FROBX_P1_K2_C1));
  f1 = fpMul(f1, hintZ) + fpMul(i1, gammaAtZ(BN254_FROBX_P1_K1_C0, BN254_FROBX_P1_K1_C1));
  f1 = fpMul(f1, hintZ) + i0;
  var f2 = fpMul(d5, gammaAtZ(BN254_FROBX_P2_K5_C0, BN254_FROBX_P2_K5_C1));
  f2 = fpMul(f2, hintZ) + fpMul(d4, gammaAtZ(BN254_FROBX_P2_K4_C0, BN254_FROBX_P2_K4_C1));
  f2 = fpMul(f2, hintZ) + fpMul(d3, gammaAtZ(BN254_FROBX_P2_K3_C0, BN254_FROBX_P2_K3_C1));
  f2 = fpMul(f2, hintZ) + fpMul(d2, gammaAtZ(BN254_FROBX_P2_K2_C0, BN254_FROBX_P2_K2_C1));
  f2 = fpMul(f2, hintZ) + fpMul(d1, gammaAtZ(BN254_FROBX_P2_K1_C0, BN254_FROBX_P2_K1_C1));
  f2 = fpMul(f2, hintZ) + d0;
  var f3 = fpMul(i5, gammaAtZ(BN254_FROBX_P3_K5_C0, BN254_FROBX_P3_K5_C1));
  f3 = fpMul(f3, hintZ) + fpMul(i4, gammaAtZ(BN254_FROBX_P3_K4_C0, BN254_FROBX_P3_K4_C1));
  f3 = fpMul(f3, hintZ) + fpMul(i3, gammaAtZ(BN254_FROBX_P3_K3_C0, BN254_FROBX_P3_K3_C1));
  f3 = fpMul(f3, hintZ) + fpMul(i2, gammaAtZ(BN254_FROBX_P3_K2_C0, BN254_FROBX_P3_K2_C1));
  f3 = fpMul(f3, hintZ) + fpMul(i1, gammaAtZ(BN254_FROBX_P3_K1_C0, BN254_FROBX_P3_K1_C1));
  f3 = fpMul(f3, hintZ) + i0;
  return fpMul(fpMul(f1, f2), f3);
}

/// Очередной аккумулятор: 12 коэффициентов многочлена, старший первым, по 4 в
/// ячейке. Цепочка выровнена и заканчивается пустой ячейкой, поэтому проверок
/// «остались ли биты» нет.
@inline
fun evalNextAccumulator(mutate s: slice): int {
  var acc = 0;
  repeat (3) {
    acc = fpMul(acc, hintZ) + s.loadUint(254);
    acc = fpMul(acc, hintZ) + s.loadUint(254);
    acc = fpMul(acc, hintZ) + s.loadUint(254);
    acc = fpMul(acc, hintZ) + s.loadUint(254);
    s = s.preloadRef().beginParse();
  }
  return acc;
}

/// Нормированная линия в точке z: 1 + a·λ(z) + b·μ(z),
/// где a = −(x_P / y_P)·z, b = (1 / y_P)·z³.
@inline
fun lineAtZ(lambda: Fp2, mu: Fp2, a: int, b: int): int {
  return 1 + fpMul(a, pairAtZ(lambda.c0, lambda.c1)) + fpMul(b, pairAtZ(mu.c0, mu.c1));
}

/// Линия фиксированной точки ключа: (λ, μ) — одна ячейка.
@inline
fun evalFixedLine(mutate s: slice, a: int, b: int): int {
  val l0 = s.loadUint(254);
  val l1 = s.loadUint(254);
  val m0 = s.loadUint(254);
  val m1 = s.loadUint(254);
  s = s.preloadRef().beginParse();
  return 1 + fpMul(a, l0 + fpMul(l1, hintS)) + fpMul(b, m0 + fpMul(m1, hintS));
}

@inline
fun fp2IsZero(v: Fp2): bool {
  return (v.c0 % BN254_P == 0) && (v.c1 % BN254_P == 0);
}

/// Точка G1 на кривой y² = x³ + 3, координаты приведены.
@inline
fun g1IsValid(x: int, y: int): bool {
  return (x >= 0) && (x < BN254_P) && (y >= 0) && (y < BN254_P)
    && ((fpMul(y, y) - fpMul(fpMul(x, x), x) - 3) % BN254_P == 0);
}

/// Точка на скрученной кривой y² = x³ + 3 / (9 + u), координаты приведены.
@inline_ref
fun g2IsOnTwist(q: G2Affine): bool {
  val inRange = (q.x.c0 >= 0) && (q.x.c0 < BN254_P) && (q.x.c1 >= 0) && (q.x.c1 < BN254_P)
    && (q.y.c0 >= 0) && (q.y.c0 < BN254_P) && (q.y.c1 >= 0) && (q.y.c1 < BN254_P);
  val rhs = q.x.sqrFast().mul(q.x).add(Fp2 { c0: BN254_TWIST_B_C0, c1: BN254_TWIST_B_C1 });
  return inRange && fp2IsZero(q.y.sqrFast().sub(rhs));
}

/// Удвоение T по присланному наклону. Проверяет λ·2y = 3x² и возвращает μ.
@inline
fun hintedDouble(mutate t: G2Affine, lambda: Fp2): Fp2 {
  // Отдельная проверка y ≠ 0 не нужна: при y = 0 равенство ниже требует x = 0,
  // а точка (0, 0) не лежит на кривой (T всегда на кривой, раз наклоны проверены).
  val xx = t.x.sqrFast();
  assert (fp2IsZero(lambda.mul(t.y.add(t.y)).sub(xx).sub(xx).sub(xx))) throw 7006;
  val x3 = lambda.sqrFast().sub(t.x).sub(t.x).reduce();
  val mu = lambda.mul(t.x).sub(t.y);
  t = G2Affine { x: x3, y: mu.sub(lambda.mul(x3)).reduce() };
  return mu;
}

/// Сложение T += Q по присланному наклону. Проверяет λ·(x_Q − x_T) = y_Q − y_T.
@inline
fun hintedAdd(mutate t: G2Affine, q: G2Affine, lambda: Fp2): Fp2 {
  val dx = q.x.sub(t.x);
  assert (!fp2IsZero(dx)) throw 7005;
  assert (fp2IsZero(lambda.mul(dx).sub(q.y).add(t.y))) throw 7006;
  val x3 = lambda.sqrFast().sub(t.x).sub(q.x).reduce();
  val mu = lambda.mul(t.x).sub(t.y);
  t = G2Affine { x: x3, y: mu.sub(lambda.mul(x3)).reduce() };
  return mu;
}

/// Прибавляет к точке (x, y) кратное scalar · IC по оконной таблице: по одному
/// сложению на ненулевую цифру. Делений нет: наклон каждой секущей присылает
/// прувер, контракт проверяет λ·(x₂ − x₁) = y₂ − y₁.
@inline_ref
fun addPublicInput(startX: int, startY: int, publicInput: int, table: cell, mutate slopes: slice): (int, int) {
  var x = startX;
  var y = startY;
  var scalar = publicInput;
  // Окна лежат в дереве с ветвлением 4: корень → узел первого уровня → часть → окно.
  // Они нужны по порядку, поэтому узлы перечитываются только на границах четвёрок.
  val root = table.beginParse();
  var level1 = root;
  var part = root;
  var windowIndex = 0;
  while (scalar != 0) {
    if ((windowIndex & 3) == 0) {
      if ((windowIndex & 15) == 0) {
        level1 = preloadRefIndex(root, windowIndex >> 4).beginParse();
      }
      part = preloadRefIndex(level1, (windowIndex >> 2) & 3).beginParse();
    }
    val digit = scalar & ((1 << HINT_WINDOW_BITS) - 1);
    if (digit != 0) {
      // Лист L = digit >> 1: группа L >> 4, узел (L >> 2) & 3, лист L & 3; в листе две точки.
      val leafIndex = digit >> 1;
      val window = preloadRefIndex(part, windowIndex & 3).beginParse();
      val group = preloadRefIndex(window, leafIndex >> 4).beginParse();
      val node = preloadRefIndex(group, (leafIndex >> 2) & 3).beginParse();
      var leaf = preloadRefIndex(node, leafIndex & 3).beginParse();
      if ((digit & 1) != 0) {
        leaf.skipBits(508);
      }
      val px = leaf.loadUint(254);
      val py = leaf.loadUint(254);
      val lambda = readFp(mutate slopes);
      val dx = px - x;
      assert (dx % BN254_P != 0) throw 7005;
      assert ((fpMul(lambda, dx) - py + y) % BN254_P == 0) throw 7006;
      val x3 = (fpMul(lambda, lambda) - x - px) % BN254_P;
      y = (fpMul(lambda, x - x3) - y) % BN254_P;
      x = x3;
    }
    scalar = scalar >> HINT_WINDOW_BITS;
    windowIndex += 1;
  }
  return (x, y);
}

/// hints: четыре ссылки — свидетель с подсказками точек (обратные к ординатам и
/// наклоны сложений для vk_x), наклоны линий точки B, аккумуляторы, bigQ.
/// input0, input1 — переменные публичные входы (второй равен 0, если его нет).
@inline_ref
fun groth16VerifyBn254Hinted(
  ax: int, ay: int, b: G2Affine, cx: int, cy: int,
  input0: int, input1: int,
  vkData: cell, hints: cell
): bool {
  assert (input0 >= 0 && input0 < BN254_R && input1 >= 0 && input1 < BN254_R) throw 7003;
  hintGasMarks = [];
  markGas();
  assert (g1IsValid(ax, ay) && g1IsValid(cx, cy) && g2IsOnTwist(b)) throw 7010;
  var hintsRoot = hints.beginParse();
  val committed = hintsRoot.loadRef();
  val slopeCell = hintsRoot.loadRef();
  val accumulators = hintsRoot.loadRef();
  val bigQ = hintsRoot.loadRef();
  assert (hintsRoot.remainingBitsCount() == 0 && hintsRoot.remainingRefsCount() == 0) throw 7004;

  // --- Fiat–Shamir: ρ после всех подсказок, кроме bigQ; z после bigQ ---
  val seed = sha256OfFiveBuilders(
    beginCell().storeUint(ax, 256).storeUint(ay, 256).storeUint(cx, 256),
    beginCell().storeUint(cy, 256).storeUint(b.x.c0, 256).storeUint(b.x.c1, 256),
    beginCell().storeUint(b.y.c0, 256).storeUint(b.y.c1, 256).storeUint(input0, 256),
    beginCell().storeUint(vkData.hash(), 256).storeUint(committed.hash(), 256).storeUint(input1, 256),
    beginCell().storeUint(slopeCell.hash(), 256).storeUint(accumulators.hash(), 256),
    5
  );
  val rho = seed % BN254_P;
  val z = sha256OfOneBuilder(beginCell().storeUint(seed, 256).storeUint(bigQ.hash(), 256), 1) % BN254_P;
  val z3 = fpMul(fpMul(z, z), z);
  val z6 = fpMul(z3, z3);
  hintZ = z;
  hintS = (z6 - 9) % BN254_P;

  // --- свидетель и подсказки точек ---
  var witness = committed.beginParse();
  val c = readFp12(mutate witness);
  val cInv = readFp12(mutate witness);
  val w0 = readFp2(mutate witness);
  val w1 = readFp2(mutate witness);
  val w2 = readFp2(mutate witness);
  val invVkY = readFp(mutate witness);
  val invAy = readFp(mutate witness);
  val invCy = readFp(mutate witness);

  // --- vk_x по оконной таблице; обратные к ординатам — подсказки с проверкой ---
  val vk = HintedVk.fromCell(vkData);
  val (partialX, partialY) = addPublicInput(vk.ic0x, vk.ic0y, input0, vk.table0, mutate witness);
  val (vkX, vkY) = addPublicInput(partialX, partialY, input1, vk.table1, mutate witness);
  assert (witness.remainingBitsCount() == 0 && witness.remainingRefsCount() == 0) throw 7004;
  assert (fpMul(vkY, invVkY) == 1) throw 7008;
  assert (fpMul(ay, invAy) == 1) throw 7008;
  assert (fpMul(cy, invCy) == 1) throw 7008;
  markGas();

  // Множители линий для трёх пар: a = −(x_P / y_P)·z, b = (1 / y_P)·z³.
  // Первая пара — (−A, B): y_P = −ay.
  val aB = fpMul(fpMul(ax, invAy), z);
  val bB = fpMul(-invAy, z3);
  val aG = fpMul(fpMul(-vkX, invVkY), z);
  val bG = fpMul(invVkY, z3);
  val aD = fpMul(fpMul(-cx, invCy), z);
  val bD = fpMul(invCy, z3);

  val cAtZ = evalFp12(c);
  val cInvAtZ = evalFp12(cInv);
  var fixedLines = vk.fixedLines.beginParse();
  var slopes = slopeCell.beginParse();
  var accumulatorChain = accumulators.beginParse();
  var t = b;
  val posB = t;
  val negB = G2Affine { x: t.x, y: t.y.neg() };

  // --- цикл: по одному тождеству на цифру NAF ---
  var current = cInvAtZ;
  var acc = 0;
  var sinceCheckpoint = 0;
  var i = BN254_NAF_LEN - 1;
  while (i >= 0) {
    var lhs = fpMul(current, current);
    val lambda = readFp2(mutate slopes);
    val mu = hintedDouble(mutate t, lambda);
    lhs = fpMul(lhs, lineAtZ(lambda, mu, aB, bB));
    lhs = fpMul(lhs, evalFixedLine(mutate fixedLines, aG, bG));
    lhs = fpMul(lhs, evalFixedLine(mutate fixedLines, aD, bD));
    if (((BN254_NAF_NONZERO >> i) & 1) != 0) {
      val isNegative = ((BN254_NAF_NEGATIVE >> i) & 1) != 0;
      val lambdaAdd = readFp2(mutate slopes);
      val muAdd = hintedAdd(mutate t, isNegative ? negB : posB, lambdaAdd);
      lhs = fpMul(lhs, lineAtZ(lambdaAdd, muAdd, aB, bB));
      lhs = fpMul(lhs, evalFixedLine(mutate fixedLines, aG, bG));
      lhs = fpMul(lhs, evalFixedLine(mutate fixedLines, aD, bD));
      lhs = fpMul(lhs, isNegative ? cAtZ : cInvAtZ);
    }
    sinceCheckpoint += 1;
    if (sinceCheckpoint == HINT_CHECKPOINT_EVERY || i == 0) {
      val next = evalNextAccumulator(mutate accumulatorChain);
      acc = fpMul(acc, rho) + lhs - next;
      current = next;
      sinceCheckpoint = 0;
    } else {
      current = lhs;
    }
    i -= 1;
  }
  assert (accumulatorChain.remainingBitsCount() == 0 && accumulatorChain.remainingRefsCount() == 0) throw 7004;
  markGas();

  // --- замыкающее тождество: два шага с psi(B), константа (α, β), свидетель ---
  val q1 = posB.psi();
  val q2 = q1.psi();
  val lambda1 = readFp2(mutate slopes);
  val mu1 = hintedAdd(mutate t, q1, lambda1);
  var closing = fpMul(current, lineAtZ(lambda1, mu1, aB, bB));
  closing = fpMul(closing, evalFixedLine(mutate fixedLines, aG, bG));
  closing = fpMul(closing, evalFixedLine(mutate fixedLines, aD, bD));
  val lambda2 = readFp2(mutate slopes);
  val mu2 = hintedAdd(mutate t, G2Affine { x: q2.x, y: q2.y.neg() }, lambda2);
  closing = fpMul(closing, lineAtZ(lambda2, mu2, aB, bB));
  closing = fpMul(closing, evalFixedLine(mutate fixedLines, aG, bG));
  closing = fpMul(closing, evalFixedLine(mutate fixedLines, aD, bD));
  assert (slopes.remainingBitsCount() == 0 && slopes.remainingRefsCount() == 0) throw 7004;
  // Подгруппа G2: после последнего шага T обязана равняться −ψ³(B).
  val q3 = q2.psi();
  assert (fp2IsZero(t.x.sub(q3.x)) && fp2IsZero(t.y.add(q3.y))) throw 7009;

  var alphaBetaSlice = vk.alphaBeta.beginParse();
  closing = fpMul(closing, evalFp12(readFp12(mutate alphaBetaSlice)));
  closing = fpMul(closing, frobeniusFactorsAtZ(c, cInv));
  closing = fpMul(closing, evalFp6(Fp6 { c0: w0, c1: w1, c2: w2 }));
  acc = fpMul(acc, rho) + closing - 1;

  // --- c · c⁻¹ = 1 ---
  acc = fpMul(acc, rho) + fpMul(cAtZ, cInvAtZ) - 1;
  markGas();

  // --- правая часть: bigQ(z) · P(z) ---
  // Ровно HINT_BIGQ_CELLS ячеек по 4 коэффициента, затем пустая ячейка.
  var quotient = bigQ.beginParse();
  var quotientAtZ = 0;
  repeat (HINT_BIGQ_CELLS) {
    quotientAtZ = fpMul(quotientAtZ, z) + quotient.loadUint(254);
    quotientAtZ = fpMul(quotientAtZ, z) + quotient.loadUint(254);
    quotientAtZ = fpMul(quotientAtZ, z) + quotient.loadUint(254);
    quotientAtZ = fpMul(quotientAtZ, z) + quotient.loadUint(254);
    quotient = quotient.preloadRef().beginParse();
  }
  assert (quotient.remainingBitsCount() == 0 && quotient.remainingRefsCount() == 0) throw 7004;
  val pAtZ = fpMul(z6, z6 - 18) + 82;
  markGas();
  return (acc - fpMul(quotientAtZ, pAtZ)) % BN254_P == 0;
}
