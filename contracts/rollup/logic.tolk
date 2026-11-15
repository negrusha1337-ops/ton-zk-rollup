// Логика rollup-контракта, протокол версии 2 (PROTOCOL-V2.md): батчи, очередь L1 (депозит TON
// и принудительные транзакции EVM), вывод с нуллификатором, загрузка ключа. Проверка пруфа сюда не входит — её делает файл
// точки входа (настоящая в rollup.tolk, заглушка для тестов в rollup_mock.tolk).
import "storage"
import "messages"
import "nullifier_types"
import "bytes"
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
  /// Комиссия за место в очереди выше той, на которую согласился вноситель (maxFee).
  QueueFeeAboveLimit = 7326,
  /// Батч заявил отметку очереди вне отрезка [processed, head].
  QueueMarkOutOfRange = 7327,
  /// Батч заявил больше MAX_BATCH_QUEUE_ITEMS элементов очереди за раз.
  TooManyQueueItems = 7328,
  /// Время блока L2 позже времени L1.
  BlockFromFuture = 7329,
  /// Блок L2 старше maxBlockAge: батч негоден навсегда, блок пересобирается.
  BlockTooOld = 7330,
  /// В словаре очереди MAX_TRACKED_ITEMS неубранных записей: постановка откладывается, пока
  /// очередь не обработают.
  QueueStorageFull = 7331,
  /// Сумма депозита на L2 не меньше 2^64 нанотон.
  DepositTooLarge = 7332,
  /// Начальное состояние не каноническое: не тот генезис, ненулевые выводы, номер батча или
  /// непустая очередь. С таким состоянием ключ не фиксируется.
  BadGenesis = 7333,
  /// В словаре очереди нет записи, которая обязана там быть (нарушен инвариант хранилища).
  QueueEntryMissing = 7334,
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
/// Газ шага депозита, с запасом: запись в словарь очереди и уборка до двух прежних записей.
/// Измерено на словаре, заполненном до MAX_TRACKED_ITEMS, на самой глубокой вставке (новая
/// запись ложится на дно словаря глубиной в 13 уровней, две убираемые — тоже):
/// 32,7 тыс. gas (bench/rollup-queue-gas.json); на вставке у корня словаря — 24,9 тыс.
/// Тест сверяет измеренное с этим числом через get-метод queueBudgets.
///
/// Комиссия депозита при этом запасе покрывает газ шага, пока цена газа не выше нынешней в
/// 3,75 раза (0,01 TON против 40 000 gas по 66,67 нанотон); дальше депозиты отклоняются
/// (FeeBelowGasCost). До протокола v2 запас был 25 000 gas и порог — 6 раз.
const DEPOSIT_STEP_GAS: int = 40000
/// Газ постановки принудительной транзакции в очередь, с запасом. Измерено там же:
/// 36,3 тыс. gas на транзакции наибольшей длины (MAX_FORCED_TX_BYTES байт в
/// MAX_FORCED_TX_CELLS ячейках) — та же работа со словарём, что у депозита, плюс чтение и
/// проверка «змейки» и keccak-256. При прежнем пределе в 64 ячейки шаг стоил 83 тыс., запас
/// был 110 тыс.; отношение запаса к измеренному оставлено прежним, около 1,35.
const FORCE_TRANSACTION_STEP_GAS: int = 50000
/// Плата за место в очереди L1 удваивается на каждые столько необработанных элементов —
/// между отметками processed и head.
///
/// Зачем. Необработанный хвост секвенсор обязан разобрать раньше, чем самый старый элемент
/// провисит срок заморозки. Без роста платы хвост можно было бы раздуть дешёвыми депозитами
/// так, что его не успеть доказать, — то есть остановить rollup за копейки. Жёсткий предел
/// хвоста был бы хуже: заполнив его, можно вытеснять чужие принудительные транзакции, а это
/// цензура. Растущая плата никого не вытесняет, но делает раздувание экспоненциально дорогим:
/// n элементов стоят порядка базовой платы × ШАГ × 2^(n / ШАГ). (Предел MAX_TRACKED_ITEMS ниже
/// — про память контракта; платой он недостижим.)
const QUEUE_FEE_STEP: int = 64
/// Предел числа удвоений: дальше плата не растёт (и не переполняет coins).
const QUEUE_FEE_MAX_DOUBLINGS: int = 40
/// Плата за принудительную транзакцию: её исполнение и доказательство оплачивает
/// секвенсор, а в очередь её может поставить кто угодно. Не возвращается.
const FORCE_TRANSACTION_FEE: coins = ton("0.05")
/// Метка принудительной транзакции в накопительном хеше очереди: стоит на месте
/// получателя депозита (160 бит), поэтому спутать их нельзя. Часть протокола: то же значение
/// у программы zkVM и в wrappers/rollupMath.ts.
const FORCED_TRANSACTION_MARKER: int = 1 << 255
/// Предел длины принудительной транзакции, байт. Программа zkVM элемент длиннее пропускает,
/// не разбирая (FORCED_TX_MAX_BYTES в zkvm-evm/lib — то же число), но прочесть его байты для
/// хеша очереди она обязана: 32 элемента по 8 128 байт стоили пруверу 12,9 млн циклов на блок
/// (bench/evm-v2-cycles.json, блок 12) за ту же плату, что и короткие. Поэтому длинную
/// транзакцию не пускает в очередь уже контракт. Вывод через мост занимает около 150 байт.
/// То же значение — в wrappers/rollupMath.ts.
const MAX_FORCED_TX_BYTES: int = 256
/// Предел длины «змейки» принудительной транзакции, ячеек: MAX_FORCED_TX_BYTES байт помещаются
/// в три ячейки по 127. Ячейки вмещают больше (381 байт), поэтому предел в байтах проверяется
/// отдельно и точно. То же значение — в wrappers/rollupMath.ts.
const MAX_FORCED_TX_CELLS: int = 3
/// Сколько элементов очереди L1 батч может обработать за раз. Секвенсора нельзя заставить
/// взять в блок больше, и сам он больше взять не может: цена пруфа батча ограничена сверху.
/// То же число проверяет программа zkVM (MAX_BATCH_QUEUE_ITEMS в zkvm-evm/lib). Худший
/// измеренный отрезок из 32 элементов — 13,6 млн циклов zkVM на блок (все — включённые выводы
/// через мост; bench/evm-v2-cycles.json) против 7,8 млн у пустого блока. Измерены циклы, не
/// время пруфа: его покажут пруфы v2. Тесты берут значение get-методом queueLimits.
const MAX_BATCH_QUEUE_ITEMS: int = 32
/// Сколько записей об элементах очереди контракт держит в словаре. При заполнении постановка
/// в очередь отказывает (QueueStorageFull), пока обработанные записи не уберут. Рычагом
/// цензуры это не становится: мусор (обработанное) убирает сама постановка и кто угодно
/// сообщением PruneDepositReceipts, а необработанных элементов столько не набрать — плата за
/// место к этому времени удвоена QUEUE_FEE_MAX_DOUBLINGS раз.
const MAX_TRACKED_ITEMS: int = 8192
/// Сколько обработанных записей убирает каждая постановка в очередь. Две на одну новую:
/// словарь при работающем секвенсоре сокращается, а не только не растёт.
const QUEUE_PRUNE_PER_PUSH: int = 2
/// Сумма депозита на L2 обязана быть меньше этого числа нанотон: программа zkVM держит суммы
/// в 64 битах, и большую она не смогла бы зачислить — батч с таким элементом был бы недоказуем.
const DEPOSIT_AMOUNT_LIMIT: int = 1 << 64
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
///
/// ЗНАЧЕНИЕ НЕ ОКОНЧАТЕЛЬНОЕ и безопасным сроком не является. Нижняя граница должна
/// выводиться из пропускной способности прувера — сколько батчей по MAX_BATCH_QUEUE_ITEMS
/// элементов он успевает доказать за срок, — а время пруфа блока v2 ещё не измерено
/// (измерены только циклы). При сроке в час заморозку можно купить спамом очереди примерно
/// за 2 TON (REVIEW.md, 14-4); при сроке в 7 суток атака упирается в предел удвоений платы.
/// Решение — после замера прувера; до него срок развёртывания брать с большим запасом.
const MIN_ESCAPE_TIMEOUT: int = 3600
/// Наименьший допустимый maxBlockAge, секунд: с меньшим батч не успеть доказать и принять
/// (пруф блока строится минутами). Наибольший — escapeTimeout.
const MIN_MAX_BLOCK_AGE: int = 1800
/// Хеш заголовка блока-генезиса L2 — константа протокола: генезис закреплён целиком (счёт
/// моста, время, лимит газа, базовая комиссия) и от chainId не зависит. FinalizeKey сверяет с
/// ней начальное слово состояния.
/// Значение подтверждено цепочкой узла Reth протокола v2: с ним совпали хеш генезиса узла
/// (fixtures/evm_batches/reth/expected.json, поле genesisHash) и независимый пересчёт заголовка
/// в программе zkVM; сверяет tests/RollupGenesis.spec.ts. Тесты берут его get-методом genesisHash.
const GENESIS_HASH: int = 0xc0284e91570e7f1314f6e4460a613225f49b46deeebd2be3c463fb1c1e0e7883
/// Версия протокола: формат публичных значений, сообщений и хранилища (PROTOCOL-V2.md).
const PROTOCOL_VERSION: int = 2
/// Глубина дерева выводов: 2^32 листьев.
const WITHDRAWAL_TREE_DEPTH: int = 32
/// Скалярное поле BN254 ~254 бита: дайджест публичных значений обрезается до 253 бит
/// (так же делает верификатор SP1).
const DIGEST_MASK_253: int = (1 << 253) - 1

