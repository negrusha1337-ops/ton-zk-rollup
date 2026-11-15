#!/usr/bin/env python3
"""Проверка тестов rollup-контракта протокола v2 мутациями.

    python3 zk/rollup-mutation-check.py                              # все мутации, отчёт в bench/
    python3 zk/rollup-mutation-check.py --only <часть названия>      # выборочно, без отчёта
    python3 zk/rollup-mutation-check.py --dry                        # только сверить образцы с исходниками

Убирает по одной защите из contracts/rollup/logic.tolk, escape.tolk, storage.tolk и bytes.tolk
(форма «змейки» принудительной транзакции), из contracts/rollup_nullifier.tolk (а для двух
проверок точки входа — из contracts/rollup.tolk) и запускает два теста: тот, что обязан эту
мутацию убить, и контрольный (tests/RollupCompiles.spec.ts), который только собирает контракты.
Контрольный падает, лишь если мутант не собрался, — так «не собралась» не выдаётся за «убита».
Мутация убита, если контрольный прошёл, а её тест упал. Выжившая мутация — повод чинить тест,
а не список.

У каждой мутации записан ОЖИДАЕМЫЙ тест-убийца: «убита кем-то» не считается (так третий круг
проверки нашёл мутации, убитые чужим тестом по случайности).

Исходники на время работы лежат копиями рядом (*.tolk.orig): после сбоя следующий запуск вернёт
их сам. Пока копии лежат, в рабочем дереве — мутант: тесты в bench ничего не пишут
(tests/helpers/benchResults.ts), а другие прогоны jest в это время запускать нельзя. Итог —
bench/rollup-mutation-report.txt. Нагрузка: сборка контракта и один-два теста на мутацию, по
одной; весь прогон — около получаса.

Мутации разбора счёта EVM — отдельный скрипт, zk/evm-exit-mutation-check.py; чтение «змейки»
ячеек (bytes.tolk) мутируется в обоих: там убийцы — тесты выхода счёта EVM, здесь — тесты формы
принудительной транзакции (tests/RollupForced.spec.ts).
"""
import datetime
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LOGIC = ROOT / "contracts/rollup/logic.tolk"
ESCAPE = ROOT / "contracts/rollup/escape.tolk"
STORAGE = ROOT / "contracts/rollup/storage.tolk"
ENTRY = ROOT / "contracts/rollup.tolk"
BYTES = ROOT / "contracts/rollup/bytes.tolk"
NULLIFIER = ROOT / "contracts/rollup_nullifier.tolk"
SOURCES = [LOGIC, ESCAPE, STORAGE, ENTRY, BYTES, NULLIFIER]
REPORT = ROOT / "bench/rollup-mutation-report.txt"
CONTROL_SPEC = "tests/RollupCompiles.spec.ts"
CONTROL = "контракт, двойник и нуллификатор собираются"

# Наборы тестов.
T_ROLLUP = "tests/Rollup.spec.ts"
T_QUEUE = "tests/RollupQueue.spec.ts"
T_FORCED = "tests/RollupForced.spec.ts"
T_ESCAPE = "tests/RollupEscape.spec.ts"
T_GENESIS = "tests/RollupGenesis.spec.ts"
T_FEE = "tests/RollupQueueFee.spec.ts"
T_GAS = "tests/RollupGasPrice.spec.ts"
T_PAYOUT = "tests/RollupPayout.spec.ts"
T_ATTACKS = "tests/RollupAttacks.spec.ts"
T_KEYS = "tests/RollupKeys.spec.ts"      # настоящий контракт
T_PROOF = "tests/RollupProof.spec.ts"    # настоящий контракт, настоящая проверка пруфа
T_RETH = "tests/RollupEvmReth.spec.ts"

# Часто встречающиеся тесты-убийцы.
FROZEN_REFUSES = "после заморозки батчи, данные и депозиты не принимаются"
NO_KEY_REAL = "до фиксации ключа контракт не принимает ни батчи, ни депозиты, ни принудительные транзакции"
NO_KEY_MOCK = "до фиксации ключей rollup не принимает ни депозиты, ни принудительные транзакции"
MARK_HASH = "контракт подставляет в публичный вход хеш очереди ровно в точке N — для каждого N от processed до head"
STATE_AFTER_BATCH = "принятый батч меняет слово состояния, корень и счётчик выводов и номер"
PARTIAL_MARK = "N посередине — обработано ровно до N, остальное ждёт следующего батча"
PRUNE_MESSAGE = "сообщение уборки удаляет не больше заданного числа записей и только обработанные"
DEEP_STEPS = "депозит и принудительная транзакция наибольшей длины укладываются в запасы газа — на самой глубокой вставке"
WITHDRAW_TAMPER = "подмена суммы, получателя, номера листа или доказательства не проходит"
OWNER_ONLY = "части ключа загружает и ключ фиксирует только владелец"
KEY_IMMUTABLE = "после фиксации ключ неизменяем: ни повторной фиксации, ни новых частей"
BLOCK_AGE = "возраст блока: не меньше получаса и не больше срока заморозки — по секунде с обеих сторон"
REFUND_ONCE = "после заморозки депозит возвращается вносителю, кто бы ни попросил, и только один раз"
FORCED_AFTER_FREEZE = "после заморозки в очередь ничего не ставится, а «возврата» у транзакции нет"
RETH_INPUTS = "контракт требует для каждого блока цепочки ровно тот публичный вход, что программа выдала в zkVM"
DEPOSIT_HASH = "ставит депозит в очередь и считает накопительный хеш"
EMPTY_NOT_FROZEN = "без необработанных элементов заморозить нельзя, сколько бы ни прошло времени"
FUTURE_BLOCK = "блок из будущего отклоняется: на секунду позже времени L1 — отказ, ровно «сейчас» — принят"
ITEMS_LIMIT = "ровно предел — принят, на один больше — отказ, хотя элементы в очереди есть"
BYTE_LENGTH = "длина в байтах: ровно предел принят при любой нарезке, на байт больше — отказ"
DEBT_ONCE = "долг выплачивается, когда деньги появились: ровно один раз и только записанному получателю"
FULL_PATH = "полный путь: депозит → батч → принудительная транзакция → два батча с данными → выводы"
LAYOUT = "раскладка состояния в обёртке — та же, что в контракте: каждое подложенное поле читается на своём месте"


def planted(what):
    return f"подложенное начальное состояние ({what}) — ключ не фиксируется"


def word(index, name):
    return f"слово {index} ({name}) подменено → отказ замыкающим равенством, код 7300"


