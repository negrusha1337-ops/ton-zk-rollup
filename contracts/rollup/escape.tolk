// Аварийный выход rollup-контракта: заморозка, возврат необработанных депозитов и
// выход с баланса L2 по пруфу. Проверка пруфа сюда не входит — её делает файл точки
// входа (настоящая в rollup.tolk, заглушка для тестов в rollup_mock.tolk).
//
// Срок заморозки считается по очереди L1→L2, в которую попадают и депозиты, и
// принудительные транзакции (ForceTransaction в logic.tolk): пользователь, которого
// секвенсор не включает, ставит транзакцию в очередь сам, и дальше её либо обработают,
// либо rollup заморозят.
import "storage"
import "messages"
import "logic"
import "nullifier_types"
import "../bn254/verifier_api"
import "../bn254/hinted"
import "@stdlib/gas-payments"

/// Предел газа одной транзакции: столько проверка пруфа выхода потратить не может.
const FORCE_EXIT_STEP_GAS: int = 1000000

/// Минимум монет на аварийный выход: газ проверки пруфа (до предела транзакции), заявка в
/// нуллификатор и всё, что нужно ему самому. В газе, а не в монетах: при смене цен сети
/// порог меняется вместе с ними.
@inline
fun forceExitMinValue(): coins {
  return calculateGasFee(BASECHAIN, FORCE_EXIT_STEP_GAS)
    + calculateForwardFee(BASECHAIN, CLAIM_MESSAGE_BITS, CLAIM_MESSAGE_CELLS)
    + nullifierMinValue();
}
/// Основание ключей нуллификатора для аварийных выходов: номера листьев дерева выводов
/// занимают 32 бита, счета L2 — 160, так что пространства не пересекаются.
const EXIT_NULLIFIER_BASE: int = 1 << 255

@inline
fun exitNullifierKey(l2Account: int): int {
  return EXIT_NULLIFIER_BASE + l2Account;
}

/// Момент, когда в очередь встал самый старый необработанный элемент (депозит или
/// принудительная транзакция); 0, если очередь обработана целиком.
@inline
fun oldestPendingDepositAt(state: RollupState, queue: DepositQueue): int {
  if (queue.processedCount < queue.targetCount) {
    return state.queuedAfterProcessedAt;
  }
  if (queue.targetCount < queue.headCount) {
    return state.queuedAfterTargetAt;
  }
  return 0;
}

fun handleSetExitKey(sender: address, msg: SetExitKey) {
  var storage = RollupStorage.load();
  assert (sender == storage.owner) throw RollupErrors.NotOwner;
  var keys = storage.keys.load();
  // Ключ выхода неизменяем: задаётся один раз и только до фиксации основного ключа.
  assert (keys.vkData == null) throw RollupErrors.KeyAlreadyFinalized;
  assert (!storage.state.load().frozen) throw RollupErrors.RollupFrozen;
  assert ((keys.exitIc0x == 0) && (keys.exitIc0y == 0)) throw RollupErrors.KeyAlreadyFinalized;
  // Точка обязана лежать на кривой; (0, 0) на ней не лежит, поэтому «не задан» и
  // «задан» не спутать.
  assert (g1IsValid(msg.ic0x, msg.ic0y)) throw RollupErrors.BadKeyPoint;
  keys.exitIc0x = msg.ic0x;
  keys.exitIc0y = msg.ic0y;
  storage.keys = keys.toCell();
  storage.save();
}

