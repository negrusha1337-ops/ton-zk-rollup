// Хранилище rollup-контракта (минимальная версия). Обоснования — ARCHITECTURE.md.

/// Очередь депозитов L1→L2. Сами депозиты не хранятся — только накопительный хеш
///   hash[i] = sha256(hash[i-1] ‖ получатель L2 ‖ сумма)
/// в трёх точках. Словаря нет: память и газ не растут с числом депозитов.
///
/// Правило принудительного включения: каждый батч обязан обработать очередь ровно
/// до отметки target, а после него target сдвигается на head. То есть депозит,
/// попавший в очередь до принятия батча k−1, обязан быть обработан батчем k.
struct DepositQueue {
  /// Все поставленные депозиты.
  headCount: uint64
  headHash: uint256
  /// Докуда обязан дойти следующий батч.
  targetCount: uint64
  targetHash: uint256
  /// Уже учтено в stateRoot.
  processedCount: uint64
  processedHash: uint256
}

/// Изменяемое состояние rollup'а — отдельная ячейка, перезаписывается каждым батчем.
struct RollupState {
  /// Корень состояния L2.
  stateRoot: uint256
  /// Корень дерева выводов L2→L1 (накопительное дерево, глубина WITHDRAWAL_TREE_DEPTH).
  withdrawalsRoot: uint256
  batchIndex: uint64
  queue: Cell<DepositQueue>
}

/// Корневая ячейка. Редко меняющиеся поля и ссылки на всё остальное.
struct RollupStorage {
  /// Загружает и фиксирует ключ верификации.
  owner: address
  /// Единственный, кто может присылать батчи.
  sequencer: address
  /// Собранный ключ верификации; null, пока не зафиксирован.
  vkData: cell?
  /// Части ключа на время загрузки.
  keyParts: map<uint8, cell>
  /// Код дочернего контракта-нуллификатора выводов.
  nullifierCode: cell
  state: Cell<RollupState>
}

fun RollupStorage.load(): RollupStorage {
  return RollupStorage.fromCell(contract.getData());
}

fun RollupStorage.save(self) {
  contract.setData(self.toCell());
}
