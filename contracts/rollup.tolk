// Rollup-контракт на TON, минимальная версия: корень состояния L2 меняется только
// батчем с верным Groth16-пруфом на BN254 (проверка — contracts/bn254/hinted.tolk),
// депозиты TON встают в очередь с принудительным включением, выводы идут по
// Merkle-доказательству через контракт-нуллификатор.
//
// НЕ ДЛЯ ПРОДАКШЕНА. Код не проходил аудит, нет jetton'ов, аварийного выхода,
// управления обновлениями и решения по data availability. Только Sandbox и testnet.
import "rollup/storage"
import "rollup/messages"
import "rollup/logic"
import "bn254/verifier_api"

contract Rollup {
  description: "Stage 1 draft: ZK-rollup contract with BN254 Groth16 verification"
  storage: RollupStorage
  incomingMessages: RollupMessage
}

fun onInternalMessage(inMsg: InMessage) {
  val msg = lazy RollupMessage.fromSlice(inMsg.body);

  match (msg) {
    SubmitBatch => {
      var storage = RollupStorage.load();
      assert (inMsg.senderAddress == storage.sequencer) throw RollupErrors.NotSequencer;
      assert (storage.vkData != null) throw RollupErrors.KeyNotFinalized;
      val state = storage.state.load();
      val queue = state.queue.load();
      val roots = msg.roots.load();
      val ok = verifyBn254Proof(msg.proof, batchDigest(state, queue, roots), msg.nonce, storage.vkData!, msg.hints);
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
