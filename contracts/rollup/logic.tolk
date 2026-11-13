// Логика rollup-контракта (минимальная версия): батчи, депозит TON, вывод с
// нуллификатором, загрузка ключа. Проверка пруфа сюда не входит — её делает файл
// точки входа (настоящая в rollup.tolk, заглушка для тестов в rollup_mock.tolk).
import "storage"
import "messages"
import "nullifier_types"
import "../bn254/verifier_api"
import "../bn254/hinted"
import "@stdlib/gas-payments"

enum RollupErrors {
  WrongProof = 7300,
  UnknownMessage = 7301,
  NotOwner = 7302,
  NotSequencer = 7303,
  KeyAlreadyFinalized = 7304,
  KeyNotFinalized = 7305,
  DepositTooSmall = 7306,
  NotEnoughValue = 7307,
  WrongMerkleProof = 7308,
  NotNullifier = 7309,
  WrongRecipient = 7310,
  DataForClosedBatch = 7311,
  RollupFrozen = 7312,
  RollupNotFrozen = 7313,
  EscapeNotDue = 7314,
  NothingToExit = 7315,
  DepositAlreadyProcessed = 7316,
  NoSuchDeposit = 7317,
  ExitKeyNotSet = 7318,
  MalformedForcedTransaction = 7319,
  InsufficientFunds = 7320,
  /// Параметры развёртывания недопустимы (срок заморозки меньше MIN_ESCAPE_TIMEOUT).
  BadDeployment = 7321,
  DataTooFarAhead = 7322,
  NothingOwed = 7323,
  /// Точка ключа не лежит на кривой.
  BadKeyPoint = 7324,
  /// Фиксированная комиссия перестала покрывать газ шага при нынешних ценах сети.
  FeeBelowGasCost = 7325,
}

/// Удерживается с каждого депозита: покрывает газ транзакции и плату за хранение.
/// Комиссия задана в монетах намеренно: от неё зависит сумма, зачисляемая на L2, а та
/// должна быть предсказуемой для вносителя. Но газ шага оплачивается из тех же монет, и если
/// цена газа в сети вырастет настолько, что комиссия перестанет его покрывать, каждый депозит
/// уменьшал бы покрытие обязательств контракта. Поэтому при таких ценах депозит отклоняется
/// (FeeBelowGasCost), а не принимается в убыток — см. assertFeeCoversGas. Принудительные
/// транзакции при этом остаются доступны (forceTransactionFee): очередь и срок заморозки от
/// цены газа не зависят.
const DEPOSIT_FEE: coins = ton("0.01")
const MIN_DEPOSIT: coins = ton("0.05")
/// Газ шага депозита, с запасом: измеренный расход — около 7 700 gas и растёт с глубиной
/// словаря квитанций (bench/rollup-submit-batch.json).
const DEPOSIT_STEP_GAS: int = 25000
/// Газ постановки принудительной транзакции в очередь, с запасом.
const FORCE_TRANSACTION_STEP_GAS: int = 15000
/// Плата за принудительную транзакцию: её исполнение и доказательство оплачивает
/// секвенсор, а в очередь её может поставить кто угодно. Не возвращается.
const FORCE_TRANSACTION_FEE: coins = ton("0.05")
/// Метка принудительной транзакции в накопительном хеше очереди: стоит на месте
/// получателя депозита (160 бит), поэтому спутать их нельзя. Совпадает с
/// FORCED_TRANSACTION_MARKER в zkvm/lib.
const FORCED_TRANSACTION_MARKER: int = 1 << 255
/// Принудительная транзакция — одна ячейка без ссылок: хеш такой ячейки программа zkVM
/// может посчитать из байтов для любого содержимого.
const MAX_FORCED_TRANSACTION_BITS: int = 1016
/// Газ шага Withdraw (проверка Merkle-доказательства и заявка в нуллификатор), с запасом.
const WITHDRAW_STEP_GAS: int = 40000
/// Верхняя оценка размера заявки в нуллификатор вместе с его кодом и данными (StateInit).
const CLAIM_MESSAGE_BITS: int = 8192
const CLAIM_MESSAGE_CELLS: int = 16
/// На сколько батчей вперёд секвенсор может публиковать данные. Без предела словарь
/// pendingData можно было бы растить записями для батчей, которые никогда не наступят.
const MAX_DATA_BATCHES_AHEAD: int = 4
/// Наименьший допустимый срок заморозки, секунд. С меньшим сроком ключи не фиксируются,
/// а без ключей rollup не принимает депозиты: тестовый срок в минуты не попадёт в
/// развёртывание, которым кто-то пользуется.
const MIN_ESCAPE_TIMEOUT: int = 3600
/// Глубина дерева выводов: 2^32 листьев.
const WITHDRAWAL_TREE_DEPTH: int = 32
/// Скалярное поле BN254 ~254 бита: дайджест публичных значений обрезается до 253 бит
/// (так же делает верификатор SP1).
const DIGEST_MASK_253: int = (1 << 253) - 1