@pure fun sha256OfBuilder(b: builder, count: int): uint256 asm "HASHEXT_SHA256"
@pure fun sha256OfFour(first: builder, second: builder, third: builder, fourth: builder, count: int): uint256
  asm "HASHEXT_SHA256"

/// Первый публичный вход пруфа: sha256 от одиннадцати 32-байтовых значений, обрезанный до
/// 253 бит. Порядок значений — часть протокола; программа для zkVM обязана
/// коммитить их так же:
///   chainId ‖ prevStateRoot ‖ newStateRoot ‖ batchHash
///           ‖ prevWithdrawalsRoot ‖ withdrawalsRoot ‖ prevDepositHash ‖ newDepositHash
///           ‖ prevWithdrawalsCount ‖ withdrawalsCount ‖ blockTimestamp
///
/// Из сообщения берутся четыре значения: новое слово состояния, новые корень и счётчик
/// выводов и время блока. Всё остальное — из хранилища: chainId, прежнее слово состояния, хеш
/// данных батча, опубликованных в TON (см. takeBatchData), хеши очереди L1 в прежней отметке
/// и в заявленной точке (`newDepositHash`, см. queueHashAt), ПРЕЖНИЕ корень и счётчик выводов.
/// Последнее принципиально: фронтир прежнего дерева — приватный вход программы, и без этой
/// привязки секвенсор мог бы приписать в дерево лист в свою пользу либо подменить счётчик
/// (один корень счётчик не связывает).
fun batchDigest(
  chainId: int, state: RollupState, queue: DepositQueue, roots: BatchRoots, batchHash: int, newDepositHash: int
): int {
  // Четыре 256-битных значения не помещаются в одну ячейку, поэтому строителей четыре:
  // 3 + 3 + 3 + 2 слова.
  val first = beginCell()
    .storeUint(chainId, 256)
    .storeUint(state.stateRoot, 256)
    .storeUint(roots.newStateRoot, 256);
  val second = beginCell()
    .storeUint(batchHash, 256)
    .storeUint(state.withdrawalsRoot, 256)
    .storeUint(roots.withdrawalsRoot, 256);
  val third = beginCell()
    .storeUint(queue.processedHash, 256)
    .storeUint(newDepositHash, 256)
    .storeUint(state.withdrawalsCount, 256);
  val fourth = beginCell().storeUint(roots.withdrawalsCount, 256).storeUint(roots.blockTimestamp, 256);
  return sha256OfFour(first, second, third, fourth, 4) & DIGEST_MASK_253;
}

