// ЧЕРНОВИК (этап 0): схема сообщений rollup-контракта.
// Цепочки сообщений и поведение при bounce описаны в ARCHITECTURE.md.

// ---------------------------------------------------------------------------
// Секвенсор → Rollup
// ---------------------------------------------------------------------------

/// Вторая часть публичных значений батча: в корневую ячейку всё не помещается.
struct SubmitBatchTail {
  withdrawalsRoot: uint256
  /// Сколько элементов очереди L1→L2 обработано после этого батча (всего, не дельта).
  queueProcessedUpTo: uint64
}

/// Новый батч с доказательством. Старый корень в сообщении не передаётся —
/// берётся из хранилища, чтобы батч нельзя было применить не к тому состоянию.
struct (0x52420001) SubmitBatch {
  queryId: uint64
  /// Ячейка с тремя ссылками: piA, piB, piC (сжатые точки BLS12-381).
  proof: cell
  newStateRoot: uint256
  /// Обязательство на данные батча (для data availability).
  batchHash: uint256
  tail: Cell<SubmitBatchTail>
}

// ---------------------------------------------------------------------------
// Пользователь → Rollup: депозиты
// ---------------------------------------------------------------------------

/// Депозит TON. Сумма депозита = приложенные монеты минус DEPOSIT_FEE.
struct (0x52420002) DepositTon {
  queryId: uint64
  /// Получатель на L2 (EVM-адрес).
  l2Recipient: bits160
}

/// TEP-74 transfer_notification: приходит от jetton-кошелька rollup'а
/// ПОСЛЕ того, как jetton'ы уже зачислены. Бросать исключение здесь нельзя.
struct (0x7362d09c) JettonTransferNotification {
  queryId: uint64
  amount: coins
  /// Кто отправил jetton'ы (владелец исходного кошелька).
  sender: address
  forwardPayload: RemainingBitsAndRefs
}

/// Содержимое forward_payload при jetton-депозите.
struct (0x52420003) JettonDepositPayload {
  l2Recipient: bits160
}

// ---------------------------------------------------------------------------
// Вывод L2 → L1
// ---------------------------------------------------------------------------

/// Лист дерева выводов. token == null означает TON.
struct WithdrawalLeaf {
  recipient: address
  token: address?
  amount: coins
}

/// Заявка на вывод: Merkle-доказательство листа против withdrawalsRoot.
/// Отправить может кто угодно (газ платит отправитель, деньги уходят recipient).
struct (0x52420004) Withdraw {
  queryId: uint64
  leafIndex: uint64
  leaf: Cell<WithdrawalLeaf>
  /// Цепочка ячеек с хешами-соседями (по три uint256 на ячейку).
  merkleProof: cell
}

/// Rollup → Nullifier(leafIndex): пометить вывод использованным.
struct (0x52420010) NullifierClaim {
  queryId: uint64
  leaf: Cell<WithdrawalLeaf>
  /// Кому вернуть остаток газа.
  initiator: address
}

/// Nullifier → Rollup: вывод помечен, можно платить.
struct (0x52420011) NullifierClaimed {
  queryId: uint64
  leafIndex: uint64
  leaf: Cell<WithdrawalLeaf>
  initiator: address
}

/// Rollup → Nullifier(leafIndex): выплата не удалась, снять пометку.
struct (0x52420012) NullifierRelease {
  queryId: uint64
}

/// TEP-74 transfer: Rollup → свой jetton-кошелёк (выплата jetton'ов).
/// queryId := leafIndex, чтобы по bounce (первые 256 бит тела) опознать вывод.
struct (0x0f8a7ea5) JettonTransfer {
  queryId: uint64
  amount: coins
  destination: address
  responseDestination: address?
  customPayload: cell?
  forwardTonAmount: coins
  forwardPayload: RemainingBitsAndRefs
}

// ---------------------------------------------------------------------------
// Принудительное включение и escape hatch
// ---------------------------------------------------------------------------

/// Принудительная L2-транзакция: ставится в ту же очередь, что и депозиты.
struct (0x52420005) ForceTransaction {
  queryId: uint64
  /// Подписанная L2-транзакция (RLP), разбитая на ячейки.
  l2Transaction: cell
}

/// Включить escape hatch. Срабатывает, только если секвенсор просрочил
/// forceInclusionDelay + escapeTimeout.
struct (0x52420006) ActivateEscapeHatch {
  queryId: uint64
}

/// Что именно пользователь забирает из замороженного rollup'а.
struct ExitClaim {
  l2Account: bits160
  recipient: address
  token: address?
  amount: coins
}

/// Выход из замороженного rollup'а: ZK-доказательство баланса
/// против последнего финализированного stateRoot.
struct (0x52420007) ForceExit {
  queryId: uint64
  proof: cell
  claim: Cell<ExitClaim>
}

/// Возврат депозита, который так и не был обработан до заморозки.
struct (0x52420008) CancelQueuedDeposit {
  queryId: uint64
  queueIndex: uint64
  /// Исходные данные элемента очереди: контракт пересчитает их хеш.
  item: cell
}

type RollupMessage =
  | SubmitBatch
  | DepositTon
  | JettonTransferNotification
  | Withdraw
  | NullifierClaimed
  | ForceTransaction
  | ActivateEscapeHatch
  | ForceExit
  | CancelQueuedDeposit