@pure fun sha256OfBuilder(b: builder, count: int): uint256 asm "HASHEXT_SHA256"
@pure fun sha256OfTwo(first: builder, second: builder, count: int): uint256 asm "HASHEXT_SHA256"
@pure fun sha256OfThree(first: builder, second: builder, third: builder, count: int): uint256 asm "HASHEXT_SHA256"

/// Первый публичный вход пруфа: sha256 от восьми 32-байтовых значений, обрезанный до
/// 253 бит. Порядок значений — часть протокола; программа для zkVM обязана
/// коммитить их так же:
///   chainId ‖ prevStateRoot ‖ newStateRoot ‖ batchHash
///           ‖ prevWithdrawalsRoot ‖ withdrawalsRoot ‖ prevDepositHash ‖ newDepositHash
///
/// Из сообщения берутся только два значения: новый корень состояния и новый корень
/// выводов. Всё остальное — из хранилища: chainId, прежний корень состояния, хеш данных
/// батча, опубликованных в TON (см. takeBatchData), обе отметки очереди L1 и ПРЕЖНИЙ
/// корень выводов. Последнее принципиально: список прежних выводов — приватный вход
/// программы, и без этой привязки секвенсор мог бы приписать в дерево лист в свою пользу.
fun batchDigest(chainId: int, state: RollupState, queue: DepositQueue, roots: BatchRoots, batchHash: int): int {
  // Четыре 256-битных значения не помещаются в одну ячейку, поэтому строителей три.
  val first = beginCell()
    .storeUint(chainId, 256)
    .storeUint(state.stateRoot, 256)
    .storeUint(roots.newStateRoot, 256);
  val second = beginCell()
    .storeUint(batchHash, 256)
    .storeUint(state.withdrawalsRoot, 256)
    .storeUint(roots.withdrawalsRoot, 256);
  val third = beginCell().storeUint(queue.processedHash, 256).storeUint(queue.targetHash, 256);
  return sha256OfThree(first, second, third, 3) & DIGEST_MASK_253;
}

/// Шаг накопительного хеша данных батча: sha256(предыдущий ‖ хеш ячейки с порцией).
@inline
fun dataHashStep(previous: int, dataCellHash: int): int {
  return sha256OfBuilder(beginCell().storeUint(previous, 256).storeUint(dataCellHash, 256), 1);
}

/// Хеш данных, опубликованных для батча с этим номером; 0, если данных не было.
@inline
fun batchDataHashOf(pendingData: map<uint64, uint256>, batchIndex: int): int {
  val entry = pendingData.get(batchIndex);
  return entry.isFound ? entry.loadValue() : 0;
}

/// Забирает хеш данных следующего батча и удаляет запись: после принятия батча она не нужна.
fun takeBatchData(mutate state: RollupState): int {
  val entry = state.pendingData.deleteAndGetDeleted(state.batchIndex + 1);
  return entry.isFound ? entry.loadValue() : 0;
}