# (название, файл, что заменить, на что, набор тестов, тест, который обязан упасть)
MUTATIONS = [
    # --- публичный вход: каждое из одиннадцати слов (настоящий контракт, настоящий пруф) ---
    ("слово 0 (chainId) не входит в дайджест", LOGIC,
     "    .storeUint(chainId, 256)\n", "    .storeUint(0, 256)\n", T_PROOF, word(0, "chainId")),
    ("слово 1 (прежнее слово состояния) не входит в дайджест", LOGIC,
     "    .storeUint(state.stateRoot, 256)\n", "    .storeUint(0, 256)\n", T_PROOF, word(1, "prevStateRoot")),
    ("слово 2 (новое слово состояния) не входит в дайджест", LOGIC,
     "    .storeUint(roots.newStateRoot, 256);", "    .storeUint(0, 256);", T_PROOF, word(2, "newStateRoot")),
    ("слово 3 (хеш данных батча) не входит в дайджест", LOGIC,
     "    .storeUint(batchHash, 256)\n", "    .storeUint(0, 256)\n", T_PROOF, word(3, "batchHash")),
    ("слово 4 (прежний корень выводов) не входит в дайджест", LOGIC,
     "    .storeUint(state.withdrawalsRoot, 256)\n", "    .storeUint(0, 256)\n", T_PROOF, word(4, "prevWithdrawalsRoot")),
    ("слово 5 (новый корень выводов) не входит в дайджест", LOGIC,
     "    .storeUint(roots.withdrawalsRoot, 256);", "    .storeUint(0, 256);", T_PROOF, word(5, "withdrawalsRoot")),
    ("слово 6 (хеш очереди в прежней отметке) не входит в дайджест", LOGIC,
     "    .storeUint(queue.processedHash, 256)\n", "    .storeUint(0, 256)\n", T_PROOF, word(6, "prevDepositHash")),
    ("слово 7 (хеш очереди в точке N) не входит в дайджест", LOGIC,
     "    .storeUint(newDepositHash, 256)\n", "    .storeUint(0, 256)\n", T_PROOF, word(7, "newDepositHash")),
    ("слово 8 (прежний счётчик выводов) не входит в дайджест", LOGIC,
     "    .storeUint(state.withdrawalsCount, 256);", "    .storeUint(0, 256);", T_PROOF, word(8, "prevWithdrawalsCount")),
    ("слово 9 (новый счётчик выводов) не входит в дайджест", LOGIC,
     "beginCell().storeUint(roots.withdrawalsCount, 256)", "beginCell().storeUint(0, 256)", T_PROOF, word(9, "withdrawalsCount")),
    ("слово 10 (время блока) не входит в дайджест", LOGIC,
     ".storeUint(roots.blockTimestamp, 256);", ".storeUint(0, 256);", T_PROOF, word(10, "blockTimestamp")),
    ("прежнее и новое слово состояния в дайджесте переставлены", LOGIC,
     "    .storeUint(state.stateRoot, 256)\n    .storeUint(roots.newStateRoot, 256);",
     "    .storeUint(roots.newStateRoot, 256)\n    .storeUint(state.stateRoot, 256);", T_RETH, RETH_INPUTS),
    ("дайджест не обрезается до 253 бит", LOGIC,
     "  return sha256OfFour(first, second, third, fourth, 4) & DIGEST_MASK_253;",
     "  return sha256OfFour(first, second, third, fourth, 4);", T_RETH, RETH_INPUTS),
    ("прежний счётчик выводов в дайджесте — нулевой (на цепочке Reth)", LOGIC,
     "    .storeUint(state.withdrawalsCount, 256);", "    .storeUint(0, 256);", T_RETH, RETH_INPUTS),

    # --- проверка пруфа и точка входа (настоящий контракт) ---
    ("исход проверки пруфа не смотрится", ENTRY,
     "      assert (ok) throw RollupErrors.WrongProof;\n", "",
     T_PROOF, "«лучшая подделка» батча отклоняется замыкающим равенством, а не раньше"),
    ("неизвестное сообщение принимается", ENTRY,
     "      assert (inMsg.body.isEmpty()) throw RollupErrors.UnknownMessage;\n", "",
     T_KEYS, "неизвестное сообщение отклоняется; пустое тело — пополнение баланса"),

    # --- отметка очереди ---
    ("отметка N может быть меньше processed", LOGIC,
     "  assert ((n >= queue.processedCount) && (n <= queue.headCount)) throw RollupErrors.QueueMarkOutOfRange;",
     "  assert (n <= queue.headCount) throw RollupErrors.QueueMarkOutOfRange;",
     T_QUEUE, "N меньше processed — отказ: обработанное назад не возвращается"),
    ("отметка N может быть больше head", LOGIC,
     "  assert ((n >= queue.processedCount) && (n <= queue.headCount)) throw RollupErrors.QueueMarkOutOfRange;",
     "  assert (n >= queue.processedCount) throw RollupErrors.QueueMarkOutOfRange;",
     T_QUEUE, "N больше head — отказ: заявить обработку того, чего в очереди нет, нельзя"),
    ("число элементов на батч не ограничено", LOGIC,
     "  assert (n - queue.processedCount <= MAX_BATCH_QUEUE_ITEMS) throw RollupErrors.TooManyQueueItems;\n", "",
     T_QUEUE, "ровно предел — принят, на один больше — отказ, хотя элементы в очереди есть"),
    ("хеш в точке N — всегда хеш головы очереди", LOGIC,
     "  if (n == queue.headCount) {\n    return queue.headHash;", "  if (true) {\n    return queue.headHash;", T_QUEUE, MARK_HASH),
    ("хеш в точке N берётся из записи N, а не N + 1", LOGIC,
     "  val next = state.queueItems.get(n + 1);", "  val next = state.queueItems.get(n);", T_QUEUE, MARK_HASH),
    ("отсутствие записи словаря при отметке в середине очереди не проверяется", LOGIC,
     "  assert (next.isFound) throw RollupErrors.QueueEntryMissing;\n", "",
     T_QUEUE, "батч с отметкой в середине очереди отказывает кодом 7334, если записи в словаре нет"),

    # --- данные батча ---
    ("данные публикует кто угодно", LOGIC,
     "  assert (sender == storage.sequencer) throw RollupErrors.NotSequencer;\n  var state = storage.state.load();\n  assert (!state.frozen) throw RollupErrors.RollupFrozen;\n  // Данные",
     "  var state = storage.state.load();\n  assert (!state.frozen) throw RollupErrors.RollupFrozen;\n  // Данные",
     T_ROLLUP, "публиковать данные может только секвенсор"),
    ("данные принимаются и после заморозки", LOGIC,
     "  assert (!state.frozen) throw RollupErrors.RollupFrozen;\n  // Данные можно публиковать", "  // Данные можно публиковать",
     T_ESCAPE, FROZEN_REFUSES),
    ("данные принятого батча можно публиковать", LOGIC,
     "  assert (msg.batchIndex > state.batchIndex) throw RollupErrors.DataForClosedBatch;\n", "",
     T_ROLLUP, "данные принятого батча опубликовать нельзя, а запись о них удаляется"),
    ("данные можно публиковать сколь угодно далеко вперёд", LOGIC,
     "  assert (msg.batchIndex <= state.batchIndex + MAX_DATA_BATCHES_AHEAD) throw RollupErrors.DataTooFarAhead;\n", "",
     T_ROLLUP, "данные нельзя публиковать дальше чем на четыре батча вперёд"),
    ("порции данных не накапливаются: хеш — только от последней", LOGIC,
     "dataHashStep(previous, msg.data.hash())", "dataHashStep(0, msg.data.hash())",
     T_ROLLUP, "порции складываются в накопительный хеш в порядке публикации"),
    ("данные батча сбрасывает кто угодно", LOGIC,
     "  assert (sender == storage.sequencer) throw RollupErrors.NotSequencer;\n  var state = storage.state.load();\n  state.pendingData.delete(msg.batchIndex);",
     "  var state = storage.state.load();\n  state.pendingData.delete(msg.batchIndex);",
     T_ROLLUP, "секвенсор может сбросить данные батча и опубликовать заново; посторонний — нет"),
    ("запись о данных принятого батча не удаляется", LOGIC,
     "  val entry = state.pendingData.deleteAndGetDeleted(state.batchIndex + 1);",
     "  val entry = state.pendingData.get(state.batchIndex + 1);",
     T_ROLLUP, "данные принятого батча опубликовать нельзя, а запись о них удаляется"),
    ("батч берёт данные своего номера минус один", LOGIC,
     "  val entry = state.pendingData.deleteAndGetDeleted(state.batchIndex + 1);",
     "  val entry = state.pendingData.deleteAndGetDeleted(state.batchIndex);",
     T_ROLLUP, "данные можно публиковать вперёд: они дожидаются своего батча"),

    # --- приём батча ---
    ("батч принимается от кого угодно", LOGIC,
     "  assert (sender == storage.sequencer) throw RollupErrors.NotSequencer;\n  val keys = storage.keys.load();",
     "  val keys = storage.keys.load();", T_ROLLUP, "принимает батч только от секвенсора"),
    ("батч принимается до фиксации ключа", LOGIC,
     "  assert (keys.vkData != null) throw RollupErrors.KeyNotFinalized;\n  var state = storage.state.load();\n  assert (!state.frozen) throw RollupErrors.RollupFrozen;\n  val queue",
     "  var state = storage.state.load();\n  assert (!state.frozen) throw RollupErrors.RollupFrozen;\n  val queue",
     T_KEYS, NO_KEY_REAL),
    ("батч принимается после заморозки", LOGIC,
     "  assert (!state.frozen) throw RollupErrors.RollupFrozen;\n  val queue = state.queue.load();\n  val roots",
     "  val queue = state.queue.load();\n  val roots", T_ESCAPE, FROZEN_REFUSES),
    ("блок из будущего принимается", LOGIC,
     "  assert (roots.blockTimestamp <= now) throw RollupErrors.BlockFromFuture;\n", "",
     T_ROLLUP, "блок из будущего отклоняется: на секунду позже времени L1 — отказ, ровно «сейчас» — принят"),
    ("устаревший блок принимается", LOGIC,
     "  assert (roots.blockTimestamp + storage.maxBlockAge >= now) throw RollupErrors.BlockTooOld;\n", "",
     T_ROLLUP, "устаревший блок отклоняется: ровно maxBlockAge назад — принят, на секунду старше — отказ"),
    ("граница возраста блока сдвинута на секунду", LOGIC,
     "  assert (roots.blockTimestamp + storage.maxBlockAge >= now) throw RollupErrors.BlockTooOld;",
     "  assert (roots.blockTimestamp + storage.maxBlockAge > now) throw RollupErrors.BlockTooOld;",
     T_ROLLUP, "устаревший блок отклоняется: ровно maxBlockAge назад — принят, на секунду старше — отказ"),

    ("ровно предел элементов на батч уже не принимается", LOGIC,
     "  assert (n - queue.processedCount <= MAX_BATCH_QUEUE_ITEMS) throw RollupErrors.TooManyQueueItems;",
     "  assert (n - queue.processedCount < MAX_BATCH_QUEUE_ITEMS) throw RollupErrors.TooManyQueueItems;",
     T_QUEUE, ITEMS_LIMIT),
    ("отметка N, равная processed, не принимается", LOGIC,
     "  assert ((n >= queue.processedCount) && (n <= queue.headCount)) throw RollupErrors.QueueMarkOutOfRange;",
     "  assert ((n > queue.processedCount) && (n <= queue.headCount)) throw RollupErrors.QueueMarkOutOfRange;",
     T_QUEUE, "N равно processed — пустой отрезок: батч принят, очередь не сдвинулась"),
    ("отметка N, равная head, не принимается", LOGIC,
     "  assert ((n >= queue.processedCount) && (n <= queue.headCount)) throw RollupErrors.QueueMarkOutOfRange;",
     "  assert ((n >= queue.processedCount) && (n < queue.headCount)) throw RollupErrors.QueueMarkOutOfRange;",
     T_QUEUE, "N равно head — очередь обработана целиком"),
    ("блок со временем ровно «сейчас» не принимается", LOGIC,
     "  assert (roots.blockTimestamp <= now) throw RollupErrors.BlockFromFuture;",
     "  assert (roots.blockTimestamp < now) throw RollupErrors.BlockFromFuture;", T_ROLLUP, FUTURE_BLOCK),

    # --- применение батча ---
    ("батч не записывает слово состояния", LOGIC,
     "  next.stateRoot = batch.roots.newStateRoot;\n", "", T_ROLLUP, STATE_AFTER_BATCH),
    ("батч обнуляет счётчик убранных записей", LOGIC,
     "    prunedCount: batch.queue.prunedCount,", "    prunedCount: 0,",
     T_QUEUE, "батч не трогает счётчик убранных записей: уборка продолжается с того же места"),
    ("батч не двигает хеш обработанного", LOGIC,
     "    processedHash: batch.newDepositHash,", "    processedHash: batch.queue.processedHash,", T_QUEUE, PARTIAL_MARK),
    ("батч всегда двигает отметку обработанного до головы", LOGIC,
     "    processedCount: batch.roots.queueProcessedUpTo,", "    processedCount: batch.queue.headCount,", T_QUEUE, PARTIAL_MARK),
    ("батч не записывает счётчик выводов", LOGIC,
     "  next.withdrawalsCount = batch.roots.withdrawalsCount;\n", "", T_ROLLUP, STATE_AFTER_BATCH),
    ("батч не записывает корень выводов", LOGIC,
     "  next.withdrawalsRoot = batch.roots.withdrawalsRoot;\n", "", T_ROLLUP, STATE_AFTER_BATCH),
    ("батч не увеличивает свой номер", LOGIC,
     "  next.batchIndex = batch.state.batchIndex + 1;", "  next.batchIndex = batch.state.batchIndex;", T_ROLLUP, STATE_AFTER_BATCH),

    # --- словарь очереди: постановка и уборка ---
    ("уборка трогает необработанные записи", LOGIC,
     "(queue.prunedCount < queue.processedCount)) {", "(queue.prunedCount < queue.headCount)) {", T_QUEUE, PRUNE_MESSAGE),
    ("уборка не ограничена заданным числом записей", LOGIC,
     "  while ((pruned < limit) && (queue.prunedCount < queue.processedCount)) {",
     "  while (queue.prunedCount < queue.processedCount) {", T_QUEUE, PRUNE_MESSAGE),
    ("постановка в очередь ничего не убирает", LOGIC,
     "  pruneQueueItems(mutate state, mutate queue, QUEUE_PRUNE_PER_PUSH);\n", "",
     T_QUEUE, "постановка в очередь убирает до двух записей обработанных элементов и не трогает необработанные"),
    ("предел записей словаря не проверяется", LOGIC,
     "  assert (queue.headCount - queue.prunedCount < MAX_TRACKED_ITEMS) throw RollupErrors.QueueStorageFull;\n", "",
     T_QUEUE, "очередь из maxTrackedItems необработанных элементов больше не растёт; после батча место появляется"),
    ("предел записей считается от отметки обработанного", LOGIC,
     "  assert (queue.headCount - queue.prunedCount < MAX_TRACKED_ITEMS) throw RollupErrors.QueueStorageFull;",
     "  assert (queue.headCount - queue.processedCount < MAX_TRACKED_ITEMS) throw RollupErrors.QueueStorageFull;",
     T_QUEUE, "предел записей считается от счётчика убранных, а не от отметки обработанного"),
    ("в запись словаря идёт не хеш очереди до элемента", LOGIC,
     "QueueEntry { hashBefore: queue.headHash, queuedAt:", "QueueEntry { hashBefore: first, queuedAt:",
     T_QUEUE, "словарь хранит для каждого элемента хеш очереди ДО него и время постановки"),
    ("время постановки элемента не записывается", LOGIC,
     "queuedAt: blockchain.now(), receipt: receipt });", "queuedAt: 0, receipt: receipt });",
     T_ESCAPE, "срок считается от самого старого необработанного элемента"),
    ("запас газа шага депозита меньше измеренного", LOGIC,
     "const DEPOSIT_STEP_GAS: int = 45000", "const DEPOSIT_STEP_GAS: int = 30000", T_QUEUE, DEEP_STEPS),
    ("запас газа шага принудительной транзакции меньше измеренного", LOGIC,
     "const FORCE_TRANSACTION_STEP_GAS: int = 50000", "const FORCE_TRANSACTION_STEP_GAS: int = 35000", T_QUEUE, DEEP_STEPS),

    # --- плата за место в очереди ---
    ("комиссия депозита не сверяется со стоимостью газа шага", LOGIC,
     "  assertFeeCoversGas(DEPOSIT_FEE, DEPOSIT_STEP_GAS);\n", "",
     T_GAS, "депозит отклоняется, когда его комиссия перестаёт покрывать газ шага"),
    ("плата считается от всей очереди, а не от необработанного хвоста", LOGIC,
     "  return min((queue.headCount - queue.processedCount) / QUEUE_FEE_STEP, QUEUE_FEE_MAX_DOUBLINGS);",
     "  return min(queue.headCount / QUEUE_FEE_STEP, QUEUE_FEE_MAX_DOUBLINGS);",
     T_FEE, "окно считается от отметки processed: очередь разбирается батчами, плата падает вместе с хвостом"),
    ("у удвоений платы нет предела", LOGIC,
     "  return min((queue.headCount - queue.processedCount) / QUEUE_FEE_STEP, QUEUE_FEE_MAX_DOUBLINGS);",
     "  return (queue.headCount - queue.processedCount) / QUEUE_FEE_STEP;",
     T_FEE, "плата растёт все сорок удвоений и на этом останавливается"),
    ("плата за место не растёт с длиной хвоста", LOGIC,
     "  return DEPOSIT_FEE << queueFeeDoublings(queue);", "  return DEPOSIT_FEE;",
     T_FEE, "пока необработанных элементов меньше шага, плата базовая; на шаге — удваивается"),
    ("плата за принудительную транзакцию не растёт с ценой газа", LOGIC,
     "  return max(FORCE_TRANSACTION_FEE, calculateGasFee(BASECHAIN, FORCE_TRANSACTION_STEP_GAS));",
     "  return FORCE_TRANSACTION_FEE;",
     T_GAS, "принудительную транзакцию цена газа не запирает: плата растёт вместе с ней"),

    ("плата за принудительную транзакцию не растёт с длиной хвоста", LOGIC,
     "  return forceTransactionFee() << queueFeeDoublings(queue);", "  return forceTransactionFee();",
     T_FEE, "принудительную транзакцию очередь не вытесняет: она только дорожает"),

    # --- депозит ---
    ("депозит принимается до фиксации ключа", LOGIC,
     "  assert (storage.keys.load().vkData != null) throw RollupErrors.KeyNotFinalized;\n  var state = storage.state.load();\n  // В замороженный",
     "  var state = storage.state.load();\n  // В замороженный", T_ATTACKS, NO_KEY_MOCK),
    ("депозит принимается после заморозки", LOGIC,
     "  assert (!state.frozen) throw RollupErrors.RollupFrozen;\n  assertFeeCoversGas", "  assertFeeCoversGas", T_ESCAPE, FROZEN_REFUSES),
    ("согласие вносителя на комиссию не проверяется", LOGIC,
     "  assert (fee <= msg.maxFee) throw RollupErrors.QueueFeeAboveLimit;\n", "",
     T_FEE, "депозит не уменьшается молча: без согласия на новую комиссию он возвращается целиком"),
    ("наименьшая сумма депозита не проверяется", LOGIC,
     "  assert (amount >= MIN_DEPOSIT) throw RollupErrors.DepositTooSmall;\n", "",
     T_ROLLUP, "слишком маленький депозит возвращается отправителю"),
    ("сумма депозита не ограничена 64 битами", LOGIC,
     "  assert (amount < DEPOSIT_AMOUNT_LIMIT) throw RollupErrors.DepositTooLarge;\n", "",
     T_ROLLUP, "сумма на L2 обязана быть меньше 2^64 нанотон: на нанотон меньше — принят, ровно 2^64 — возвращён"),
    ("в хеш очереди идёт приложенная сумма, а не сумма за вычетом комиссии", LOGIC,
     "  pushQueueItem(mutate state, msg.l2Recipient, amount, DepositReceipt { depositor: sender, amount: amount });",
     "  pushQueueItem(mutate state, msg.l2Recipient, valueCoins, DepositReceipt { depositor: sender, amount: amount });",
     T_ROLLUP, DEPOSIT_HASH),

    # --- принудительная транзакция ---
    ("принудительная транзакция принимается до фиксации ключа", LOGIC,
     "  assert (storage.keys.load().vkData != null) throw RollupErrors.KeyNotFinalized;\n  var state = storage.state.load();\n  assert (!state.frozen) throw RollupErrors.RollupFrozen;\n  // Плата растёт",
     "  var state = storage.state.load();\n  assert (!state.frozen) throw RollupErrors.RollupFrozen;\n  // Плата растёт",
     T_ATTACKS, NO_KEY_MOCK),
    ("принудительная транзакция принимается после заморозки", LOGIC,
     "  assert (!state.frozen) throw RollupErrors.RollupFrozen;\n  // Плата растёт", "  // Плата растёт", T_FORCED, FORCED_AFTER_FREEZE),
    ("плата за принудительную транзакцию не проверяется", LOGIC,
     "  assert (valueCoins >= forceTransactionFeeFor(state.queue.load())) throw RollupErrors.NotEnoughValue;\n", "",
     T_FORCED, "берёт плату и не принимает транзакцию без неё"),
    ("длина принудительной транзакции в байтах не ограничена", LOGIC,
     "  assert (totalBits(parts) <= MAX_FORCED_TX_BYTES * 8) throw RollupErrors.MalformedForcedTransaction;\n", "",
     T_FORCED, "длина в байтах: ровно предел принят при любой нарезке, на байт больше — отказ"),
    ("предел длины принудительной транзакции — на байт больше", LOGIC,
     "const MAX_FORCED_TX_BYTES: int = 256", "const MAX_FORCED_TX_BYTES: int = 257",
     T_FORCED, "длина в байтах: ровно предел принят при любой нарезке, на байт больше — отказ"),
    ("число ячеек принудительной транзакции не ограничено пределом контракта", LOGIC,
     "  val parts = byteParts(msg.l2Transaction, MAX_FORCED_TX_CELLS, RollupErrors.MalformedForcedTransaction as int);",
     "  val parts = byteParts(msg.l2Transaction, 200, RollupErrors.MalformedForcedTransaction as int);",
     T_FORCED, "«змейка» из одной ячейки, из предельного числа и на одну больше: предел ячеек — у контракта"),
    ("принудительная транзакция встаёт в очередь без метки", LOGIC,
     "  pushQueueItem(mutate state, FORCED_TRANSACTION_MARKER, keccak256OfParts(parts), null);",
     "  pushQueueItem(mutate state, 0, keccak256OfParts(parts), null);",
     T_FORCED, "элемент очереди — keccak-256 байтов транзакции под меткой: спутать с депозитом нельзя"),

    # --- форма «змейки» принудительной транзакции (bytes.tolk) ---
    ("экзотическая ячейка в «змейке» читается как обычная", BYTES,
     "    assert (!isExotic) throw errorCode;\n", "",
     T_FORCED, "экзотическая ячейка — отказ: байты обязаны лежать в самом сообщении"),
    ("нецелое число байт в ячейке «змейки» допустимо", BYTES,
     "    assert (bits % 8 == 0) throw errorCode;\n", "",
     T_FORCED, "нецелое число байт — отказ, в первой ячейке и в любой следующей"),
    ("число ячеек «змейки» не ограничено", BYTES,
     "    assert (parts.size() <= maxParts) throw errorCode;\n", "",
     T_FORCED, "«змейка» из одной ячейки, из предельного числа и на одну больше: предел ячеек — у контракта"),
    ("вторая ссылка у ячейки «змейки» допустима", BYTES,
     "    assert (refs <= 1) throw errorCode;\n", "",
     T_FORCED, "две ссылки у ячейки — отказ: продолжение было бы неоднозначным"),
    ("длина «змейки» — длина последней ячейки, а не сумма", BYTES,
     "    bits += parts.get(index).remainingBitsCount();", "    bits = parts.get(index).remainingBitsCount();",
     T_FORCED, BYTE_LENGTH),
    ("длина «змейки» всегда ноль", BYTES, "  return bits;\n}", "  return 0 * bits;\n}", T_FORCED, BYTE_LENGTH),

    # --- нуллификатор ---
    ("нуллификатор принимает заявку от кого угодно", NULLIFIER,
     "      assert (inMsg.senderAddress == storage.rollup) throw NullifierErrors.NotRollup;\n", "",
     T_ROLLUP, "нуллификатор принимает заявки только от своего rollup"),
    ("нуллификатор подтверждает заявку повторно", NULLIFIER,
     "      assert (!storage.claimed) throw NullifierErrors.AlreadyClaimed;\n", "",
     T_ROLLUP, "повторный вывод того же листа не выплачивается"),
    ("нуллификатор помечает заявку при любой сумме монет", NULLIFIER,
     "      assert (inMsg.valueCoins >= nullifierMinValue()) throw NullifierErrors.NotEnoughValue;\n", "",
     T_PAYOUT, "нуллификатор не помечает заявку, если монет не хватит довести цепочку до конца"),

    # --- вывод и выплата ---
    ("отсутствие записи о долге — не свой код отказа", LOGIC,
     "  assert (entry.isFound) throw RollupErrors.NothingOwed;\n", "", T_PAYOUT, DEBT_ONCE),
    ("минимум монет на вывод не проверяется", LOGIC,
     "  assert (valueCoins >= withdrawMinValue()) throw RollupErrors.NotEnoughValue;\n", "",
     T_ROLLUP, "требует достаточно монет на цепочку сообщений"),
    ("получатель вывода вне basechain допустим", LOGIC,
     "  assert (workchain == BASECHAIN) throw RollupErrors.WrongRecipient;\n  assert (withdrawalRoot", "  assert (withdrawalRoot",
     T_ROLLUP, WITHDRAW_TAMPER),
    ("доказательство вывода не сверяется с корнем", LOGIC,
     "  assert (withdrawalRoot(msg.leafIndex, recipientHash, msg.amount, msg.merkleProof) == state.withdrawalsRoot)\n    throw RollupErrors.WrongMerkleProof;\n",
     "", T_ROLLUP, WITHDRAW_TAMPER),
    ("хвост после доказательства вывода не проверяется", LOGIC,
     "  assert ((siblings.remainingBitsCount() == 0) && (siblings.remainingRefsCount() == 0)) throw RollupErrors.WrongMerkleProof;\n", "",
     T_ROLLUP, WITHDRAW_TAMPER),
    ("лишняя ссылка в хвосте доказательства вывода допустима", LOGIC,
     "  assert ((siblings.remainingBitsCount() == 0) && (siblings.remainingRefsCount() == 0)) throw RollupErrors.WrongMerkleProof;",
     "  assert (siblings.remainingBitsCount() == 0) throw RollupErrors.WrongMerkleProof;", T_ROLLUP, WITHDRAW_TAMPER),
    ("сторона соседа в дереве выводов не зависит от номера листа", LOGIC,
     "    val pair = (position & 1) == 0\n", "    val pair = true\n", T_ROLLUP, "разные листья выводятся независимо"),
    ("вывод начинается, даже если платить нечем", LOGIC,
     "  assertCanPay(msg.amount, valueCoins);\n\n  // Двойной вывод", "\n  // Двойной вывод",
     T_ATTACKS, "вывод не помечается использованным, если контракту нечем платить"),
    ("ранняя проверка баланса считает монеты самого сообщения", LOGIC,
     "  return contract.getOriginalBalance() - passingThrough >= amount + payoutOverhead();",
     "  return contract.getOriginalBalance() >= amount + payoutOverhead();",
     T_PAYOUT, "ранняя проверка баланса не считает монеты самого сообщения"),
    ("выплата трогает запас на хранение", LOGIC,
     "  return PAYOUT_RESERVE\n    + calculateGasFee(BASECHAIN, PAYOUT_STEP_GAS)", "  return calculateGasFee(BASECHAIN, PAYOUT_STEP_GAS)",
     T_PAYOUT, "граница «платить или записать долг»: запас сверх суммы выплаты не тратится"),
    ("минимум вывода не включает долю нуллификатора", LOGIC,
     "    + calculateForwardFee(BASECHAIN, CLAIM_MESSAGE_BITS, CLAIM_MESSAGE_CELLS)\n    + nullifierMinValue();",
     "    + calculateForwardFee(BASECHAIN, CLAIM_MESSAGE_BITS, CLAIM_MESSAGE_CELLS);",
     T_PAYOUT, "минимума хватает на всю цепочку вывода, а нанотоной меньше — отказ до пометки"),
    ("подтверждение выплаты принимается от кого угодно", LOGIC,
     "  assert (nullifierDeployment(storage.nullifierCode, msg.key).addressMatches(sender)) throw RollupErrors.NotNullifier;\n", "",
     T_ROLLUP, "подтверждение не от нуллификатора не приводит к выплате"),
    ("при нехватке баланса долг не записывается: выплата отправляется вслепую", LOGIC,
     "  if (canPay(msg.amount, 0)) {\n    sendPayout(msg.recipient, msg.amount);", "  if (true) {\n    sendPayout(msg.recipient, msg.amount);",
     T_PAYOUT, "первая выплачена, вторая записана долгом; пометки стоят у обеих"),
    ("долг выплачивается, даже если денег нет", LOGIC,
     "  assert (canPay(debt.amount, 0)) throw RollupErrors.InsufficientFunds;\n  storage.state = state.toCell();\n  storage.save();\n  sendPayout(debt.recipient, debt.amount);",
     "  storage.state = state.toCell();\n  storage.save();\n  sendPayout(debt.recipient, debt.amount);",
     T_PROOF, "шаг выплаты на худшем остатке монет: при нехватке баланса пишет долг, PayOwed его выплачивает"),
    ("запись о выплаченном долге не удаляется", LOGIC,
     "  val entry = state.owed.deleteAndGetDeleted(msg.key);", "  val entry = state.owed.get(msg.key);",
     T_PAYOUT, "долг выплачивается, когда деньги появились: ровно один раз и только записанному получателю"),

    # --- загрузка и фиксация ключа (настоящий контракт) ---
    ("части ключа загружает кто угодно", LOGIC,
     "  assert (sender == storage.owner) throw RollupErrors.NotOwner;\n  var keys = storage.keys.load();\n  assert (keys.vkData == null) throw RollupErrors.KeyAlreadyFinalized;\n  assert (isKeySlotValid",
     "  var keys = storage.keys.load();\n  assert (keys.vkData == null) throw RollupErrors.KeyAlreadyFinalized;\n  assert (isKeySlotValid",
     T_KEYS, OWNER_ONLY),
    ("части ключа загружаются и после фиксации", LOGIC,
     "  assert (keys.vkData == null) throw RollupErrors.KeyAlreadyFinalized;\n  assert (isKeySlotValid", "  assert (isKeySlotValid",
     T_KEYS, KEY_IMMUTABLE),
    ("номер части ключа не проверяется", LOGIC,
     "  assert (isKeySlotValid(msg.slot)) throw KEY_ERROR_BAD_PART;\n", "",
     T_KEYS, "часть с номером вне раскладки ключа не принимается"),
    ("ключ фиксирует кто угодно", LOGIC,
     "  assert (sender == storage.owner) throw RollupErrors.NotOwner;\n  var keys = storage.keys.load();\n  assert (keys.vkData == null) throw RollupErrors.KeyAlreadyFinalized;\n  assert (!storage.state.load().frozen)",
     "  var keys = storage.keys.load();\n  assert (keys.vkData == null) throw RollupErrors.KeyAlreadyFinalized;\n  assert (!storage.state.load().frozen)",
     T_KEYS, OWNER_ONLY),
    ("ключ можно зафиксировать повторно", LOGIC,
     "  assert (keys.vkData == null) throw RollupErrors.KeyAlreadyFinalized;\n  assert (!storage.state.load().frozen) throw RollupErrors.RollupFrozen;",
     "  assert (!storage.state.load().frozen) throw RollupErrors.RollupFrozen;", T_KEYS, KEY_IMMUTABLE),
    ("ключ фиксируется в замороженном контракте", LOGIC,
     "  assert (!storage.state.load().frozen) throw RollupErrors.RollupFrozen;\n  // Слишком короткий", "  // Слишком короткий",
     T_KEYS, "в замороженном контракте ключ не фиксируется"),
    ("срок заморозки короче наименьшего допустим", LOGIC,
     "  assert (storage.escapeTimeout >= MIN_ESCAPE_TIMEOUT) throw RollupErrors.BadDeployment;\n", "",
     T_GENESIS, "срок заморозки меньше наименьшего — ключ не фиксируется; ровно наименьший — годится"),
    ("возраст блока меньше получаса допустим", LOGIC,
     "  assert ((storage.maxBlockAge >= MIN_MAX_BLOCK_AGE) && (storage.maxBlockAge <= storage.escapeTimeout))",
     "  assert (storage.maxBlockAge <= storage.escapeTimeout)", T_GENESIS, BLOCK_AGE),
    ("возраст блока больше срока заморозки допустим", LOGIC,
     "  assert ((storage.maxBlockAge >= MIN_MAX_BLOCK_AGE) && (storage.maxBlockAge <= storage.escapeTimeout))",
     "  assert (storage.maxBlockAge >= MIN_MAX_BLOCK_AGE)", T_GENESIS, BLOCK_AGE),
    ("начальное состояние при фиксации ключа не сверяется", LOGIC,
     "  assertCanonicalGenesis(storage.state.load());\n", "", T_GENESIS, "генезис не тот — ключ не фиксируется"),
    ("ключ со второй оконной таблицей фиксируется", LOGIC,
     "  assert (msg.table1Parts == 0) throw KEY_ERROR_BAD_PART;\n", "",
     T_KEYS, "ключ со второй оконной таблицей не фиксируется: проверить её было бы нечем"),
    ("точка IC0 ключа не проверяется", LOGIC,
     "  assert (g1IsValid(msg.ic0x, msg.ic0y)) throw RollupErrors.BadKeyPoint;\n", "",
     T_KEYS, "IC0 ключа — точка на кривой: иначе код 7324"),

    # --- канонический генезис: каждое условие ---
    ("генезис: номер батча не сверяется", LOGIC,
     "    (state.batchIndex == 0)\n      && (state.stateRoot == GENESIS_HASH)", "    (state.stateRoot == GENESIS_HASH)",
     T_GENESIS, planted("номер батча не ноль")),
    ("генезис: слово состояния не сверяется с константой", LOGIC,
     "      && (state.stateRoot == GENESIS_HASH)\n", "", T_GENESIS, "генезис не тот — ключ не фиксируется"),
    ("генезис: корень выводов не сверяется", LOGIC,
     "      && (state.withdrawalsRoot == 0)\n", "", T_GENESIS, planted("ненулевой корень выводов")),
    ("генезис: счётчик выводов не сверяется", LOGIC,
     "      && (state.withdrawalsCount == 0)\n", "", T_GENESIS, planted("ненулевой счётчик выводов")),
    ("генезис: число элементов очереди не сверяется", LOGIC,
     "      && (queue.headCount == 0)\n", "", T_GENESIS, planted("в очереди уже есть элементы")),
    ("генезис: хеш очереди не сверяется", LOGIC,
     "      && (queue.headHash == 0)\n", "", T_GENESIS, planted("хеш очереди не ноль")),
    ("генезис: отметка обработанного не сверяется", LOGIC,
     "      && (queue.processedCount == 0)\n", "", T_GENESIS, planted("отметка обработанного не ноль")),
    ("генезис: хеш обработанного не сверяется", LOGIC,
     "      && (queue.processedHash == 0)\n", "", T_GENESIS, planted("хеш обработанного не ноль")),
    ("генезис: счётчик убранных записей не сверяется", LOGIC,
     "      && (queue.prunedCount == 0)\n", "", T_GENESIS, planted("счётчик убранных записей не ноль")),
    ("генезис: пустота словаря очереди не сверяется", LOGIC,
     "      && state.queueItems.isEmpty()\n", "", T_GENESIS, planted("в словаре очереди есть запись")),
    ("генезис: пустота словаря данных батчей не сверяется", LOGIC,
     "      && state.pendingData.isEmpty()\n", "", T_GENESIS, planted("в словаре данных батчей есть запись")),
    ("генезис: пустота словаря долгов не сверяется", LOGIC,
     "      && state.owed.isEmpty()\n", "", T_GENESIS, planted("в словаре долгов есть запись")),

    # --- заморозка ---
    ("пустую очередь можно заморозить", ESCAPE,
     "  assert ((oldest != 0) && (blockchain.now() - oldest > storage.escapeTimeout)) throw RollupErrors.EscapeNotDue;",
     "  assert (blockchain.now() - oldest > storage.escapeTimeout) throw RollupErrors.EscapeNotDue;",
     T_ESCAPE, "без необработанных элементов заморозить нельзя, сколько бы ни прошло времени"),
    ("заморозка не ждёт срока", ESCAPE,
     "  assert ((oldest != 0) && (blockchain.now() - oldest > storage.escapeTimeout)) throw RollupErrors.EscapeNotDue;",
     "  assert (oldest != 0) throw RollupErrors.EscapeNotDue;",
     T_ESCAPE, "срок считается от самого старого необработанного элемента"),
    ("заморозка возможна секундой раньше", ESCAPE,
     "(blockchain.now() - oldest > storage.escapeTimeout)", "(blockchain.now() - oldest >= storage.escapeTimeout)",
     T_FORCED, "цензура ведёт к заморозке: необработанная транзакция запускает срок"),
    ("обработанная целиком очередь не даёт нулевого срока", ESCAPE,
     "  if (queue.processedCount == queue.headCount) {\n    return 0;", "  if (false) {\n    return 0;",
     T_ESCAPE, EMPTY_NOT_FROZEN),
    ("срок заморозки считается от самого нового элемента", ESCAPE,
     "  val oldest = state.queueItems.get(queue.processedCount + 1);", "  val oldest = state.queueItems.get(queue.headCount);",
     T_ESCAPE, "срок считается от самого старого необработанного элемента"),
    ("необработанный элемент без записи молча считается обработанным", ESCAPE,
     "    assert (state.frozen) throw RollupErrors.QueueEntryMissing;\n", "",
     T_ESCAPE, "необработанный элемент без записи в словаре — отказ кодом 7334, а не «срок не вышел»"),
    ("после возврата самого старого депозита состояние заморозки не читается", ESCAPE,
     "    assert (state.frozen) throw RollupErrors.QueueEntryMissing;", "    assert (false) throw RollupErrors.QueueEntryMissing;",
     T_ESCAPE, REFUND_ONCE),

    # --- возврат депозита ---
    ("депозит возвращается и до заморозки", ESCAPE,
     "  assert (state.frozen) throw RollupErrors.RollupNotFrozen;\n", "", T_ESCAPE, "до заморозки депозит вернуть нельзя"),
    ("обработанный депозит возвращается", ESCAPE,
     "  assert (msg.depositIndex > state.queue.load().processedCount) throw RollupErrors.DepositAlreadyProcessed;\n", "",
     T_ESCAPE, "обработанный депозит вернуть нельзя: он уже на L2"),
    ("отсутствие записи о депозите — не свой код отказа", ESCAPE,
     "  assert (entry.isFound) throw RollupErrors.NoSuchDeposit;\n", "", T_ESCAPE, REFUND_ONCE),
    ("запись о возвращённом депозите не удаляется", ESCAPE,
     "  val entry = state.queueItems.deleteAndGetDeleted(msg.depositIndex);", "  val entry = state.queueItems.get(msg.depositIndex);",
     T_ESCAPE, REFUND_ONCE),
    ("возврат депозита при пустом контракте теряет квитанцию", ESCAPE,
     "  assert (canPay(receipt.amount, 0)) throw RollupErrors.InsufficientFunds;\n", "",
     T_PAYOUT, "возврат депозита при пустом контракте не теряет квитанцию"),
    ("отсутствие квитанции у принудительной транзакции — не свой код отказа", ESCAPE,
     "  assert (receipt != null) throw RollupErrors.NoSuchDeposit;", "  assert (receipt != null) throw RollupErrors.NothingToExit;",
     T_FORCED, FORCED_AFTER_FREEZE),
    ("возврат идёт на сумму не из квитанции", ESCAPE,
     "  sendPayout(receipt.depositor, receipt.amount);", "  sendPayout(receipt.depositor, receipt.amount + 1);", T_ESCAPE, REFUND_ONCE),

    # --- раскладка хранилища против обёртки ---
    ("в записи очереди время постановки стоит раньше хеша", STORAGE,
     "  hashBefore: uint256\n  /// Когда элемент встал в очередь: от него считается срок заморозки.\n  queuedAt: uint32\n",
     "  queuedAt: uint32\n  hashBefore: uint256\n", T_GENESIS, LAYOUT),
    ("счётчик выводов хранится после номера батча", STORAGE,
     "  withdrawalsCount: uint64\n  batchIndex: uint64\n", "  batchIndex: uint64\n  withdrawalsCount: uint64\n", T_GENESIS, LAYOUT),
    ("счётчик убранных записей хранится перед отметкой обработанного", STORAGE,
     "  processedCount: uint64\n  processedHash: uint256\n  /// Записи словаря queueItems с номерами до этого включительно убраны. Не больше processedCount.\n  prunedCount: uint64\n",
     "  prunedCount: uint64\n  processedCount: uint64\n  processedHash: uint256\n", T_GENESIS, LAYOUT),
    ("признак заморозки хранится перед словарём очереди", STORAGE,
     "  queueItems: map<uint64, QueueEntry>\n  /// Аварийный режим включён: батчи и депозиты не принимаются, остаются выводы,\n  /// возврат необработанных депозитов и выход счетов EVM по доказательству. Необратимо.\n  frozen: bool\n",
     "  frozen: bool\n  queueItems: map<uint64, QueueEntry>\n", T_GENESIS, LAYOUT),
]