/// Хеш очереди L1 в точке «обработано n элементов» — восьмое слово публичных значений батча,
/// заявившего отметку n. Проверяет саму отметку: processed ≤ n ≤ head и не больше
/// MAX_BATCH_QUEUE_ITEMS элементов за батч.
///
/// Точка n == head — текущий хеш очереди; иначе — хеш ДО элемента n + 1 из словаря. Поэтому
/// элемент, вставший в очередь между сборкой блока и приёмом батча, батч не ломает: хеш в
/// точке n от него не зависит.
@inline_ref
fun queueHashAt(state: RollupState, queue: DepositQueue, n: int): int {
  assert ((n >= queue.processedCount) && (n <= queue.headCount)) throw RollupErrors.QueueMarkOutOfRange;
  assert (n - queue.processedCount <= MAX_BATCH_QUEUE_ITEMS) throw RollupErrors.TooManyQueueItems;
  if (n == queue.headCount) {
    return queue.headHash;
  }
  val next = state.queueItems.get(n + 1);
  assert (next.isFound) throw RollupErrors.QueueEntryMissing;
  return next.loadValue().hashBefore;
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
  /// Хеш очереди L1 в заявленной батчем точке.
  newDepositHash: int
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
  // Время блока L2 — в прошлом L1, но не старше maxBlockAge: иначе время L2 можно было бы
  // вести в произвольном отставании или забегании. Батч, не принятый за maxBlockAge, негоден
  // навсегда.
  val now = blockchain.now();
  assert (roots.blockTimestamp <= now) throw RollupErrors.BlockFromFuture;
  assert (roots.blockTimestamp + storage.maxBlockAge >= now) throw RollupErrors.BlockTooOld;
  val newDepositHash = queueHashAt(state, queue, roots.queueProcessedUpTo);
  // Хеш данных батча контракт берёт из своего хранилища: пруф для данных, которые не
  // были опубликованы в TON, не сойдётся.
  val batchHash = takeBatchData(mutate state);
  return PreparedBatch {
    storage: storage,
    state: state,
    queue: queue,
    roots: roots,
    newDepositHash: newDepositHash,
    digest: batchDigest(storage.chainId, state, queue, roots, batchHash, newDepositHash),
    vkData: keys.vkData!,
  };
}

