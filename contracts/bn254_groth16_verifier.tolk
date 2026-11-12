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
import "bn254/verifier_api"

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

struct (0x42543234) VerifyProof {
  queryId: uint64
  /// Переменные публичные входы (второй равен 0, если у схемы он один).
  input0: uint256
  input1: uint256
  proof: Cell<ProofPoints>
  /// Свидетель, наклоны, аккумуляторы и частное (zk/bn254-hints.mjs).
  hints: cell
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

fun onInternalMessage(inMsg: InMessage) {
  val msg = lazy Bn254VerifierMessage.fromSlice(inMsg.body);

  match (msg) {
    VerifyProof => {
      var storage = Bn254VerifierStorage.fromCell(contract.getData());
      assert (storage.vkData != null) throw Bn254VerifierErrors.KeyNotFinalized;
      val ok = verifyBn254Proof(msg.proof, msg.input0, msg.input1, storage.vkData!, msg.hints);
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
      assert (isKeySlotValid(msg.slot)) throw Bn254VerifierErrors.BadKeyPart;
      storage.parts.set(msg.slot, msg.part);
      contract.setData(storage.toCell());
    }

    FinalizeKey => {
      var storage = Bn254VerifierStorage.fromCell(contract.getData());
      assert (inMsg.senderAddress == storage.owner) throw Bn254VerifierErrors.NotOwner;
      assert (storage.vkData == null) throw Bn254VerifierErrors.KeyAlreadyFinalized;
      storage.vkData = assembleKey(storage.parts, msg);
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