# Проверки, чьё снятие поведения не меняет: мутировать их бессмысленно, перечислены для отчёта.
EQUIVALENT = [
    "повторная заморозка (assert !frozen в ActivateEscapeHatch): без проверки повтор записал бы тот же "
    "признак — состояние не меняется, отличается только код отказа повторного сообщения",
    "«предел записей от счётчика убранных» против «от отметки обработанного» на состояниях, достижимых "
    "сообщениями от генезиса: формулы расходятся, только когда неубранных записей больше предела, а "
    "постановка растит словарь, лишь когда мусора в нём нет (тогда счёты совпадают). Мутация в списке "
    "есть и убита — но тестом на ПОДЛОЖЕННОМ состоянии",
    "«ключ можно зафиксировать повторно» (assert vkData == null в FinalizeKey): эквивалентна с точностью до "
    "кода отказа. После фиксации части ключа стёрты, а загрузить новые не даёт отдельная проверка в "
    "UploadKeyPart, поэтому повторная фиксация без этой проверки всё равно отказывает — сборкой ключа из "
    "пустого словаря частей, кодом 7105 вместо 7304. Мутация в списке есть и «убита» только потому, что "
    "тест ждёт точный код",
    "«отсутствие записи о долге / о депозите — не свой код отказа» (NothingOwed, NoSuchDeposit по isFound): "
    "без проверки чтение отсутствующей записи всё равно бросает исключение — меняется только код отказа; "
    "тест ждёт точный код",
    "проверки чтения «змейки» (bytes.tolk) мутируются и в zk/evm-exit-mutation-check.py: там убийцы — "
    "тесты выхода счёта EVM, здесь — тесты формы принудительной транзакции",
]


