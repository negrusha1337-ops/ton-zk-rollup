// Аварийный режим rollup-контракта: заморозка, возврат необработанных депозитов, уборка
// словаря очереди и заявка на выход счёта L2 (сам выход — rollup/evm_exit.tolk).
//
// Срок заморозки считается по очереди L1→L2, в которую попадают и депозиты, и
// принудительные транзакции (ForceTransaction в logic.tolk): пользователь, которого
// секвенсор не включает, ставит транзакцию в очередь сам, и дальше её либо обработают,
// либо rollup заморозят.
//
// Выхода по пруфу zkVM в протоколе версии 2 нет: программы выхода для EVM не существует, а
// ключ-заглушка хуже отсутствия пути (PROTOCOL-V2.md, раздел 9).
import "storage"
import "messages"
import "logic"
import "nullifier_types"

/// Основание ключей нуллификатора для аварийных выходов: номера листьев дерева выводов
/// занимают 32 бита, счета L2 — 160, так что пространства не пересекаются.
const EXIT_NULLIFIER_BASE: int = 1 << 255

@inline
fun exitNullifierKey(l2Account: int): int {
  return EXIT_NULLIFIER_BASE + l2Account;
}

/// Момент, когда в очередь встал самый старый необработанный элемент (депозит или
/// принудительная транзакция); 0, если очередь обработана целиком. Отдельно не хранится:
/// это время постановки элемента processed + 1.
@inline
fun oldestPendingDepositAt(state: RollupState, queue: DepositQueue): int {
  if (queue.processedCount == queue.headCount) {
    return 0;
  }
  val oldest = state.queueItems.get(queue.processedCount + 1);
  // Записи необработанных элементов удаляет только возврат депозита, а он возможен лишь
  // после заморозки, когда срок уже никого не интересует.
  return oldest.isFound ? oldest.loadValue().queuedAt : 0;
}

fun handleActivateEscapeHatch() {
  var storage = RollupStorage.load();
  var state = storage.state.load();
  assert (!state.frozen) throw RollupErrors.RollupFrozen;
  val oldest = oldestPendingDepositAt(state, state.queue.load());
  assert ((oldest != 0) && (blockchain.now() - oldest > storage.escapeTimeout)) throw RollupErrors.EscapeNotDue;
  state.frozen = true;
  storage.state = state.toCell();
  storage.save();
}

/// Заявка в нуллификатор счёта после того, как право на выход проверено. Выплата — когда он
/// подтвердит, что счёт выходит впервые (handleNullifierClaimed).
fun completeForceExit(storage: RollupStorage, queryId: int, claim: ExitClaim) {
  val request = createMessage({
    bounce: BounceMode.Only256BitsOfBody,
    value: 0,
    dest: nullifierDeployment(storage.nullifierCode, exitNullifierKey(claim.l2Account)),
    body: NullifierClaim { queryId: queryId, recipient: claim.recipient, amount: claim.amount as coins },
  });
  request.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

/// Возврат депозита, не попавшего в батч до заморозки. Запись удаляется в той же
/// транзакции, поэтому нуллификатор не нужен.
fun handleCancelDeposit(msg: CancelDeposit) {
  var storage = RollupStorage.load();
  var state = storage.state.load();
  assert (state.frozen) throw RollupErrors.RollupNotFrozen;
  // Обработанные депозиты уже зачислены на L2: их забирают выходом счёта, а не возвратом.
  assert (msg.depositIndex > state.queue.load().processedCount) throw RollupErrors.DepositAlreadyProcessed;
  val entry = state.queueItems.deleteAndGetDeleted(msg.depositIndex);
  assert (entry.isFound) throw RollupErrors.NoSuchDeposit;
  val receipt = entry.loadValue().receipt;
  // У принудительной транзакции квитанции нет: возвращать нечего.
  assert (receipt != null) throw RollupErrors.NoSuchDeposit;
  // Нет денег — исключение: запись остаётся, возврат можно повторить позже. Монеты
  // этого сообщения остаются на контракте и в возврате участвуют.
  assert (canPay(receipt.amount, 0)) throw RollupErrors.InsufficientFunds;
  storage.state = state.toCell();
  storage.save();
  sendPayout(receipt.depositor, receipt.amount);
}

/// Уборка: записи обработанных элементов очереди больше не нужны. Удаляет не больше count
/// самых старых, чтобы уложиться в газ одной транзакции. Необработанные не трогает.
fun handlePruneDepositReceipts(msg: PruneDepositReceipts) {
  var storage = RollupStorage.load();
  var state = storage.state.load();
  var queue = state.queue.load();
  pruneQueueItems(mutate state, mutate queue, msg.count);
  state.queue = queue.toCell();
  storage.state = state.toCell();
  storage.save();
}

// ---------------------------------------------------------------------------
// Просмотр состояния (get-методы точек входа)
// ---------------------------------------------------------------------------

/// (заморожен ли, когда встал самый старый необработанный элемент или 0, срок в секундах)
fun escapeStateView(): (bool, int, int) {
  val storage = RollupStorage.load();
  val state = storage.state.load();
  return (state.frozen, oldestPendingDepositAt(state, state.queue.load()), storage.escapeTimeout);
}

/// (вноситель, сумма) по номеру элемента очереди; сумма 0, если квитанции нет.
fun depositReceiptView(depositIndex: int): (address?, int) {
  val entry = RollupStorage.load().state.load().queueItems.get(depositIndex);
  if (!entry.isFound) {
    return (null, 0);
  }
  val receipt = entry.loadValue().receipt;
  if (receipt == null) {
    return (null, 0);
  }
  return (receipt.depositor, receipt.amount);
}