/// Применяет батч, пруф которого уже проверен. Записи словаря очереди здесь не удаляются:
/// это самая тесная по газу транзакция. Их убирают постановка в очередь и PruneDepositReceipts.
fun applyBatch(batch: PreparedBatch) {
  val nextQueue = DepositQueue {
    headCount: batch.queue.headCount,
    headHash: batch.queue.headHash,
    processedCount: batch.roots.queueProcessedUpTo,
    processedHash: batch.newDepositHash,
    prunedCount: batch.queue.prunedCount,
  };
  var next = batch.state;
  next.stateRoot = batch.roots.newStateRoot;
  next.withdrawalsRoot = batch.roots.withdrawalsRoot;
  next.withdrawalsCount = batch.roots.withdrawalsCount;
  next.batchIndex = batch.state.batchIndex + 1;
  next.queue = nextQueue.toCell();
  var storage = batch.storage;
  storage.state = next.toCell();
  storage.save();
}

/// Убирает из словаря очереди не больше `limit` записей уже обработанных элементов, самые
/// старые. Записи с номерами больше processedCount не трогает никогда: по ним считается хеш
/// очереди в точке N, срок заморозки и возврат депозита. Возвращает, сколько убрано.
fun pruneQueueItems(mutate state: RollupState, mutate queue: DepositQueue, limit: int): int {
  var pruned = 0;
  while ((pruned < limit) && (queue.prunedCount < queue.processedCount)) {
    queue.prunedCount += 1;
    state.queueItems.delete(queue.prunedCount);
    pruned += 1;
  }
  return pruned;
}

