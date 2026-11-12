// Сообщения rollup-контракта (минимальная версия). Цепочки и поведение при
// bounce — в ARCHITECTURE.md.
import "../bn254/verifier_api"

/// То, что батч меняет. Остальные публичные значения пруфа (прежний корень, обе
/// отметки очереди депозитов и хеш опубликованных данных батча) контракт берёт из
/// своего хранилища, поэтому батч нельзя применить не к тому состоянию, нельзя
/// отправить повторно и нельзя доказать для данных, которых в TON не было.
struct BatchRoots {
  newStateRoot: uint256
  withdrawalsRoot: uint256
}

/// Секвенсор → Rollup: новый батч с доказательством.
struct (0x52420001) SubmitBatch {
  queryId: uint64
  /// Второй публичный вход верификатора (nonce у SP1); 0, если у схемы его нет.
  nonce: uint256
  proof: Cell<ProofPoints>
  /// Свидетель, наклоны, аккумуляторы и частное (zk/bn254-hints.mjs).
  hints: cell
  roots: Cell<BatchRoots>
}

/// Секвенсор → Rollup: порция данных батча (data availability). Контракт не читает
/// содержимое — только хеш ячейки, который сеть уже посчитала. Порции одного батча
/// складываются в накопительный хеш в порядке прихода; программа zkVM обязана
/// разобрать и исполнить ровно их.
struct (0x52420003) PublishData {
  queryId: uint64
  /// Номер батча, которому принадлежит порция (номер ещё не принятого батча).
  batchIndex: uint64
  data: cell
}

/// Пользователь → Rollup: депозит TON. Сумма депозита = приложенные монеты минус DEPOSIT_FEE.
struct (0x52420002) DepositTon {
  queryId: uint64
  /// Получатель на L2 (EVM-адрес).
  l2Recipient: uint160
}

/// Кто угодно → Rollup: вывод по Merkle-доказательству против withdrawalsRoot.
/// Деньги уходят получателю из листа, газ платит отправитель сообщения.
struct (0x52420004) Withdraw {
  queryId: uint64
  leafIndex: uint32
  /// Получатель в basechain.
  recipient: address
  amount: coins
  /// Хеши-соседи от листа к корню, по три uint256 на ячейку, продолжение по ссылке.
  merkleProof: cell
}

/// Rollup → Nullifier(leafIndex): пометить вывод использованным.
struct (0x52420010) NullifierClaim {
  queryId: uint64
  recipient: address
  amount: coins
}

/// Nullifier → Rollup: вывод помечен впервые, можно платить.
struct (0x52420011) NullifierClaimed {
  queryId: uint64
  leafIndex: uint32
  recipient: address
  amount: coins
}

type RollupMessage =
  | SubmitBatch
  | PublishData
  | DepositTon
  | Withdraw
  | NullifierClaimed
  | UploadKeyPart
  | FinalizeKey