/// Порция данных батча. Публиковать может только секвенсор: чужая порция изменила бы
/// хеш, под который он строит пруф.
fun handlePublishData(sender: address, msg: PublishData) {
  var storage = RollupStorage.load();
  assert (sender == storage.sequencer) throw RollupErrors.NotSequencer;
  var state = storage.state.load();
  assert (!state.frozen) throw RollupErrors.RollupFrozen;
  // Данные можно публиковать и для батчей вперёд, пока строится пруф текущего,
  // но не для уже принятых и не дальше чем на MAX_DATA_BATCHES_AHEAD.
  assert (msg.batchIndex > state.batchIndex) throw RollupErrors.DataForClosedBatch;
  assert (msg.batchIndex <= state.batchIndex + MAX_DATA_BATCHES_AHEAD) throw RollupErrors.DataTooFarAhead;
  val previous = batchDataHashOf(state.pendingData, msg.batchIndex);
  state.pendingData.set(msg.batchIndex, dataHashStep(previous, msg.data.hash()));
  storage.state = state.toCell();
  storage.save();
}

/// Сброс данных, опубликованных для ещё не принятого батча: единственный способ исправить
/// накопительный хеш после ошибки публикации.
fun handleDiscardBatchData(sender: address, msg: DiscardBatchData) {
  var storage = RollupStorage.load();
  assert (sender == storage.sequencer) throw RollupErrors.NotSequencer;
  var state = storage.state.load();
  state.pendingData.delete(msg.batchIndex);
  storage.state = state.toCell();
  storage.save();
}

/// Всё, что нужно для проверки пруфа батча и его применения.
struct PreparedBatch {
  storage: RollupStorage
  /// Состояние, из которого уже забран хеш данных батча.
  state: RollupState
  queue: DepositQueue
  roots: BatchRoots
  /// Первый публичный вход, который обязан подтвердить пруф.
  digest: int
  vkData: cell
}

/// Проверки батча до пруфа — общие для настоящего контракта и тестового двойника.
fun prepareSubmitBatch(sender: address, msg: SubmitBatch): PreparedBatch {
  val storage = RollupStorage.load();
  assert (sender == storage.sequencer) throw RollupErrors.NotSequencer;
  val keys = storage.keys.load();
  assert (keys.vkData != null) throw RollupErrors.KeyNotFinalized;
  var state = storage.state.load();
  assert (!state.frozen) throw RollupErrors.RollupFrozen;
  val queue = state.queue.load();
  val roots = msg.roots.load();
  // Хеш данных батча контракт берёт из своего хранилища: пруф для данных, которые не
  // были опубликованы в TON, не сойдётся.
  val batchHash = takeBatchData(mutate state);
  return PreparedBatch {
    storage: storage,
    state: state,
    queue: queue,
    roots: roots,
    digest: batchDigest(storage.chainId, state, queue, roots, batchHash),
    vkData: keys.vkData!,
  };
}

/// Применяет батч, пруф которого уже проверен.
fun applyBatch(mutate storage: RollupStorage, state: RollupState, queue: DepositQueue, roots: BatchRoots) {
  val nextQueue = DepositQueue {
    headCount: queue.headCount,
    headHash: queue.headHash,
    // Следующий батч обязан обработать всё, что стоит в очереди сейчас.
    targetCount: queue.headCount,
    targetHash: queue.headHash,
    processedCount: queue.targetCount,
    processedHash: queue.targetHash,
  };
  var next = state;
  next.stateRoot = roots.newStateRoot;
  next.withdrawalsRoot = roots.withdrawalsRoot;
  next.batchIndex = state.batchIndex + 1;
  next.queue = nextQueue.toCell();
  // Депозиты за прежней целью стали обязательными для следующего батча; за новой целью
  // пока никого нет.
  next.queuedAfterProcessedAt = state.queuedAfterTargetAt;
  next.queuedAfterTargetAt = 0;
  storage.state = next.toCell();
  storage.save();
}

