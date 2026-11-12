// Контракт-верификатор Groth16 на BN254: принимает пруф и подсказки обычным
// internal-сообщением и проверяет их в одной транзакции (contracts/bn254/hinted.tolk).
//
// Ключ верификации (тысячи ячеек) не помещается в одно сообщение, поэтому владелец
// загружает его частями и затем фиксирует. После фиксации ключ изменить нельзя.
//
// Это стенд для измерения полной стоимости транзакции, а не rollup-контракт:
// после успешной проверки он лишь запоминает публичные входы и счётчик, и пруф
// НЕ привязан к состоянию — старое сообщение можно отправить повторно.
// Код не проходил аудит. Только Sandbox и testnet.
import "bn254/fp2"
import "bn254/pairing"
import "bn254/hinted"

contract Bn254Groth16Verifier {
  description: "Stage 0+: BN254 Groth16 verifier with hints, single-transaction test bench"
  storage: Bn254VerifierStorage
  incomingMessages: Bn254VerifierMessage
}

struct Bn254VerifierStorage {
  /// Кто может загружать и фиксировать ключ.
  owner: address
  /// Собранный ключ (раскладка HintedVk); null, пока ключ не зафиксирован.
  vkData: cell?
  /// Части ключа на время загрузки. Номера: см. KeySlot.
  parts: map<uint8, cell>
  verifiedCount: uint32
  /// Переменные публичные входы последнего принятого пруфа.
  lastInput0: uint256
  lastInput1: uint256
}

/// Номера частей ключа: части таблиц идут подряд от своего основания.
const KEY_SLOT_TABLE0: int = 0
const KEY_SLOT_TABLE1: int = 16
const KEY_SLOT_FIXED_LINES: int = 32
const KEY_MAX_TABLE_PARTS: int = 16

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

struct (0x42543234) VerifyProof {
  queryId: uint64
  /// Переменные публичные входы (второй равен 0, если у схемы он один).
  input0: uint256
  input1: uint256
  proof: Cell<ProofPoints>
  /// Свидетель, наклоны, аккумуляторы и частное (zk/bn254-hints.mjs).
  hints: cell
}

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

type Bn254VerifierMessage = VerifyProof | UploadKeyPart | FinalizeKey

enum Bn254VerifierErrors {
  WrongProof = 7100,
  UnknownMessage = 7101,
  NotOwner = 7102,
  KeyAlreadyFinalized = 7103,
  KeyNotFinalized = 7104,
  BadKeyPart = 7105,
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
      node = node.storeRef(parts.mustGet(base + index, Bn254VerifierErrors.BadKeyPart as int));
      index += 1;
      inNode += 1;
    }
    root = root.storeRef(node.endCell());
  }
  return root.endCell();
}

fun onInternalMessage(inMsg: InMessage) {
  val msg = lazy Bn254VerifierMessage.fromSlice(inMsg.body);

  match (msg) {
    VerifyProof => {
      var storage = Bn254VerifierStorage.fromCell(contract.getData());
      assert (storage.vkData != null) throw Bn254VerifierErrors.KeyNotFinalized;
      val points = msg.proof.load();
      val b = points.b.load();
      val ok = groth16VerifyBn254Hinted(
        points.ax, points.ay,
        G2Affine { x: Fp2 { c0: b.x0, c1: b.x1 }, y: Fp2 { c0: b.y0, c1: b.y1 } },
        points.cx, points.cy,
        msg.input0, msg.input1,
        storage.vkData!, msg.hints
      );
      assert (ok) throw Bn254VerifierErrors.WrongProof;

      storage.verifiedCount += 1;
      storage.lastInput0 = msg.input0;
      storage.lastInput1 = msg.input1;
      contract.setData(storage.toCell());
    }

    UploadKeyPart => {
      var storage = Bn254VerifierStorage.fromCell(contract.getData());
      assert (inMsg.senderAddress == storage.owner) throw Bn254VerifierErrors.NotOwner;
      assert (storage.vkData == null) throw Bn254VerifierErrors.KeyAlreadyFinalized;
      val isTablePart = msg.slot < KEY_SLOT_TABLE1 + KEY_MAX_TABLE_PARTS;
      assert (isTablePart || (msg.slot == KEY_SLOT_FIXED_LINES)) throw Bn254VerifierErrors.BadKeyPart;
      storage.parts.set(msg.slot, msg.part);
      contract.setData(storage.toCell());
    }

    FinalizeKey => {
      var storage = Bn254VerifierStorage.fromCell(contract.getData());
      assert (inMsg.senderAddress == storage.owner) throw Bn254VerifierErrors.NotOwner;
      assert (storage.vkData == null) throw Bn254VerifierErrors.KeyAlreadyFinalized;
      assert ((msg.table0Parts >= 1) && (msg.table0Parts <= KEY_MAX_TABLE_PARTS) && (msg.table1Parts <= KEY_MAX_TABLE_PARTS))
        throw Bn254VerifierErrors.BadKeyPart;

      val fixedLines = storage.parts.mustGet(KEY_SLOT_FIXED_LINES, Bn254VerifierErrors.BadKeyPart as int);
      val table0 = assembleTable(storage.parts, KEY_SLOT_TABLE0, msg.table0Parts);
      val table1 = assembleTable(storage.parts, KEY_SLOT_TABLE1, msg.table1Parts);
      storage.vkData = beginCell()
        .storeUint(msg.ic0x, 254)
        .storeUint(msg.ic0y, 254)
        .storeRef(msg.alphaBeta)
        .storeRef(fixedLines)
        .storeRef(table0)
        .storeRef(table1)
        .endCell();
      storage.parts = createEmptyMap();
      contract.setData(storage.toCell());
    }

    else => {
      // Пустое тело — пополнение баланса.
      assert (inMsg.body.isEmpty()) throw Bn254VerifierErrors.UnknownMessage;
    }
  }
}

/// (число принятых пруфов, первый и второй публичные входы последнего из них)
get fun verifierState(): (int, int, int) {
  val storage = Bn254VerifierStorage.fromCell(contract.getData());
  return (storage.verifiedCount, storage.lastInput0, storage.lastInput1);
}

/// Хеш зафиксированного ключа; 0, пока ключ не зафиксирован.
get fun keyHash(): int {
  val storage = Bn254VerifierStorage.fromCell(contract.getData());
  if (storage.vkData == null) {
    return 0;
  }
  return storage.vkData!.hash();
}

/// Загружена ли часть ключа с данным номером (для возобновления загрузки).
get fun hasKeyPart(slot: int): bool {
  val storage = Bn254VerifierStorage.fromCell(contract.getData());
  return storage.parts.exists(slot);
}
