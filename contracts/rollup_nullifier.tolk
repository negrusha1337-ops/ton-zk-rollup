// Нуллификатор: один крошечный контракт на каждый лист дерева выводов и на каждый счёт
// L2, вышедший аварийно. Его адрес однозначно определяется адресом rollup'а и ключом, а хранит он
// единственный флаг «уже выплачено». Так rollup-контракту не нужен растущий словарь.
//
// Повторная заявка бросает исключение и возвращается в rollup bounce'ом — к этому
// моменту rollup ещё ничего не выплатил, так что откатывать нечего.
//
// Пометка необратима, поэтому ставится, только если приложенных монет хватит довести
// цепочку до конца (nullifierMinValue в rollup/nullifier_types.tolk).
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
  NotEnoughValue = 7203,
}

fun onInternalMessage(inMsg: InMessage) {
  val msg = lazy NullifierClaim.fromSlice(inMsg.body);

  match (msg) {
    NullifierClaim => {
      var storage = NullifierStorage.fromCell(contract.getData());
      assert (inMsg.senderAddress == storage.rollup) throw NullifierErrors.NotRollup;
      assert (!storage.claimed) throw NullifierErrors.AlreadyClaimed;
      assert (inMsg.valueCoins >= nullifierMinValue()) throw NullifierErrors.NotEnoughValue;
      storage.claimed = true;
      contract.setData(storage.toCell());

      // Весь остаток приложенных монет возвращается в rollup вместе с подтверждением.
      val confirmation = createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: storage.rollup,
        body: NullifierClaimed {
          queryId: msg.queryId,
          key: storage.key,
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

/// Минимум монет, с которым нуллификатор соглашается пометить заявку (при текущих ценах сети).
get fun minimumValue(): coins {
  return nullifierMinValue();
}

get fun isClaimed(): bool {
  return NullifierStorage.fromCell(contract.getData()).claimed;
}