/// Ставит элемент в очередь L1→L2 и возвращает его номер (с единицы). Элемент входит в
/// накопительный хеш как sha256(прежний ‖ first ‖ second).
fun pushQueueItem(mutate state: RollupState, first: int, second: int): int {
  var queue = state.queue.load();
  if (queue.headCount == queue.targetCount) {
    // Первый элемент за отметкой target: с него считается возраст для аварийного выхода.
    state.queuedAfterTargetAt = blockchain.now();
  }
  queue.headHash = sha256OfBuilder(
    beginCell().storeUint(queue.headHash, 256).storeUint(first, 256).storeUint(second, 256),
    1
  );
  queue.headCount += 1;
  state.queue = queue.toCell();
  return queue.headCount;
}

/// Фиксированная комиссия обязана покрывать газ шага при текущих ценах сети: иначе шаг
/// оплачивался бы из денег пользователей.
@inline
fun assertFeeCoversGas(fee: coins, stepGas: int) {
  assert (fee >= calculateGasFee(BASECHAIN, stepGas)) throw RollupErrors.FeeBelowGasCost;
}

/// Плата за принудительную транзакцию: FORCE_TRANSACTION_FEE, но не меньше стоимости газа
/// шага при текущих ценах сети. В отличие от депозита, здесь нельзя отказывать при дорогом
/// газе: принудительная транзакция — единственный способ запустить срок заморозки, когда
/// очередь пуста, и её запрет запер бы балансы L2 до снижения цен. На суммы L2 плата не
/// влияет, поэтому она просто растёт вместе с ценой газа.
@inline
fun forceTransactionFee(): coins {
  return max(FORCE_TRANSACTION_FEE, calculateGasFee(BASECHAIN, FORCE_TRANSACTION_STEP_GAS));
}

fun handleDeposit(sender: address, valueCoins: coins, msg: DepositTon) {
  var storage = RollupStorage.load();
  val amount = valueCoins - DEPOSIT_FEE;
  assert (amount >= MIN_DEPOSIT) throw RollupErrors.DepositTooSmall;
  assertFeeCoversGas(DEPOSIT_FEE, DEPOSIT_STEP_GAS);

  // Пока ключи не зафиксированы, вносить нельзя: иначе владелец мог бы дождаться депозитов
  // и зафиксировать ключ другой программы. Исключение вернёт монеты отправителю.
  assert (storage.keys.load().vkData != null) throw RollupErrors.KeyNotFinalized;
  var state = storage.state.load();
  // В замороженный rollup вносить тоже нельзя.
  assert (!state.frozen) throw RollupErrors.RollupFrozen;
  val index = pushQueueItem(mutate state, msg.l2Recipient, amount);
  // Квитанция: если rollup заморозят раньше, чем депозит попадёт в батч, его вернут вносителю.
  state.depositReceipts.set(index, DepositReceipt { depositor: sender, amount: amount });
  // Попутная уборка: квитанция самого старого уже обработанного депозита больше не нужна.
  // Так словарь не растёт быстрее очереди, и забить им хранилище контракта нельзя.
  val oldest = state.depositReceipts.findFirst();
  if (oldest.isFound && (oldest.getKey() <= state.queue.load().processedCount)) {
    state.depositReceipts.delete(oldest.getKey());
  }
  storage.state = state.toCell();
  storage.save();
}

fun handleForceTransaction(valueCoins: coins, msg: ForceTransaction) {
  assert (valueCoins >= forceTransactionFee()) throw RollupErrors.NotEnoughValue;
  var storage = RollupStorage.load();
  assert (storage.keys.load().vkData != null) throw RollupErrors.KeyNotFinalized;
  var state = storage.state.load();
  assert (!state.frozen) throw RollupErrors.RollupFrozen;
  // Содержимое не разбирается, но форма проверяется: иначе в очередь можно было бы
  // поставить дерево ячеек, хеш которого программа zkVM не сможет воспроизвести, и
  // остановить rollup.
  val body = msg.l2Transaction.beginParse();
  val bits = body.remainingBitsCount();
  assert ((body.remainingRefsCount() == 0) && (bits <= MAX_FORCED_TRANSACTION_BITS) && (bits % 8 == 0))
    throw RollupErrors.MalformedForcedTransaction;
  // В очередь идёт хеш ячейки, собранной здесь из этих же битов, а НЕ хеш присланной
  // ячейки. Присланная может быть экзотической (ссылка на библиотеку): TVM при чтении
  // подставит содержимое библиотеки, проверка формы пройдёт, а хеш самой ссылки программа
  // zkVM из байтов не воспроизведёт — и rollup встал бы навсегда.
  pushQueueItem(mutate state, FORCED_TRANSACTION_MARKER, beginCell().storeSlice(body).endCell().hash());
  storage.state = state.toCell();
  storage.save();
}