/// Ставит элемент в очередь L1→L2 и возвращает его номер (с единицы). Элемент входит в
/// накопительный хеш как sha256(прежний ‖ first ‖ second); в словарь идёт запись с хешем
/// очереди до элемента, временем постановки и квитанцией (у депозита).
fun pushQueueItem(mutate state: RollupState, first: int, second: int, receipt: DepositReceipt?): int {
  var queue = state.queue.load();
  // Попутная уборка: записи обработанных элементов больше не нужны.
  pruneQueueItems(mutate state, mutate queue, QUEUE_PRUNE_PER_PUSH);
  // После постановки неубранных записей не больше MAX_TRACKED_ITEMS.
  assert (queue.headCount - queue.prunedCount < MAX_TRACKED_ITEMS) throw RollupErrors.QueueStorageFull;
  val index = queue.headCount + 1;
  state.queueItems.set(index, QueueEntry { hashBefore: queue.headHash, queuedAt: blockchain.now(), receipt: receipt });
  queue.headHash = sha256OfBuilder(
    beginCell().storeUint(queue.headHash, 256).storeUint(first, 256).storeUint(second, 256),
    1
  );
  queue.headCount = index;
  state.queue = queue.toCell();
  return index;
}

/// Фиксированная комиссия обязана покрывать газ шага при текущих ценах сети: иначе шаг
/// оплачивался бы из денег пользователей.
@inline
fun assertFeeCoversGas(fee: coins, stepGas: int) {
  assert (fee >= calculateGasFee(BASECHAIN, stepGas)) throw RollupErrors.FeeBelowGasCost;
}

/// Сколько раз удвоена плата за место в очереди при нынешней длине необработанного хвоста.
@inline
fun queueFeeDoublings(queue: DepositQueue): int {
  return min((queue.headCount - queue.processedCount) / QUEUE_FEE_STEP, QUEUE_FEE_MAX_DOUBLINGS);
}

/// Комиссия депозита при нынешней длине необработанного хвоста очереди.
@inline
fun depositFeeFor(queue: DepositQueue): coins {
  return DEPOSIT_FEE << queueFeeDoublings(queue);
}

/// Плата за принудительную транзакцию при нынешней длине необработанного хвоста очереди.
@inline
fun forceTransactionFeeFor(queue: DepositQueue): coins {
  return forceTransactionFee() << queueFeeDoublings(queue);
}

/// Базовая плата за принудительную транзакцию: FORCE_TRANSACTION_FEE, но не меньше стоимости газа
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
  // Пока ключи не зафиксированы, вносить нельзя: иначе владелец мог бы дождаться депозитов
  // и зафиксировать ключ другой программы. Исключение вернёт монеты отправителю.
  assert (storage.keys.load().vkData != null) throw RollupErrors.KeyNotFinalized;
  var state = storage.state.load();
  // В замороженный rollup вносить тоже нельзя.
  assert (!state.frozen) throw RollupErrors.RollupFrozen;
  assertFeeCoversGas(DEPOSIT_FEE, DEPOSIT_STEP_GAS);

  // Комиссия растёт с длиной необработанного хвоста очереди и вычитается из суммы на L2: вноситель сам задаёт,
  // на какую он согласен. Иначе — отказ, и депозит возвращается целиком.
  val fee = depositFeeFor(state.queue.load());
  assert (fee <= msg.maxFee) throw RollupErrors.QueueFeeAboveLimit;
  val amount = valueCoins - fee;
  assert (amount >= MIN_DEPOSIT) throw RollupErrors.DepositTooSmall;
  assert (amount < DEPOSIT_AMOUNT_LIMIT) throw RollupErrors.DepositTooLarge;
  // Квитанция: если rollup заморозят раньше, чем депозит попадёт в батч, его вернут вносителю.
  pushQueueItem(mutate state, msg.l2Recipient, amount, DepositReceipt { depositor: sender, amount: amount });
  storage.state = state.toCell();
  storage.save();
}

