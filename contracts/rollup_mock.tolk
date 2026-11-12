// ТОЛЬКО ДЛЯ ТЕСТОВ: тот же rollup-контракт, но проверка пруфа заменена заглушкой.
// Нужен, чтобы проверять логику (очередь депозитов, выводы, bounce) на произвольных
// данных: настоящий пруф можно получить только для заранее известных значений.
// Сквозные тесты с настоящей проверкой идут на contracts/rollup.tolk.
import "rollup/storage"
import "rollup/messages"
import "rollup/logic"
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
      val state = storage.state.load();
      val queue = state.queue.load();
      val roots = msg.roots.load();
      // ЗАГЛУШКА: пруф считается верным, если его первое число равно 1.
      val ok = msg.proof.load().ax == 1;
      assert (ok) throw RollupErrors.WrongProof;
      applyBatch(mutate storage, state, queue, roots);
    }
    DepositTon => {
      handleDeposit(inMsg.valueCoins, msg);
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
    else => {
      // Пустое тело — пополнение баланса.
      assert (inMsg.body.isEmpty()) throw RollupErrors.UnknownMessage;
    }
  }
}

fun onBouncedMessage(inMsg: InMessageBounced) {
  // Единственное сообщение с bounce — заявка в нуллификатор. Она возвращается, если
  // вывод уже был использован. К этому моменту rollup ничего не выплатил и ничего
  // не записал, поэтому откатывать нечего: остаток монет просто остаётся на балансе.
}

/// (корень состояния, корень выводов, номер батча)
get fun rollupState(): (int, int, int) {
  return rollupStateView();
}

/// Очередь депозитов: поставлено, цель следующего батча, обработано — счётчик и хеш для каждого.
get fun depositQueue(): DepositQueue {
  return depositQueueView();
}

/// Первый публичный вход, который контракт потребует от следующего батча с такими корнями.
get fun expectedPublicInput(newStateRoot: int, batchHash: int, withdrawalsRoot: int): int {
  val state = RollupStorage.load().state.load();
  return batchDigest(state, state.queue.load(), BatchRoots {
    newStateRoot: newStateRoot,
    batchHash: batchHash,
    withdrawalsRoot: withdrawalsRoot,
  });
}

/// Хеш зафиксированного ключа верификации; 0, пока ключ не зафиксирован.
get fun keyHash(): int {
  val storage = RollupStorage.load();
  if (storage.vkData == null) {
    return 0;
  }
  return storage.vkData!.hash();
}

get fun nullifierAddress(leafIndex: int): address {
  return nullifierDeployment(RollupStorage.load().nullifierCode, leafIndex).calculateAddress();
}
