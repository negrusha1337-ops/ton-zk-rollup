// ТОЛЬКО ДЛЯ ТЕСТОВ: тот же rollup-контракт, но проверка пруфа заменена заглушкой.
// Нужен, чтобы проверять логику (очередь депозитов, выводы, заморозку, bounce) на
// произвольных данных: настоящий пруф можно получить только для заранее известных
// значений. Сквозные тесты с настоящей проверкой идут на contracts/rollup.tolk.
import "rollup/storage"
import "rollup/messages"
import "rollup/logic"
import "rollup/escape"
import "bn254/verifier_api"

contract RollupMock {
  description: "TEST ONLY: rollup logic with a stubbed proof check"
  storage: RollupStorage
  incomingMessages: RollupMessage
}

fun onInternalMessage(inMsg: InMessage) {
  val msg = lazy RollupMessage.fromSlice(inMsg.body);

  match (msg) {
    SubmitBatch => {
      var storage = RollupStorage.load();
      assert (inMsg.senderAddress == storage.sequencer) throw RollupErrors.NotSequencer;
      // Двойнику ключ не нужен: пруф заменён заглушкой.
      var state = storage.state.load();
      assert (!state.frozen) throw RollupErrors.RollupFrozen;
      val queue = state.queue.load();
      val roots = msg.roots.load();
      // ЗАГЛУШКА: пруф считается верным, если его первое число равно 1.
      val ok = msg.proof.load().ax == 1;
      assert (ok) throw RollupErrors.WrongProof;
      takeBatchData(mutate state);
      applyBatch(mutate storage, state, queue, roots);
    }
    PublishData => {
      handlePublishData(inMsg.senderAddress, msg);
    }
    DepositTon => {
      handleDeposit(inMsg.senderAddress, inMsg.valueCoins, msg);
    }
    Withdraw => {
      handleWithdraw(inMsg.valueCoins, msg);
    }
    NullifierClaimed => {
      handleNullifierClaimed(inMsg.senderAddress, msg);
    }
    UploadKeyPart => {
      handleUploadKeyPart(inMsg.senderAddress, msg);
    }
    FinalizeKey => {
      handleFinalizeKey(inMsg.senderAddress, msg);
    }
    SetExitKey => {
      handleSetExitKey(inMsg.senderAddress, msg);
    }
    ActivateEscapeHatch => {
      handleActivateEscapeHatch();
    }
    ForceExit => {
      val storage = RollupStorage.load();
      val claim = msg.claim.load();
      val digest = prepareForceExit(inMsg.valueCoins, storage, claim);
      // ЗАГЛУШКА: пруф считается верным, если его первое число равно 1.
      val ok = (msg.proof.load().ax == 1) && (digest != 0);
      assert (ok) throw RollupErrors.WrongProof;
      completeForceExit(storage, msg.queryId, claim);
    }
    CancelDeposit => {
      handleCancelDeposit(msg);
    }
    PruneDepositReceipts => {
      handlePruneDepositReceipts(msg);
    }
    else => {
      // Пустое тело — пополнение баланса.
      assert (inMsg.body.isEmpty()) throw RollupErrors.UnknownMessage;
    }
  }
}

fun onBouncedMessage(inMsg: InMessageBounced) {
  // С bounce уходят только заявки в нуллификатор. Они возвращаются, если вывод или
  // аварийный выход уже был использован. К этому моменту rollup ничего не выплатил и
  // ничего не записал, поэтому откатывать нечего: остаток монет остаётся на балансе.
}

/// (корень состояния, корень выводов, номер батча)
get fun rollupState(): (int, int, int) {
  return rollupStateView();
}

/// Очередь депозитов: поставлено, цель следующего батча, обработано — счётчик и хеш для каждого.
get fun depositQueue(): DepositQueue {
  return depositQueueView();
}

/// Первый публичный вход, который контракт потребует от следующего батча с такими корнями
/// (при уже опубликованных для него данных).
get fun expectedPublicInput(newStateRoot: int, withdrawalsRoot: int): int {
  return expectedPublicInputView(newStateRoot, withdrawalsRoot);
}

/// Накопительный хеш данных, опубликованных для батча с этим номером; 0, если их нет.
get fun batchDataHash(batchIndex: int): int {
  return batchDataHashOf(RollupStorage.load().state.load().pendingData, batchIndex);
}

/// Идентификатор rollup'а, под который должны быть построены пруфы и подписаны транзакции.
get fun chainId(): int {
  return RollupStorage.load().chainId;
}

/// Хеш зафиксированного ключа верификации программы батчей; 0, пока ключ не зафиксирован.
get fun keyHash(): int {
  val keys = RollupStorage.load().keys.load();
  if (keys.vkData == null) {
    return 0;
  }
  return keys.vkData!.hash();
}

/// Хеш ключа верификации программы выхода; 0, пока ключ не зафиксирован.
get fun exitKeyHash(): int {
  return exitKeyHashView();
}

get fun nullifierAddress(leafIndex: int): address {
  return nullifierDeployment(RollupStorage.load().nullifierCode, leafIndex).calculateAddress();
}

/// Адрес нуллификатора аварийного выхода для счёта L2.
get fun exitNullifierAddress(l2Account: int): address {
  return nullifierDeployment(RollupStorage.load().nullifierCode, exitNullifierKey(l2Account)).calculateAddress();
}

/// (заморожен ли, когда встал самый старый необработанный депозит или 0, срок в секундах)
get fun escapeState(): (bool, int, int) {
  return escapeStateView();
}

/// Публичный вход, который контракт потребует от пруфа выхода с такой заявкой.
get fun expectedExitInput(l2Account: int, amount: int, recipientHash: int): int {
  return expectedExitInputView(l2Account, amount, recipientHash);
}

/// (вноситель, сумма) по номеру депозита; сумма 0, если квитанции нет.
get fun depositReceipt(depositIndex: int): (address?, int) {
  return depositReceiptView(depositIndex);
}
