// Логика rollup-контракта (минимальная версия): батчи, депозит TON, вывод с
// нуллификатором, загрузка ключа. Проверка пруфа сюда не входит — её делает файл
// точки входа (настоящая в rollup.tolk, заглушка для тестов в rollup_mock.tolk).
import "storage"
import "messages"
import "nullifier_types"
import "../bn254/verifier_api"

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
}

/// Удерживается с каждого депозита: покрывает газ транзакции и плату за хранение.
const DEPOSIT_FEE: coins = ton("0.01")
const MIN_DEPOSIT: coins = ton("0.05")
/// Минимум монет на цепочку вывода: развёртывание нуллификатора и два сообщения.
const WITHDRAW_MIN_VALUE: coins = ton("0.1")
/// Глубина дерева выводов: 2^32 листьев.
const WITHDRAWAL_TREE_DEPTH: int = 32
/// Скалярное поле BN254 ~254 бита: дайджест публичных значений обрезается до 253 бит
/// (так же делает верификатор SP1).
const DIGEST_MASK_253: int = (1 << 253) - 1

@pure fun sha256OfBuilder(b: builder, count: int): uint256 asm "HASHEXT_SHA256"
@pure fun sha256OfThree(first: builder, second: builder, third: builder, count: int): uint256 asm "HASHEXT_SHA256"

/// Первый публичный вход пруфа: sha256 от семи 32-байтовых значений, обрезанный до
/// 253 бит. Порядок значений — часть протокола; программа для zkVM обязана
/// коммитить их так же:
///   chainId ‖ prevStateRoot ‖ newStateRoot ‖ batchHash ‖ withdrawalsRoot ‖ prevDepositHash ‖ newDepositHash
///
/// chainId — идентификатор этого rollup'а из хранилища; batchHash — накопительный хеш
/// данных батча, опубликованных в TON (см. takeBatchData). Из сообщения берутся только
/// два значения: новый корень состояния и корень выводов.
fun batchDigest(chainId: int, state: RollupState, queue: DepositQueue, roots: BatchRoots, batchHash: int): int {
  // Четыре 256-битных значения не помещаются в одну ячейку, поэтому строителей три.
  val first = beginCell()
    .storeUint(chainId, 256)
    .storeUint(state.stateRoot, 256)
    .storeUint(roots.newStateRoot, 256);
  val second = beginCell()
    .storeUint(batchHash, 256)
    .storeUint(roots.withdrawalsRoot, 256)
    .storeUint(queue.processedHash, 256);
  val third = beginCell().storeUint(queue.targetHash, 256);
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
  // Данные можно публиковать и для батчей вперёд, пока строится пруф текущего,
  // но не для уже принятых.
  assert (msg.batchIndex > state.batchIndex) throw RollupErrors.DataForClosedBatch;
  val previous = batchDataHashOf(state.pendingData, msg.batchIndex);
  state.pendingData.set(msg.batchIndex, dataHashStep(previous, msg.data.hash()));
  storage.state = state.toCell();
  storage.save();
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
  storage.state = RollupState {
    stateRoot: roots.newStateRoot,
    withdrawalsRoot: roots.withdrawalsRoot,
    batchIndex: state.batchIndex + 1,
    queue: nextQueue.toCell(),
    pendingData: state.pendingData,
  }.toCell();
  storage.save();
}

fun handleDeposit(valueCoins: coins, msg: DepositTon) {
  var storage = RollupStorage.load();
  val amount = valueCoins - DEPOSIT_FEE;
  assert (amount >= MIN_DEPOSIT) throw RollupErrors.DepositTooSmall;

  val state = storage.state.load();
  var queue = state.queue.load();
  queue.headHash = sha256OfBuilder(
    beginCell().storeUint(queue.headHash, 256).storeUint(msg.l2Recipient, 256).storeUint(amount, 256),
    1
  );
  queue.headCount += 1;
  storage.state = RollupState {
    stateRoot: state.stateRoot,
    withdrawalsRoot: state.withdrawalsRoot,
    batchIndex: state.batchIndex,
    queue: queue.toCell(),
    pendingData: state.pendingData,
  }.toCell();
  storage.save();
}

/// Адрес нуллификатора для листа: определяется кодом, адресом rollup'а и номером.
@inline
fun nullifierDeployment(nullifierCode: cell, leafIndex: int): AutoDeployAddress {
  return AutoDeployAddress {
    stateInit: ContractState {
      code: nullifierCode,
      data: NullifierStorage { rollup: contract.getAddress(), leafIndex: leafIndex, claimed: false }.toCell(),
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
  assert (valueCoins >= WITHDRAW_MIN_VALUE) throw RollupErrors.NotEnoughValue;
  val storage = RollupStorage.load();
  val state = storage.state.load();
  val (workchain, recipientHash) = msg.recipient.getWorkchainAndHash();
  assert (workchain == BASECHAIN) throw RollupErrors.WrongRecipient;
  assert (withdrawalRoot(msg.leafIndex, recipientHash, msg.amount, msg.merkleProof) == state.withdrawalsRoot)
    throw RollupErrors.WrongMerkleProof;

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

/// Подтверждение от нуллификатора: вывод помечен впервые. Здесь только выплата —
/// все проверки сделаны на шаге Withdraw, отказ на этом шаге оставил бы вывод
/// помеченным, но не выплаченным.
fun handleNullifierClaimed(sender: address, msg: NullifierClaimed) {
  val storage = RollupStorage.load();
  assert (nullifierDeployment(storage.nullifierCode, msg.leafIndex).addressMatches(sender)) throw RollupErrors.NotNullifier;

  // Без bounce: если получатель не развёрнут, монеты всё равно остаются у него.
  val payout = createMessage({
    bounce: BounceMode.NoBounce,
    value: msg.amount,
    dest: msg.recipient,
  });
  payout.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

fun handleUploadKeyPart(sender: address, msg: UploadKeyPart) {
  var storage = RollupStorage.load();
  assert (sender == storage.owner) throw RollupErrors.NotOwner;
  assert (storage.vkData == null) throw RollupErrors.KeyAlreadyFinalized;
  assert (isKeySlotValid(msg.slot)) throw KEY_ERROR_BAD_PART;
  storage.keyParts.set(msg.slot, msg.part);
  storage.save();
}

fun handleFinalizeKey(sender: address, msg: FinalizeKey) {
  var storage = RollupStorage.load();
  assert (sender == storage.owner) throw RollupErrors.NotOwner;
  assert (storage.vkData == null) throw RollupErrors.KeyAlreadyFinalized;
  storage.vkData = assembleKey(storage.keyParts, msg);
  storage.keyParts = createEmptyMap();
  storage.save();
}

/// (корень состояния, корень выводов, номер батча)
fun rollupStateView(): (int, int, int) {
  val state = RollupStorage.load().state.load();
  return (state.stateRoot, state.withdrawalsRoot, state.batchIndex);
}

/// Очередь депозитов: (поставлено, хеш), (цель, хеш), (обработано, хеш)
fun depositQueueView(): DepositQueue {
  return RollupStorage.load().state.load().queue.load();
}