fun handleForceTransaction(valueCoins: coins, msg: ForceTransaction) {
  var storage = RollupStorage.load();
  assert (storage.keys.load().vkData != null) throw RollupErrors.KeyNotFinalized;
  var state = storage.state.load();
  assert (!state.frozen) throw RollupErrors.RollupFrozen;
  // Плата растёт с длиной необработанного хвоста очереди, но вытеснить принудительную
  // транзакцию нельзя, можно только заставить заплатить больше.
  assert (valueCoins >= forceTransactionFeeFor(state.queue.load())) throw RollupErrors.NotEnoughValue;
  // Содержимое не разбирается, проверяются только форма «змейки» — целые байты, не больше одной
  // ссылки, не больше MAX_FORCED_TX_CELLS обычных ячеек — и длина: не больше MAX_FORCED_TX_BYTES
  // байт. В очередь идёт keccak-256 прочитанных
  // байтов — для транзакции EVM это её хеш, — а не хеш ячейки: от нарезки он не зависит, и
  // программа zkVM считает его из тех же байтов. Что транзакция — именно вывод через мост,
  // контракт не проверяет: негодную программа пропустит.
  val parts = byteParts(msg.l2Transaction, MAX_FORCED_TX_CELLS, RollupErrors.MalformedForcedTransaction as int);
  assert (totalBits(parts) <= MAX_FORCED_TX_BYTES * 8) throw RollupErrors.MalformedForcedTransaction;
  pushQueueItem(mutate state, FORCED_TRANSACTION_MARKER, keccak256OfParts(parts), null);
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

/// Начальное состояние обязано быть каноническим: закреплённый генезис, ни одного батча,
/// пустое дерево выводов, пустая очередь L1, ни долгов, ни данных батчей. Контракт не может
/// проверить свои начальные данные при развёртывании, но может отказаться начинать с ними
/// работу: без зафиксированного ключа нет ни депозитов, ни батчей.
///
/// Подложенный долг (owed) выплатился бы сообщением PayOwed из чужих депозитов; подложенный
/// хеш данных (pendingData) вошёл бы в публичный вход батча с этим номером, и секвенсору
/// пришлось бы сбрасывать его, прежде чем что-либо доказать.
///
/// Это закрывает подлог только на пути через FinalizeKey. Контракт, развёрнутый с уже
/// «зафиксированным» ключом (vkData в начальных данных), сюда не попадает вовсе: сверка адреса
/// (wrappers/rollupDeployment.ts) остаётся обязательной.
@inline_ref
fun assertCanonicalGenesis(state: RollupState) {
  val queue = state.queue.load();
  assert (
    (state.batchIndex == 0)
      && (state.stateRoot == GENESIS_HASH)
      && (state.withdrawalsRoot == 0)
      && (state.withdrawalsCount == 0)
      && (queue.headCount == 0)
      && (queue.headHash == 0)
      && (queue.processedCount == 0)
      && (queue.processedHash == 0)
      && (queue.prunedCount == 0)
      && state.queueItems.isEmpty()
      && state.pendingData.isEmpty()
      && state.owed.isEmpty()
  ) throw RollupErrors.BadGenesis;
}

fun handleFinalizeKey(sender: address, msg: FinalizeKey) {
  var storage = RollupStorage.load();
  assert (sender == storage.owner) throw RollupErrors.NotOwner;
  var keys = storage.keys.load();
  assert (keys.vkData == null) throw RollupErrors.KeyAlreadyFinalized;
  assert (!storage.state.load().frozen) throw RollupErrors.RollupFrozen;
  // Слишком короткий срок заморозки — признак тестовой конфигурации: с ним rollup не
  // начинает работу (без ключей депозиты не принимаются).
  assert (storage.escapeTimeout >= MIN_ESCAPE_TIMEOUT) throw RollupErrors.BadDeployment;
  // Возраст блока: не меньше получаса (иначе батч не успеть принять) и не больше срока
  // заморозки (иначе время L2 могло бы отставать дольше, чем живёт необработанная очередь).
  assert ((storage.maxBlockAge >= MIN_MAX_BLOCK_AGE) && (storage.maxBlockAge <= storage.escapeTimeout))
    throw RollupErrors.BadDeployment;
  assertCanonicalGenesis(storage.state.load());
  // У ключа ровно один переменный вход: остальные (в том числе нонс SP1, равный нулю)
  // свёрнуты в IC0. Второй таблицы быть не должно — проверить её было бы нечем.
  assert (msg.table1Parts == 0) throw KEY_ERROR_BAD_PART;
  assert (g1IsValid(msg.ic0x, msg.ic0y)) throw RollupErrors.BadKeyPoint;
  keys.vkData = assembleKey(keys.keyParts, msg);
  keys.keyParts = createEmptyMap();
  storage.keys = keys.toCell();
  storage.save();
}

/// (слово состояния, корень выводов, номер батча, счётчик выводов)
fun rollupStateView(): (int, int, int, int) {
  val state = RollupStorage.load().state.load();
  return (state.stateRoot, state.withdrawalsRoot, state.batchIndex, state.withdrawalsCount);
}

/// Параметры развёртывания: (владелец, секвенсор, chainId, срок заморозки, наибольший возраст
/// блока, хеш кода нуллификатора). Контракт не может проверить их сам — их сверяет тот, кто
/// собирается доверить rollup'у деньги (scripts/verifyRollupDeployment.ts, ARCHITECTURE.md).
fun deploymentView(): (address, address, int, int, int, int) {
  val storage = RollupStorage.load();
  return (
    storage.owner,
    storage.sequencer,
    storage.chainId,
    storage.escapeTimeout,
    storage.maxBlockAge,
    storage.nullifierCode.hash()
  );
}

/// Пределы очереди L1: (элементов на батч, записей в словаре, ячеек в «змейке» принудительной
/// транзакции, записей, убираемых одной постановкой, предел суммы депозита на L2, байт в
/// принудительной транзакции).
fun queueLimitsView(): (int, int, int, int, int, int) {
  return (
    MAX_BATCH_QUEUE_ITEMS,
    MAX_TRACKED_ITEMS,
    MAX_FORCED_TX_CELLS,
    QUEUE_PRUNE_PER_PUSH,
    DEPOSIT_AMOUNT_LIMIT,
    MAX_FORCED_TX_BYTES
  );
}

/// Границы времени: (наименьший допустимый maxBlockAge, наименьший допустимый срок заморозки).
fun timeLimitsView(): (int, int) {
  return (MIN_MAX_BLOCK_AGE, MIN_ESCAPE_TIMEOUT);
}

/// Запасы газа шагов очереди L1 и БАЗОВАЯ плата за принудительную транзакцию при текущих
/// ценах: (газ шага депозита, газ постановки принудительной транзакции, базовая плата).
fun queueBudgetsView(): (int, int, int) {
  return (DEPOSIT_STEP_GAS, FORCE_TRANSACTION_STEP_GAS, forceTransactionFee());
}

/// Плата за место в очереди прямо сейчас: (комиссия депозита, плата за принудительную
/// транзакцию, необработанных элементов в очереди, шаг удвоения). Комиссию депозита вноситель
/// указывает в поле maxFee; плату за принудительную транзакцию прикладывает к сообщению.
fun queueFeesView(): (int, int, int, int) {
  val queue = RollupStorage.load().state.load().queue.load();
  return (depositFeeFor(queue), forceTransactionFeeFor(queue), queue.headCount - queue.processedCount, QUEUE_FEE_STEP);
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

/// Очередь L1: (поставлено, хеш), (обработано, хеш), убрано записей.
fun depositQueueView(): DepositQueue {
  return RollupStorage.load().state.load().queue.load();
}

/// Запись об элементе очереди: (есть ли, хеш очереди до элемента, когда встал).
fun queueItemView(index: int): (bool, int, int) {
  val entry = RollupStorage.load().state.load().queueItems.get(index);
  if (!entry.isFound) {
    return (false, 0, 0);
  }
  val item = entry.loadValue();
  return (true, item.hashBefore, item.queuedAt);
}

/// Первый публичный вход, который контракт потребует от следующего батча с такими значениями
/// (при уже опубликованных для него данных). Отметка очереди проверяется как в батче; время
/// блока — нет: оно сверяется с временем приёма.
fun expectedPublicInputView(roots: BatchRoots): int {
  val storage = RollupStorage.load();
  val state = storage.state.load();
  val queue = state.queue.load();
  return batchDigest(
    storage.chainId,
    state,
    queue,
    roots,
    batchDataHashOf(state.pendingData, state.batchIndex + 1),
    queueHashAt(state, queue, roots.queueProcessedUpTo)
  );
}
