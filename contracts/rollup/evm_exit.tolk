// Аварийный выход счёта EVM БЕЗ пруфа zkVM: контракт сам проверяет доказательство счёта.
//
// Для rollup'а на EVM слово состояния в контракте — хеш заголовка последнего принятого блока
// (zkvm-evm/lib). После заморозки владелец обычного счёта L2 присылает:
//   • заголовок этого блока (RLP) — его keccak обязан совпасть со словом состояния, из него
//     берётся корень состояния Ethereum;
//   • доказательство счёта против этого корня — то, что отдаёт любой узел по eth_getProof;
//   • подпись своим ключом под chainId, хешем блока и получателем в TON.
// Адрес счёта контракт восстанавливает из подписи сам, баланс берёт из листа дерева. Дальше —
// та же цепочка, что у выхода по пруфу: заявка в нуллификатор счёта и выплата либо долг.
//
// Почему этому можно верить. Каждый узел доказательства хешируется из своих байтов, и хеш
// обязан совпасть с тем, что записан в родителе (у корня — с корнем состояния из заголовка).
// Значит, байты каждого узла — байты узла настоящего дерева, и остаётся только прочесть их
// однозначно: вид узла (ветка, расширение, лист) задаёт признак в пути, он проверяется явно;
// разбор обязан закончиться ровно на конце узла; путь обязан совпасть с ключом полубайт в
// полубайт и закончиться листом ровно на 64-м.
//
// Чего здесь нет: выходит только собственный баланс обычного счёта. Деньги на контрактах L2
// и токены так не вывести — подписать согласие некому. Остаток меньше 1 gwei теряется.
//
// Как присылаются байты. Байтовая строка (заголовок, узел) — «змейка» ячеек: данные из целых
// байтов и не больше одной ссылки на продолжение. Резать строку можно где угодно, но каждая
// читаемая единица (байт признака, длина, содержимое строки до 32 байт) обязана лежать в
// одной ячейке целиком — так режет wrappers/evmExit.ts.
import "storage"
import "messages"
import "logic"
import "escape"
import "nullifier_types"
import "@stdlib/gas-payments"

enum EvmExitErrors {
  /// Байтовая строка не из целых байтов, ячеек слишком много или единица разрезана ячейками.
  BadEncoding = 7400,
  /// Хеш заголовка не равен слову состояния контракта.
  WrongBlockHeader = 7401,
  /// Не тот байт признака RLP, что ожидался в этом месте.
  BadRlp = 7402,
  /// Хеш узла не тот, что записан в родителе (или в заголовке).
  WrongNodeHash = 7403,
  /// Путь доказательства расходится с ключом счёта, или счёта в дереве нет.
  KeyNotInTrie = 7404,
  /// Узел разобран не до конца, лишние байты или недопустимый вид.
  BadNode = 7405,
  /// Подпись не восстанавливается.
  BadSignature = 7406,
}

/// Строка-метка согласия: «ton-zk-rollup:evm-exit:v1» (25 байт).
const EVM_EXIT_TAG: int = 0x746f6e2d7a6b2d726f6c6c75703a65766d2d657869743a7631
/// Префикс подписи сообщения Ethereum для 32 байт: «\x19Ethereum Signed Message:\n32» (28 байт).
const ETH_SIGNED_PREFIX: int = 0x19457468657265756d205369676e6564204d6573736167653a0a3332
/// 1 нанотон = 1 gwei (zkvm-evm/lib, WEI_PER_NANOTON).
const EVM_WEI_PER_NANOTON: int = 1000000000
/// Больше ячеек у одной байтовой строки не бывает: заголовок блока — до 6, узел-ветка — до 6.
const EVM_MAX_PARTS: int = 12
/// Газ шага ForceExitEvm, из которого считается минимум приложенных монет. Измерено
/// (bench/rollup-evm-exit.json): 103–164 тыс. gas на настоящих доказательствах из 3–5 узлов и
/// 454 тыс. на десяти полных ветках с листом — глубина дерева с триллионом счетов; полная
/// ветка стоит около 43 тыс. Запас покрывает второе с десятой долей сверху; тест сверяет
/// измеренное с этим числом через get-метод evmExitBudget.
const EVM_EXIT_STEP_GAS: int = 500000