def run_tests(spec, names):
    """Запускает тесты набора с этими именами и контрольный; возвращает (прошедшие, упавшие, вывод)."""
    command = ["nice", "-n", "15", "npx", "jest", "--verbose", "--runInBand", spec]
    if names is not None:
        command += [CONTROL_SPEC, "-t", "|".join(re.escape(name) + "$" for name in names)]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    output = result.stdout + result.stderr
    passed = {name.strip() for name in re.findall(r"✓ (.+?)(?: \(\d+ ms\))?$", output, re.M)}
    failed = {name.strip() for name in re.findall(r"✕ (.+?)(?: \(\d+ ms\))?$", output, re.M)}
    return result.returncode, passed, failed


def backup_of(source):
    return source.with_suffix(".tolk.orig")


def restore_interrupted() -> bool:
    """Возвращает исходники, оставшиеся от прерванного запуска. False — нужна ручная разборка."""
    for source in SOURCES:
        backup = backup_of(source)
        if not backup.exists():
            continue
        # Копию возвращаем, только если в исходнике лежит она же или она с одной из мутаций
        # этого файла: иначе там чьи-то правки, и затирать их нельзя.
        saved, current = backup.read_text(), source.read_text()
        mutants = [saved.replace(m[2], m[3]) for m in MUTATIONS if m[1] == source]
        if current != saved and current not in mutants:
            print(f"Найдена копия {backup.name}, но исходник — не она и не она с мутацией: разберись вручную.")
            return False
        print(f"Найдена копия {source.name} от прерванного запуска — возвращаю её.")
        source.write_text(saved)
        backup.unlink()
    return True


