// Нуллификатор вывода: один крошечный контракт на каждый лист дерева выводов.
// Его адрес однозначно определяется адресом rollup'а и номером листа, а хранит он
// единственный флаг «уже выплачено». Так rollup-контракту не нужен растущий словарь.
//
// Повторная заявка бросает исключение и возвращается в rollup bounce'ом — к этому
// моменту rollup ещё ничего не выплатил, так что откатывать нечего.
import "rollup/messages"
import "rollup/nullifier_types"

contract RollupNullifier {
  description: "Stage 1 draft: one-shot withdrawal nullifier"
  storage: NullifierStorage
  incomingMessages: NullifierClaim
}

enum NullifierErrors {
  NotRollup = 7200,
  AlreadyClaimed = 7201,
  UnknownMessage = 7202,
}

fun onInternalMessage(inMsg: InMessage) {
  val msg = lazy NullifierClaim.fromSlice(inMsg.body);

  match (msg) {
    NullifierClaim => {
      var storage = NullifierStorage.fromCell(contract.getData());
      assert (inMsg.senderAddress == storage.rollup) throw NullifierErrors.NotRollup;
      assert (!storage.claimed) throw NullifierErrors.AlreadyClaimed;
      storage.claimed = true;
      contract.setData(storage.toCell());

      // Весь остаток приложенных монет возвращается в rollup вместе с подтверждением.
      val confirmation = createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: storage.rollup,
        body: NullifierClaimed {
          queryId: msg.queryId,
          leafIndex: storage.leafIndex,
          recipient: msg.recipient,
          amount: msg.amount,
        },
      });
      confirmation.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
    }
    else => {
      assert (inMsg.body.isEmpty()) throw NullifierErrors.UnknownMessage;
    }
  }
}

get fun isClaimed(): bool {
  return NullifierStorage.fromCell(contract.getData()).claimed;
}