@pure fun keccak256OfBuilder(b: builder, count: int): uint256 asm "HASHEXT_KECCAK256"
/// keccak-256 склейки срезов: кортеж раскладывается на стек вместе с числом элементов.
@pure fun keccak256OfParts(parts: array<slice>): uint256 asm "255 PUSHINT EXPLODEVAR HASHEXT_KECCAK256"
/// Восстановление ключа secp256k1 из подписи: (признак, x, y, успех).
@pure fun ecRecover(hash: uint256, v: int, r: uint256, s: uint256): (int?, int?, int?, bool)
  asm "ECRECOVER NULLSWAPIFNOT2 NULLSWAPIFNOT"

/// Минимум монет на выход: сам шаг, заявка в нуллификатор и всё, что нужно нуллификатору.
@inline
fun evmExitMinValue(): coins {
  return calculateGasFee(BASECHAIN, EVM_EXIT_STEP_GAS)
    + calculateForwardFee(BASECHAIN, CLAIM_MESSAGE_BITS, CLAIM_MESSAGE_CELLS)
    + nullifierMinValue();
}

/// Срезы «змейки» по порядку: только данные, без ссылок.
@inline_ref
fun byteParts(root: cell): array<slice> {
  var parts: array<slice> = [];
  var current = root;
  var more = true;
  while (more) {
    var s = current.beginParse();
    val bits = s.remainingBitsCount();
    assert (bits % 8 == 0) throw EvmExitErrors.BadEncoding;
    parts.push(s.loadBits(bits));
    assert (parts.size() <= EVM_MAX_PARTS) throw EvmExitErrors.BadEncoding;
    val refs = s.remainingRefsCount();
    assert (refs <= 1) throw EvmExitErrors.BadEncoding;
    if (refs == 1) {
      current = s.loadRef();
    } else {
      more = false;
    }
  }
  return parts;
}

/// Последовательное чтение байтовой строки, разложенной по срезам.
struct ByteReader {
  parts: array<slice>
  next: int
  current: slice
}

/// Читает `bytes` байт (от 1 до 32) как число. Единица обязана лежать в одном срезе целиком.
fun ByteReader.take(mutate self, bytes: int): int {
  if (self.current.isEndOfBits()) {
    assert (self.next < self.parts.size()) throw EvmExitErrors.BadNode;
    self.current = self.parts.get(self.next);
    self.next += 1;
  }
  assert (self.current.remainingBitsCount() >= bytes * 8) throw EvmExitErrors.BadEncoding;
  return self.current.loadUint(bytes * 8);
}

fun ByteReader.atEnd(self): bool {
  return self.current.isEndOfBits() && (self.next == self.parts.size());
}

/// Заголовок списка RLP. Длину содержимого не возвращаем: что байты узла — байты настоящего
/// узла, уже установлено хешем, а разбор обязан закончиться ровно на конце (atEnd).
fun ByteReader.listHeader(mutate self) {
  val b = self.take(1);
  if (b == 0xf8) {
    self.take(1);
  } else if (b == 0xf9) {
    self.take(2);
  } else {
    assert ((b >= 0xc0) && (b <= 0xf7)) throw EvmExitErrors.BadRlp;
  }
}

/// Ссылка на узел: 32-байтовый хеш либо пусто (−1). Встроенных узлов (короче 32 байт) в
/// дереве счетов не бывает: лист счёта длиннее.
fun ByteReader.hashOrEmpty(mutate self): int {
  val b = self.take(1);
  if (b == 0x80) {
    return -1;
  }
  assert (b == 0xa0) throw EvmExitErrors.BadRlp;
  return self.take(32);
}

/// Строка RLP длиной от 1 до 33 байт (путь узла): (длина, первый байт, остальное числом).
fun ByteReader.pathString(mutate self): (int, int, int) {
  val b = self.take(1);
  if (b < 0x80) {
    return (1, b, 0);
  }
  assert ((b >= 0x81) && (b <= 0xa1)) throw EvmExitErrors.BadRlp;
  val length = b - 0x80;
  val first = self.take(1);
  var rest = 0;
  if (length > 1) {
    rest = self.take(length - 1);
  }
  return (length, first, rest);
}

