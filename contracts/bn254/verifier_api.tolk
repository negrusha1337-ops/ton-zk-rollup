// Общее для контрактов, которые встраивают верификатор BN254: формат пруфа в
// сообщении и загрузка ключа верификации частями.
import "fp2"
import "pairing"
import "hinted"

/// Координаты точки B: вещественная и мнимая части x и y.
struct G2Coordinates {
  x0: uint254
  x1: uint254
  y0: uint254
  y1: uint254
}

/// Точки A и C пруфа и ссылка на координаты B. Четыре числа по 254 бита —
/// ровно одна ячейка; по 256 бит в ячейку поместились бы только три.
struct ProofPoints {
  ax: uint254
  ay: uint254
  cx: uint254
  cy: uint254
  b: Cell<G2Coordinates>
}

/// Проверка пруфа из сообщения против собранного ключа.
/// input0, input1 — переменные публичные входы (второй равен 0, если его нет).
@inline
fun verifyBn254Proof(proof: Cell<ProofPoints>, input0: int, input1: int, vkData: cell, hints: cell): bool {
  val points = proof.load();
  val b = points.b.load();
  return groth16VerifyBn254Hinted(
    points.ax, points.ay,
    G2Affine { x: Fp2 { c0: b.x0, c1: b.x1 }, y: Fp2 { c0: b.y0, c1: b.y1 } },
    points.cx, points.cy,
    input0, input1,
    vkData, hints
  );
}

// ---------------------------------------------------------------------------
// Загрузка ключа. Ключ (тысячи ячеек) не помещается в одно сообщение, поэтому
// владелец присылает его частями и затем фиксирует.
// ---------------------------------------------------------------------------

/// Номера частей ключа: части таблиц идут подряд от своего основания.
const KEY_SLOT_TABLE0: int = 0
const KEY_SLOT_TABLE1: int = 16
const KEY_SLOT_FIXED_LINES: int = 32
const KEY_MAX_TABLE_PARTS: int = 16

/// Код ошибки для неверной или недостающей части ключа.
const KEY_ERROR_BAD_PART: int = 7105

/// Одна часть ключа. Размер части подобран так, чтобы сообщение проходило
/// через обычный кошелёк (внешнее сообщение ограничено 64 КБ).
struct (0x42543235) UploadKeyPart {
  queryId: uint64
  slot: uint8
  part: cell
}

/// Собирает ключ из загруженных частей и запрещает дальнейшие изменения.
struct (0x42543236) FinalizeKey {
  queryId: uint64
  /// IC0 плюс вклад постоянных публичных входов.
  ic0x: uint254
  ic0y: uint254
  /// Результат цикла Миллера для (α, β).
  alphaBeta: cell
  /// Сколько частей у таблиц первого и второго переменного входа (0 — таблицы нет).
  table0Parts: uint8
  table1Parts: uint8
}

@inline
fun isKeySlotValid(slot: int): bool {
  return (slot < KEY_SLOT_TABLE1 + KEY_MAX_TABLE_PARTS) || (slot == KEY_SLOT_FIXED_LINES);
}

/// Корень оконной таблицы из частей: по четыре в узлы первого уровня, узлы — в
/// корень. Должно совпадать с assembleTable в zk/bn254-hints.mjs: хеш собранного
/// ключа входит в транскрипт проверки.
fun assembleTable(parts: map<uint8, cell>, base: int, count: int): cell {
  var root = beginCell();
  var index = 0;
  while (index < count) {
    var node = beginCell();
    var inNode = 0;
    while ((inNode < 4) && (index < count)) {
      node = node.storeRef(parts.mustGet(base + index, KEY_ERROR_BAD_PART));
      index += 1;
      inNode += 1;
    }
    root = root.storeRef(node.endCell());
  }
  return root.endCell();
}

/// Собранный ключ (раскладка HintedVk в hinted.tolk).
fun assembleKey(parts: map<uint8, cell>, msg: FinalizeKey): cell {
  assert ((msg.table0Parts >= 1) && (msg.table0Parts <= KEY_MAX_TABLE_PARTS) && (msg.table1Parts <= KEY_MAX_TABLE_PARTS))
    throw KEY_ERROR_BAD_PART;
  val fixedLines = parts.mustGet(KEY_SLOT_FIXED_LINES, KEY_ERROR_BAD_PART);
  val table0 = assembleTable(parts, KEY_SLOT_TABLE0, msg.table0Parts);
  val table1 = assembleTable(parts, KEY_SLOT_TABLE1, msg.table1Parts);
  return beginCell()
    .storeUint(msg.ic0x, 254)
    .storeUint(msg.ic0y, 254)
    .storeRef(msg.alphaBeta)
    .storeRef(fixedLines)
    .storeRef(table0)
    .storeRef(table1)
    .endCell();
}