def baseline(specs) -> bool:
    for spec in specs:
        code, _, failed = run_tests(spec, None)
        if code != 0:
            print(f"{spec} падает и без мутаций:", *sorted(failed), sep="\n  ")
            return False
    return True


def main() -> int:
    args = sys.argv[1:]
    dry = "--dry" in args
    only = args[args.index("--only") + 1] if "--only" in args else None
    if not restore_interrupted():
        return 2
    originals = {source: source.read_text() for source in SOURCES}
    names = [m[0] for m in MUTATIONS]
    if len(set(names)) != len(names):
        print("В списке мутаций повторяются названия.")
        return 2
    unapplied = [m[0] for m in MUTATIONS if originals[m[1]].count(m[2]) != 1]
    if unapplied:
        print("Образец не найден ровно один раз:", *unapplied, sep="\n  ")
        return 2
    if dry:
        print(f"Образцы всех {len(MUTATIONS)} мутаций найдены в исходниках ровно по одному разу.")
        return 0
    selected = [m for m in MUTATIONS if only is None or only in m[0]]
    specs = sorted({m[4] for m in selected} | {CONTROL_SPEC})
    if only is None and not baseline(specs):
        return 2
    lines, bad = [], 0
    # Копии всех файлов лежат рядом весь прогон: это ещё и признак «идёт проверка мутациями»,
    # по которому тесты не пишут замеры в bench.
    for source in SOURCES:
        backup_of(source).write_text(originals[source])
    try:
        for name, source, old, new, spec, expected in selected:
            source.write_text(originals[source].replace(old, new))
            _, passed, failed = run_tests(spec, [expected, CONTROL])
            source.write_text(originals[source])
            if CONTROL not in passed:
                verdict = "НЕ СОБРАЛАСЬ"
            elif expected in failed:
                verdict = "убита"
            elif expected in passed:
                verdict = "ВЫЖИЛА"
            else:
                verdict = "ТЕСТ НЕ НАЙДЕН"
            if verdict != "убита":
                bad += 1
            line = f"{verdict:<13} {name}  [{source.name} → {pathlib.Path(spec).name}: «{expected}»]"
            print(line, flush=True)
            lines.append(line)
    finally:
        for source in SOURCES:
            source.write_text(originals[source])
            backup_of(source).unlink()
    summary = f"Мутаций: {len(selected)}, не убито ожидаемым тестом: {bad}"
    if only is not None:
        print("\n" + summary + " (выборочный прогон: отчёт не записан)")
        return 1 if bad else 0
    if not baseline(specs):
        print("После возврата исходников тесты падают — результатам верить нельзя.")
        return 2
    print("\n" + summary)
    REPORT.write_text(
        f"Проверка тестов rollup-контракта протокола v2 мутациями, {datetime.date.today().isoformat()}\n"
        "Команда: python3 zk/rollup-mutation-check.py\n"
        "Мутируются contracts/rollup/logic.tolk, escape.tolk, storage.tolk, bytes.tolk,\n"
        "contracts/rollup_nullifier.tolk и две проверки точки входа contracts/rollup.tolk. На каждую мутацию запускаются её тест и контрольный (только собирает\n"
        "контракты: падает, лишь если мутант не собрался). «убита» — контрольный прошёл, тест мутации упал.\n"
        "В скобках: файл мутации → набор и тест, который обязан был её убить.\n\n"
        + "\n".join(lines)
        + "\n\nОговорки — где снятие проверки поведения не меняет либо вердикт слабый:\n"
        + "\n".join(f"  - {item}" for item in EQUIVALENT)
        + "\n\n" + summary + "\n"
    )
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