/// Число RLP до 32 байт.
fun ByteReader.scalar(mutate self): int {
  val b = self.take(1);
  if (b < 0x80) {
    return b;
  }
  assert (b <= 0xa0) throw EvmExitErrors.BadRlp;
  if (b == 0x80) {
    return 0;
  }
  return self.take(b - 0x80);
}

/// Значение листа: строка RLP, внутри — список счёта [nonce, баланс, корень хранилища, хеш
/// кода]. Возвращает баланс в wei.
fun ByteReader.accountBalance(mutate self): int {
  val b = self.take(1);
  if (b == 0xb8) {
    self.take(1);
  } else {
    assert ((b >= 0x80) && (b <= 0xb7)) throw EvmExitErrors.BadRlp;
  }
  self.listHeader();
  self.scalar();
  val balance = self.scalar();
  assert (self.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;
  assert (self.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;
  return balance;
}

/// Корень состояния из RLP заголовка блока: четвёртое поле после хеша родителя, хеша «дядей»
/// и получателя наград. Хеш заголовка сверяет вызывающий.
@inline_ref
fun evmHeaderStateRoot(parts: array<slice>): int {
  var reader = ByteReader { parts: parts, next: 0, current: createEmptySlice() };
  reader.listHeader();
  assert (reader.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;
  assert (reader.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;
  assert (reader.take(1) == 0x94) throw EvmExitErrors.BadRlp;
  reader.take(20);
  val root = reader.hashOrEmpty();
  assert (root != -1) throw EvmExitErrors.BadRlp;
  return root;
}

/// Баланс (в wei) счёта с ключом `key` = keccak(адрес) в дереве с корнем `stateRoot`.
/// Доказательство — цепочка узлов от корня к листу. Вид узла подсказывает присылающий;
/// неверная подсказка не пройдёт: разбор обязан закончиться ровно на конце узла.
@inline_ref
fun evmAccountBalance(stateRoot: int, key: int, firstStep: Cell<EvmProofStep>): int {
  var expected = stateRoot;
  var depth = 0;
  var step = firstStep.load();
  // Каждый узел продвигает глубину хотя бы на полубайт, глубина не больше 64: цикл конечен.
  while (true) {
    val parts = byteParts(step.node);
    assert (keccak256OfParts(parts) == expected) throw EvmExitErrors.WrongNodeHash;
    var reader = ByteReader { parts: parts, next: 0, current: createEmptySlice() };
    reader.listHeader();
    if (step.isBranch) {
      assert (depth < 64) throw EvmExitErrors.KeyNotInTrie;
      val nibble = (key >> (4 * (63 - depth))) & 15;
      var child = -1;
      var index = 0;
      repeat (16) {
        val item = reader.hashOrEmpty();
        if (index == nibble) {
          child = item;
        }
        index += 1;
      }
      // Семнадцатый элемент ветки — значение; в дереве счетов он всегда пуст.
      assert (reader.take(1) == 0x80) throw EvmExitErrors.BadNode;
      assert (reader.atEnd()) throw EvmExitErrors.BadNode;
      assert (child != -1) throw EvmExitErrors.KeyNotInTrie;
      expected = child;
      depth += 1;
    } else {
      val (length, first, rest) = reader.pathString();
      // Старший полубайт первого байта пути — флаги: 2 — лист, 1 — нечётное число полубайтов.
      val flags = first >> 4;
      assert (flags <= 3) throw EvmExitErrors.BadNode;
      val odd = (flags & 1) == 1;
      assert (odd || ((first & 15) == 0)) throw EvmExitErrors.BadNode;
      var nibbles = 2 * (length - 1);
      if (odd) {
        nibbles += 1;
      }
      assert (depth + nibbles <= 64) throw EvmExitErrors.KeyNotInTrie;
      var pathValue = rest;
      if (odd) {
        pathValue = ((first & 15) << (8 * (length - 1))) | rest;
      }
      var keyPart = key;
      if (nibbles < 64) {
        keyPart = (key >> (4 * (64 - depth - nibbles))) & ((1 << (4 * nibbles)) - 1);
      }
      assert (pathValue == keyPart) throw EvmExitErrors.KeyNotInTrie;
      depth += nibbles;
      if ((flags & 2) == 2) {
        // Лист: путь обязан довести ровно до конца ключа, после листа узлов быть не может.
        assert (depth == 64) throw EvmExitErrors.KeyNotInTrie;
        val balance = reader.accountBalance();
        assert (reader.atEnd()) throw EvmExitErrors.BadNode;
        assert (step.next == null) throw EvmExitErrors.BadNode;
        return balance;
      }
      // Расширение: непустой путь и ссылка на следующий узел.
      assert (nibbles > 0) throw EvmExitErrors.BadNode;
      val child = reader.hashOrEmpty();
      assert (child != -1) throw EvmExitErrors.BadNode;
      assert (reader.atEnd()) throw EvmExitErrors.BadNode;
      expected = child;
    }
    assert (step.next != null) throw EvmExitErrors.KeyNotInTrie;
    step = step.next!.load();
  }
  return 0;
}

/// Хеш, под которым владелец счёта подписывает согласие на выход (до префикса Ethereum):
/// метка ‖ chainId ‖ хеш блока ‖ хеш получателя в TON.
@inline
fun evmExitConsent(chainId: int, blockHash: int, recipientHash: int): int {
  return keccak256OfBuilder(
    beginCell()
      .storeUint(EVM_EXIT_TAG, 200)
      .storeUint(chainId, 256)
      .storeUint(blockHash, 256)
      .storeUint(recipientHash, 256),
    1
  );
}

fun handleForceExitEvm(valueCoins: coins, msg: ForceExitEvm) {
  val storage = RollupStorage.load();
  val state = storage.state.load();
  assert (state.frozen) throw RollupErrors.RollupNotFrozen;
  assert (valueCoins >= evmExitMinValue()) throw RollupErrors.NotEnoughValue;
  val (workchain, recipientHash) = msg.recipient.getWorkchainAndHash();
  assert (workchain == BASECHAIN) throw RollupErrors.WrongRecipient;

  // Заголовок: его хеш — слово состояния контракта, из него — корень состояния Ethereum.
  val headerParts = byteParts(msg.header);
  assert (keccak256OfParts(headerParts) == state.stateRoot) throw EvmExitErrors.WrongBlockHeader;
  val evmStateRoot = evmHeaderStateRoot(headerParts);

  // Согласие владельца: обычная подпись сообщения Ethereum под 32 байтами хеша согласия.
  val consent = evmExitConsent(storage.chainId, state.stateRoot, recipientHash);
  val digest = keccak256OfBuilder(beginCell().storeUint(ETH_SIGNED_PREFIX, 224).storeUint(consent, 256), 1);
  val signature = msg.signature.load();
  // Кошельки Ethereum отдают v = 27 или 28, номер восстановления — 0 или 1; годится и то и
  // другое. В Sandbox ECRECOVER принимает 27 и 28 и сам (без приведения ниже выход проходит так
  // же), но это поведение опкода не описано — формат подписи на него не опирается. Негодный
  // номер ECRECOVER отвергает (тест шлёт 29 и 31), отдельной проверки не нужно: какой бы номер
  // ни прошёл, восстановленный ключ — ключ, чья это подпись.
  var recoveryId = signature.v;
  if (recoveryId >= 27) {
    recoveryId -= 27;
  }
  val (_, x, y, recovered) = ecRecover(digest, recoveryId, signature.r, signature.s);
  assert (recovered) throw EvmExitErrors.BadSignature;
  // Адрес Ethereum — младшие 20 байт keccak от ключа; ключ счёта в дереве — keccak от адреса.
  val account = keccak256OfBuilder(beginCell().storeUint(x!, 256).storeUint(y!, 256), 1) & ((1 << 160) - 1);
  val key = keccak256OfBuilder(beginCell().storeUint(account, 160), 1);

  val balance = evmAccountBalance(evmStateRoot, key, msg.proof);
  val amount = balance / EVM_WEI_PER_NANOTON;
  assert (amount > 0) throw RollupErrors.NothingToExit;
  assert (amount < (1 << 120)) throw RollupErrors.InsufficientFunds;
  assertCanPay(amount as coins, valueCoins);
  completeForceExit(storage, msg.queryId, ExitClaim { l2Account: account, amount: amount, recipient: msg.recipient });
}