/// Ключ программы выхода: те же части, что у ключа программы батчей, и свой IC0.
/// Раскладка — HintedVk (bn254/hinted.tolk): два числа и четыре ссылки.
fun exitVkData(keys: RollupKeys): cell {
  var batchKey = keys.vkData!.beginParse();
  batchKey.skipBits(254 + 254);
  return beginCell()
    .storeUint(keys.exitIc0x, 254)
    .storeUint(keys.exitIc0y, 254)
    .storeRef(batchKey.loadRef())
    .storeRef(batchKey.loadRef())
    .storeRef(batchKey.loadRef())
    .storeRef(batchKey.loadRef())
    .endCell();
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

/// Публичный вход пруфа выхода: sha256 от пяти 32-байтовых значений, обрезанный до
/// 253 бит. Программа выхода (zkvm/exit-lib) коммитит их в том же порядке:
///   chainId ‖ stateRoot ‖ l2Account ‖ amount ‖ хеш адреса получателя
fun exitDigest(chainId: int, stateRoot: int, l2Account: int, amount: int, recipientHash: int): int {
  val first = beginCell()
    .storeUint(chainId, 256)
    .storeUint(stateRoot, 256)
    .storeUint(l2Account, 256);
  val second = beginCell().storeUint(amount, 256).storeUint(recipientHash, 256);
  return sha256OfTwo(first, second, 2) & DIGEST_MASK_253;
}

/// Проверки аварийного выхода до пруфа — общие для настоящего контракта и тестового
/// двойника. Возвращает публичный вход, который обязан подтвердить пруф.
fun prepareForceExit(valueCoins: coins, storage: RollupStorage, claim: ExitClaim): int {
  assert (storage.keys.load().vkData != null) throw RollupErrors.KeyNotFinalized;
  assert (valueCoins >= forceExitMinValue()) throw RollupErrors.NotEnoughValue;
  val state = storage.state.load();
  assert (state.frozen) throw RollupErrors.RollupNotFrozen;
  assert (claim.amount > 0) throw RollupErrors.NothingToExit;
  assertCanPay(claim.amount as coins, valueCoins);
  val (workchain, recipientHash) = claim.recipient.getWorkchainAndHash();
  assert (workchain == BASECHAIN) throw RollupErrors.WrongRecipient;
  return exitDigest(storage.chainId, state.stateRoot, claim.l2Account, claim.amount, recipientHash);
}

/// После успешной проверки пруфа: заявка в нуллификатор счёта. Выплата — когда он
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

/// Возврат депозита, не попавшего в батч до заморозки. Квитанция удаляется в той же
/// транзакции, поэтому нуллификатор не нужен.
fun handleCancelDeposit(msg: CancelDeposit) {
  var storage = RollupStorage.load();
  var state = storage.state.load();
  assert (state.frozen) throw RollupErrors.RollupNotFrozen;
  // Обработанные депозиты уже зачислены на L2: их забирают выходом по пруфу, а не возвратом.
  assert (msg.depositIndex > state.queue.load().processedCount) throw RollupErrors.DepositAlreadyProcessed;
  val receipt = state.depositReceipts.deleteAndGetDeleted(msg.depositIndex);
  assert (receipt.isFound) throw RollupErrors.NoSuchDeposit;
  val deposit = receipt.loadValue();
  // Нет денег — исключение: квитанция остаётся, возврат можно повторить позже. Монеты
  // этого сообщения остаются на контракте и в возврате участвуют.
  assert (canPay(deposit.amount, 0)) throw RollupErrors.InsufficientFunds;
  storage.state = state.toCell();
  storage.save();
  sendPayout(deposit.depositor, deposit.amount);
}

/// Уборка: квитанции обработанных депозитов больше не нужны. Удаляет не больше count
/// самых старых, чтобы уложиться в газ одной транзакции.
fun handlePruneDepositReceipts(msg: PruneDepositReceipts) {
  var storage = RollupStorage.load();
  var state = storage.state.load();
  val processed = state.queue.load().processedCount;
  var left = msg.count;
  var entry = state.depositReceipts.findFirst();
  while ((left > 0) && entry.isFound && (entry.getKey() <= processed)) {
    state.depositReceipts.delete(entry.getKey());
    left -= 1;
    entry = state.depositReceipts.findFirst();
  }
  storage.state = state.toCell();
  storage.save();
}

// ---------------------------------------------------------------------------
// Просмотр состояния (get-методы точек входа)
// ---------------------------------------------------------------------------

/// (заморожен ли, когда встал самый старый необработанный депозит или 0, срок в секундах)
fun escapeStateView(): (bool, int, int) {
  val storage = RollupStorage.load();
  val state = storage.state.load();
  return (state.frozen, oldestPendingDepositAt(state, state.queue.load()), storage.escapeTimeout);
}

/// Публичный вход, который контракт потребует от пруфа выхода с такой заявкой.
fun expectedExitInputView(l2Account: int, amount: int, recipientHash: int): int {
  val storage = RollupStorage.load();
  return exitDigest(storage.chainId, storage.state.load().stateRoot, l2Account, amount, recipientHash);
}

/// Хеш ключа программы выхода; 0, пока основной ключ не зафиксирован.
fun exitKeyHashView(): int {
  val keys = RollupStorage.load().keys.load();
  if (keys.vkData == null) {
    return 0;
  }
  return exitVkData(keys).hash();
}

/// (вноситель, сумма) по номеру депозита; сумма 0, если квитанции нет.
fun depositReceiptView(depositIndex: int): (address?, int) {
  val receipt = RollupStorage.load().state.load().depositReceipts.get(depositIndex);
  if (!receipt.isFound) {
    return (null, 0);
  }
  val deposit = receipt.loadValue();
  return (deposit.depositor, deposit.amount);
}
