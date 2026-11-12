// ЧЕРНОВИК (этап 0): скелет rollup-контракта. Ни один обработчик не реализован —
// файл существует, чтобы компилятор Tolk проверял схему сообщений и хранилища
// из ARCHITECTURE.md (в частности, что структуры помещаются в ячейки).
// НЕ ДЕПЛОИТЬ.
import "rollup/storage"
import "rollup/messages"

contract RollupSkeleton {
  description: "Stage 0 draft: rollup contract interface, no logic"
  storage: RollupStorage
  incomingMessages: RollupMessage
}

enum RollupErrors {
  NotImplemented = 1000,
  UnknownMessage = 1001,
}

fun onInternalMessage(in: InMessage) {
  val msg = lazy RollupMessage.fromSlice(in.body);

  match (msg) {
    SubmitBatch => throw RollupErrors.NotImplemented,
    DepositTon => throw RollupErrors.NotImplemented,
    JettonTransferNotification => throw RollupErrors.NotImplemented,
    Withdraw => throw RollupErrors.NotImplemented,
    NullifierClaimed => throw RollupErrors.NotImplemented,
    ForceTransaction => throw RollupErrors.NotImplemented,
    ActivateEscapeHatch => throw RollupErrors.NotImplemented,
    ForceExit => throw RollupErrors.NotImplemented,
    CancelQueuedDeposit => throw RollupErrors.NotImplemented,
    else => {
      // Пустое тело — простое пополнение баланса контракта.
      assert (in.body.isEmpty()) throw RollupErrors.UnknownMessage;
    }
  }
}

fun onBouncedMessage(in: InMessageBounced) {
  // Здесь будут: возврат пометки нуллификатора при неудачной выплате jetton'ов
  // и игнорирование bounce от NullifierClaim (повторный вывод). См. ARCHITECTURE.md.
}

get fun rollupState(): RollupStorage {
  return RollupStorage.load();
}
