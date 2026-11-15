// Rollup-контракт на TON, протокол версии 2 (PROTOCOL-V2.md), только EVM: слово состояния L2
// — хеш заголовка блока — меняется только батчем с верным Groth16-пруфом на BN254 (проверка —
// contracts/bn254/hinted.tolk), депозиты TON и принудительные транзакции EVM встают в общую
// очередь L1, выводы идут по Merkle-доказательству через контракт-нуллификатор. Данные батчей
// публикуются сообщениями PublishData (DA.md). Если секвенсор перестал обрабатывать очередь,
// rollup замораживается: необработанные депозиты возвращаются, обычные счета EVM выходят по
// доказательству счёта без пруфа zkVM (rollup/escape.tolk, rollup/evm_exit.tolk).
//
// НЕ ДЛЯ ПРОДАКШЕНА. Код не проходил аудит, нет jetton'ов и управления обновлениями.
// Только Sandbox и testnet.
import "rollup/storage"
import "rollup/messages"
import "rollup/logic"
import "rollup/escape"
import "rollup/evm_exit"
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
      val batch = prepareSubmitBatch(inMsg.senderAddress, msg);
      // Второй вход верификатора — нонс SP1 — равен нулю и свёрнут в ключ.
      val ok = verifyBn254Proof(msg.proof, batch.digest, 0, batch.vkData, msg.hints);
      assert (ok) throw RollupErrors.WrongProof;
      applyBatch(batch);
    }
    PublishData => {
      handlePublishData(inMsg.senderAddress, msg);
    }
    DiscardBatchData => {
      handleDiscardBatchData(inMsg.senderAddress, msg);
    }
    PayOwed => {
      handlePayOwed(msg);
    }
    DepositTon => {
      handleDeposit(inMsg.senderAddress, inMsg.valueCoins, msg);
    }
    ForceTransaction => {
      handleForceTransaction(inMsg.valueCoins, msg);
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
    ActivateEscapeHatch => {
      handleActivateEscapeHatch();
    }
    ForceExitEvm => {
      handleForceExitEvm(inMsg.valueCoins, msg);
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

/// Версия протокола: формат публичных значений, сообщений и хранилища.
get fun protocolVersion(): int {
  return PROTOCOL_VERSION;
}

/// Хеш заголовка генезиса L2, с которым контракт соглашается зафиксировать ключ.
get fun genesisHash(): int {
  return GENESIS_HASH;
}

/// (слово состояния, корень выводов, номер батча, счётчик выводов)
get fun rollupState(): (int, int, int, int) {
  return rollupStateView();
}

/// Очередь L1: поставлено и обработано — счётчик и хеш для каждого; сколько записей убрано.
get fun depositQueue(): DepositQueue {
  return depositQueueView();
}

/// Запись об элементе очереди L1: (есть ли, хеш очереди до элемента, когда встал).
get fun queueItem(index: int): (bool, int, int) {
  return queueItemView(index);
}

/// Пределы очереди L1: (элементов на батч, записей в словаре, ячеек в «змейке» принудительной
/// транзакции, записей, убираемых одной постановкой, предел суммы депозита на L2).
get fun queueLimits(): (int, int, int, int, int) {
  return queueLimitsView();
}

/// Границы времени: (наименьший допустимый maxBlockAge, наименьший допустимый срок заморозки).
get fun timeLimits(): (int, int) {
  return timeLimitsView();
}

/// Первый публичный вход, который контракт потребует от следующего батча с такими значениями
/// (при уже опубликованных для него данных).
get fun expectedPublicInput(
  newStateRoot: int, withdrawalsRoot: int, withdrawalsCount: int, queueProcessedUpTo: int, blockTimestamp: int
): int {
  return expectedPublicInputView(BatchRoots {
    newStateRoot: newStateRoot,
    withdrawalsRoot: withdrawalsRoot,
    withdrawalsCount: withdrawalsCount,
    queueProcessedUpTo: queueProcessedUpTo,
    blockTimestamp: blockTimestamp,
  });
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

get fun nullifierAddress(leafIndex: int): address {
  return nullifierDeployment(RollupStorage.load().nullifierCode, leafIndex).calculateAddress();
}

/// Адрес нуллификатора аварийного выхода для счёта L2.
get fun exitNullifierAddress(l2Account: int): address {
  return nullifierDeployment(RollupStorage.load().nullifierCode, exitNullifierKey(l2Account)).calculateAddress();
}

/// (заморожен ли, когда встал самый старый необработанный элемент очереди или 0, срок в секундах)
get fun escapeState(): (bool, int, int) {
  return escapeStateView();
}

/// (вноситель, сумма) по номеру депозита; сумма 0, если квитанции нет.
get fun depositReceipt(depositIndex: int): (address?, int) {
  return depositReceiptView(depositIndex);
}

/// Параметры развёртывания: (владелец, секвенсор, chainId, срок заморозки, наибольший возраст
/// блока, хеш кода нуллификатора).
get fun deployment(): (address, address, int, int, int, int) {
  return deploymentView();
}

/// (получатель, сумма) долга по ключу нуллификатора; сумма 0, если долга нет.
get fun owedPayout(key: int): (address?, int) {
  return owedPayoutView(key);
}

/// Минимум монет для Withdraw при текущих ценах сети (для ForceExitEvm — evmExitBudget).
get fun minimumValues(): int {
  return withdrawMinValue();
}

/// Запасы газа, из которых считаются пороги, и то, что из них получается в монетах:
/// (газ шага Withdraw, газ шага нуллификатора, газ шага выплаты, монет на шаг выплаты,
/// сколько сверх суммы должно быть на балансе для выплаты). Тесты сверяют измеренный расход
/// с этими значениями, а не со своими копиями констант.
get fun payoutBudgets(): (int, int, int, int, int) {
  return payoutBudgetsView();
}

/// (газ шага депозита, газ постановки принудительной транзакции, плата за неё при текущих ценах).
get fun queueBudgets(): (int, int, int) {
  return queueBudgetsView();
}

/// Плата за место в очереди сейчас: (комиссия депозита, плата за принудительную транзакцию,
/// необработанных элементов в очереди, шаг удвоения).
get fun queueFees(): (int, int, int, int) {
  return queueFeesView();
}

/// (газ шага ForceExitEvm, минимум монет на него при текущих ценах сети). Тест сверяет
/// измеренный расход на глубоком доказательстве с этим запасом, а не со своей копией константы.
get fun evmExitBudget(): (int, int) {
  return (EVM_EXIT_STEP_GAS, evmExitMinValue());
}

/// Хеш согласия, который подписывает владелец счёта EVM для выхода этому получателю.
get fun evmExitConsentHash(recipientHash: int): int {
  val storage = RollupStorage.load();
  return evmExitConsent(storage.chainId, storage.state.load().stateRoot, recipientHash);
}
