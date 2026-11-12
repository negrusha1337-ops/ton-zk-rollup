// ЧЕРНОВИК (этап 0): раскладка хранилища rollup-контракта.
// Логики здесь нет — только типы. Подробности и обоснования: ARCHITECTURE.md.

/// Контрольная точка очереди L1→L2: значение накопительного хеша после
/// постановки элемента и время постановки (для дедлайна принудительного включения).
struct QueueCheckpoint {
  rollingHash: uint256
  queuedAt: uint32
}

/// Очередь L1→L2 (депозиты и принудительные транзакции).
/// Сами элементы в хранилище не лежат — только накопительный хеш
/// rollingHash[i] = sha256(rollingHash[i-1] ‖ hash(item[i])).
struct PriorityQueue {
  totalQueued: uint64
  totalProcessed: uint64
  /// Накопительный хеш после последнего поставленного элемента.
  headHash: uint256
  /// Накопительный хеш на позиции totalProcessed (уже учтён в stateRoot).
  processedHash: uint256
  /// Контрольные точки ещё не обработанных элементов. Размер ограничен
  /// MAX_PENDING_QUEUE: неограниченный словарь в TON — путь к блокировке контракта.
  pending: map<uint64, QueueCheckpoint>
}

/// Jetton, принятый к депозиту. Ключ словаря — адрес jetton-кошелька,
/// принадлежащего rollup-контракту (именно он присылает transfer_notification).
struct JettonInfo {
  master: address
  /// Адрес соответствующего токена на L2.
  l2Token: bits160
}

/// Редко меняющиеся параметры — в отдельной ячейке, чтобы не перезаписывать их каждым батчем.
struct RollupConfig {
  sequencer: address
  governance: address
  /// Код дочернего контракта-нуллификатора выводов.
  nullifierCode: cell
  jettons: map<address, JettonInfo>
  /// Через сколько секунд элемент очереди обязан быть включён в батч.
  forceInclusionDelay: uint32
  /// Через сколько секунд простоя после этого дедлайна можно включить escape hatch.
  escapeTimeout: uint32
}

/// Корневая ячейка: 609 бит данных + 2 ссылки.
struct RollupStorage {
  /// Корень состояния L2 (EVM state root, 256 бит).
  stateRoot: uint256
  /// Корень накопительного (append-only) дерева выводов L2→L1.
  withdrawalsRoot: uint256
  batchIndex: uint64
  lastBatchAt: uint32
  /// true после срабатывания escape hatch: батчи больше не принимаются.
  frozen: bool
  queue: Cell<PriorityQueue>
  config: Cell<RollupConfig>
}

fun RollupStorage.load(): RollupStorage {
  return RollupStorage.fromCell(contract.getData());
}

fun RollupStorage.save(self) {
  contract.setData(self.toCell());
}