/// Запас баланса, который выплата не должна трогать: плата за хранение.
const PAYOUT_RESERVE: coins = ton("0.05")

/// Сколько сверх суммы выплаты должно быть на балансе: запас на хранение, газ шага
/// выплаты и пересылка сообщения получателю.
@inline
fun payoutOverhead(): coins {
  return PAYOUT_RESERVE
    + calculateGasFee(BASECHAIN, PAYOUT_STEP_GAS)
    + calculateForwardFee(BASECHAIN, CONFIRMATION_BITS, CONFIRMATION_CELLS);
}

/// Хватит ли баланса выплатить сумму прямо сейчас. `passingThrough` — монеты входящего
/// сообщения, которые уйдут дальше по цепочке и в выплате не участвуют.
@inline
fun canPay(amount: coins, passingThrough: coins): bool {
  return contract.getOriginalBalance() - passingThrough >= amount + payoutOverhead();
}

/// Ранний отказ: не начинать цепочку вывода, если денег на выплату нет уже сейчас.
/// Гарантией выплаты это не является — между этой проверкой и выплатой два сообщения, и
/// баланс за это время может уменьшиться. Гарантию даёт handleNullifierClaimed: он либо
/// платит, либо записывает долг.
@inline
fun assertCanPay(amount: coins, passingThrough: coins) {
  assert (canPay(amount, passingThrough)) throw RollupErrors.InsufficientFunds;
}

/// Минимум монет на цепочку вывода: шаг Withdraw, заявка в нуллификатор с его
/// развёртыванием и всё, что нужно самому нуллификатору (nullifierMinValue).
@inline
fun withdrawMinValue(): coins {
  return calculateGasFee(BASECHAIN, WITHDRAW_STEP_GAS)
    + calculateForwardFee(BASECHAIN, CLAIM_MESSAGE_BITS, CLAIM_MESSAGE_CELLS)
    + nullifierMinValue();
}

/// Выплата получателю. Без bounce: если получатель не развёрнут, монеты остаются у него.
@inline
fun sendPayout(recipient: address, amount: coins) {
  val payout = createMessage({
    bounce: BounceMode.NoBounce,
    value: amount,
    dest: recipient,
  });
  payout.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

/// Адрес нуллификатора: определяется кодом, адресом rollup'а и ключом — номером листа
/// дерева выводов либо ключом аварийного выхода (exitNullifierKey в escape.tolk).
@inline
fun nullifierDeployment(nullifierCode: cell, key: int): AutoDeployAddress {
  return AutoDeployAddress {
    stateInit: ContractState {
      code: nullifierCode,
      data: NullifierStorage { rollup: contract.getAddress(), key: key, claimed: false }.toCell(),
    },
  };
}

/// Лист дерева выводов: sha256(номер ‖ хеш адреса получателя ‖ сумма), всё по 32 байта.
/// Узел: sha256(левый ‖ правый). Получатель — только в basechain.
fun withdrawalRoot(leafIndex: int, recipientHash: int, amount: coins, merkleProof: cell): int {
  var node = sha256OfBuilder(
    beginCell().storeUint(leafIndex, 256).storeUint(recipientHash, 256).storeUint(amount, 256),
    1
  );
  var siblings = merkleProof.beginParse();
  var position = leafIndex;
  repeat (WITHDRAWAL_TREE_DEPTH) {
    if (siblings.remainingBitsCount() == 0) {
      siblings = siblings.loadRef().beginParse();
    }
    val sibling = siblings.loadUint(256);
    val pair = (position & 1) == 0
      ? beginCell().storeUint(node, 256).storeUint(sibling, 256)
      : beginCell().storeUint(sibling, 256).storeUint(node, 256);
    node = sha256OfBuilder(pair, 1);
    position = position >> 1;
  }
  assert ((siblings.remainingBitsCount() == 0) && (siblings.remainingRefsCount() == 0)) throw RollupErrors.WrongMerkleProof;
  return node;
}

fun handleWithdraw(valueCoins: coins, msg: Withdraw) {
  assert (valueCoins >= withdrawMinValue()) throw RollupErrors.NotEnoughValue;
  val storage = RollupStorage.load();
  val state = storage.state.load();
  val (workchain, recipientHash) = msg.recipient.getWorkchainAndHash();
  assert (workchain == BASECHAIN) throw RollupErrors.WrongRecipient;
  assert (withdrawalRoot(msg.leafIndex, recipientHash, msg.amount, msg.merkleProof) == state.withdrawalsRoot)
    throw RollupErrors.WrongMerkleProof;
  assertCanPay(msg.amount, valueCoins);

  // Двойной вывод ловит нуллификатор: при повторе он бросит исключение, и это
  // сообщение вернётся bounce'ом. Здесь ничего не выплачивается и не записывается.
  val claim = createMessage({
    bounce: BounceMode.Only256BitsOfBody,
    value: 0,
    dest: nullifierDeployment(storage.nullifierCode, msg.leafIndex),
    body: NullifierClaim { queryId: msg.queryId, recipient: msg.recipient, amount: msg.amount },
  });
  claim.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

/// Подтверждение от нуллификатора: вывод или аварийный выход помечен впервые. Пометку
/// снять нельзя, поэтому этот шаг не имеет права потерять заявку: он либо платит, либо,
/// если баланса сейчас не хватает, записывает долг (PayOwed выплатит его позже). Отказов
/// по ходу нет, а на газ шага нуллификатор заранее проверил приложенные монеты.
///
/// Нехватка возможна, только если баланс контракта не покрывает обязательства (например,
/// его съела плата за хранение) либо если две заявки одновременно претендуют на последние
/// монеты. Раньше такая заявка сгорала: выплата не проходила, а пометка оставалась.
fun handleNullifierClaimed(sender: address, msg: NullifierClaimed) {
  var storage = RollupStorage.load();
  assert (nullifierDeployment(storage.nullifierCode, msg.key).addressMatches(sender)) throw RollupErrors.NotNullifier;

  // Остаток монет подтверждения остаётся на контракте, поэтому входит в баланс целиком.
  if (canPay(msg.amount, 0)) {
    sendPayout(msg.recipient, msg.amount);
    return;
  }
  var state = storage.state.load();
  state.owed.set(msg.key, OwedPayout { recipient: msg.recipient, amount: msg.amount });
  storage.state = state.toCell();
  storage.save();
}

/// Выплата записанного долга. Запись удаляется в той же транзакции; если денег всё ещё
/// нет, исключение оставляет её на месте.
fun handlePayOwed(msg: PayOwed) {
  var storage = RollupStorage.load();
  var state = storage.state.load();
  val entry = state.owed.deleteAndGetDeleted(msg.key);
  assert (entry.isFound) throw RollupErrors.NothingOwed;
  val debt = entry.loadValue();
  // Монеты этого сообщения остаются на контракте и в выплате участвуют.
  assert (canPay(debt.amount, 0)) throw RollupErrors.InsufficientFunds;
  storage.state = state.toCell();
  storage.save();
  sendPayout(debt.recipient, debt.amount);
}

fun handleUploadKeyPart(sender: address, msg: UploadKeyPart) {
  var storage = RollupStorage.load();
  assert (sender == storage.owner) throw RollupErrors.NotOwner;
  var keys = storage.keys.load();
  assert (keys.vkData == null) throw RollupErrors.KeyAlreadyFinalized;
  assert (isKeySlotValid(msg.slot)) throw KEY_ERROR_BAD_PART;
  keys.keyParts.set(msg.slot, msg.part);
  storage.keys = keys.toCell();
  storage.save();
}

fun handleFinalizeKey(sender: address, msg: FinalizeKey) {
  var storage = RollupStorage.load();
  assert (sender == storage.owner) throw RollupErrors.NotOwner;
  var keys = storage.keys.load();
  assert (keys.vkData == null) throw RollupErrors.KeyAlreadyFinalized;
  assert (!storage.state.load().frozen) throw RollupErrors.RollupFrozen;
  // Rollup без ключа выхода зафиксировать нельзя: иначе аварийный режим оставил бы
  // балансы L2 запертыми.
  assert ((keys.exitIc0x != 0) || (keys.exitIc0y != 0)) throw RollupErrors.ExitKeyNotSet;
  // Слишком короткий срок заморозки — признак тестовой конфигурации: с ним rollup не
  // начинает работу (без ключей депозиты не принимаются).
  assert (storage.escapeTimeout >= MIN_ESCAPE_TIMEOUT) throw RollupErrors.BadDeployment;
  // У ключа ровно один переменный вход: остальные (в том числе нонс SP1, равный нулю)
  // свёрнуты в IC0. Второй таблицы быть не должно — проверить её было бы нечем.
  assert (msg.table1Parts == 0) throw KEY_ERROR_BAD_PART;
  assert (g1IsValid(msg.ic0x, msg.ic0y)) throw RollupErrors.BadKeyPoint;
  keys.vkData = assembleKey(keys.keyParts, msg);
  keys.keyParts = createEmptyMap();
  storage.keys = keys.toCell();
  storage.save();
}

/// (корень состояния, корень выводов, номер батча)
fun rollupStateView(): (int, int, int) {
  val state = RollupStorage.load().state.load();
  return (state.stateRoot, state.withdrawalsRoot, state.batchIndex);
}

/// Параметры развёртывания: (владелец, секвенсор, chainId, срок заморозки, хеш кода
/// нуллификатора). Контракт не может проверить их сам — их сверяет тот, кто собирается
/// доверить rollup'у деньги (scripts/verifyRollupDeployment.ts, ARCHITECTURE.md).
fun deploymentView(): (address, address, int, int, int) {
  val storage = RollupStorage.load();
  return (storage.owner, storage.sequencer, storage.chainId, storage.escapeTimeout, storage.nullifierCode.hash());
}

/// Запасы газа шагов очереди L1 и плата за принудительную транзакцию при текущих ценах:
/// (газ шага депозита, газ постановки принудительной транзакции, плата за неё).
fun queueBudgetsView(): (int, int, int) {
  return (DEPOSIT_STEP_GAS, FORCE_TRANSACTION_STEP_GAS, forceTransactionFee());
}

/// Запасы газа цепочки вывода и производные от них суммы (get-метод payoutBudgets).
fun payoutBudgetsView(): (int, int, int, int, int) {
  return (
    WITHDRAW_STEP_GAS,
    NULLIFIER_CLAIM_GAS,
    PAYOUT_STEP_GAS,
    calculateGasFee(BASECHAIN, PAYOUT_STEP_GAS),
    payoutOverhead()
  );
}

/// (получатель, сумма) долга по ключу нуллификатора; сумма 0, если долга нет.
fun owedPayoutView(key: int): (address?, int) {
  val entry = RollupStorage.load().state.load().owed.get(key);
  if (!entry.isFound) {
    return (null, 0);
  }
  val debt = entry.loadValue();
  return (debt.recipient, debt.amount);
}

/// Очередь депозитов: (поставлено, хеш), (цель, хеш), (обработано, хеш)
fun depositQueueView(): DepositQueue {
  return RollupStorage.load().state.load().queue.load();
}

/// Первый публичный вход, который контракт потребует от следующего батча с такими корнями
/// (при уже опубликованных для него данных).
fun expectedPublicInputView(newStateRoot: int, withdrawalsRoot: int): int {
  val storage = RollupStorage.load();
  val state = storage.state.load();
  return batchDigest(
    storage.chainId,
    state,
    state.queue.load(),
    BatchRoots { newStateRoot: newStateRoot, withdrawalsRoot: withdrawalsRoot },
    batchDataHashOf(state.pendingData, state.batchIndex + 1)
  );
}
