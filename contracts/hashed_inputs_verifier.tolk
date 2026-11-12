// Вариант «один публичный вход»: контракт получает четыре 256-битных значения
// rollup'а открытым текстом, сам считает h = sha256(v0 ‖ v1 ‖ v2 ‖ v3) mod 2^253
// и проверяет Groth16-доказательство с единственным публичным входом h.
// Схема (circuits/HashedInputs.circom) считает тот же хеш внутри доказательства.
//
// Это стенд для замера газа, а не rollup-контракт: состояния нет,
// защиты от повторов нет (см. ARCHITECTURE.md).
import "generated/hash_verifier_lib"

contract HashedInputsVerifier {
  description: "Stage 0: Groth16 verifier with a single SHA-256 public input"
  storage: HashedInputsVerifierStorage
  incomingMessages: VerifyHashed
}

struct HashedInputsVerifierStorage {}

/// Скалярное поле BLS12-381 ~ 2^255, поэтому 256-битный хеш обрезается до 253 бит.
const HASH_MASK_253: int = (1 << 253) - 1

/// Вторая половина публичных значений. Вынесена в отдельную ячейку:
/// 4 × 256 = 1024 бита не помещаются в одну ячейку TVM (максимум 1023).
struct BatchCommitments {
  batchHash: uint256
  withdrawalsRoot: uint256
}

struct (0x5a4b0001) VerifyHashed {
  /// Ячейка с тремя ссылками: piA, piB, piC (формат export-ton-verifier).
  proof: cell
  oldStateRoot: uint256
  newStateRoot: uint256
  commitments: Cell<BatchCommitments>
}

/// HASHEXT_SHA256 хеширует конкатенацию нескольких builder'ов, не создавая ячеек.
@pure
fun sha256OfTwoBuilders(first: builder, second: builder, count: int): uint256
  asm "HASHEXT_SHA256"

fun hashRollupValues(oldStateRoot: uint256, newStateRoot: uint256, batchHash: uint256, withdrawalsRoot: uint256): int {
  val first = beginCell().storeUint(oldStateRoot, 256).storeUint(newStateRoot, 256);
  val second = beginCell().storeUint(batchHash, 256).storeUint(withdrawalsRoot, 256);
  return sha256OfTwoBuilders(first, second, 2) & HASH_MASK_253;
}

fun verifyHashed(msg: VerifyHashed): bool {
  val (piA, piB, piC) = HashVerifier.loadCheckedProof(msg.proof);
  val commitments = msg.commitments.load();
  val publicInput = hashRollupValues(
    msg.oldStateRoot, msg.newStateRoot, commitments.batchHash, commitments.withdrawalsRoot
  );
  val pubInputs: array<int> = [publicInput];
  return HashVerifier.create().verify(piA, piB, piC, pubInputs);
}

fun onInternalMessage(inMsg: InMessage) {
  val msg = lazy VerifyHashed.fromSlice(inMsg.body);

  match (msg) {
    VerifyHashed => {
      assert (inMsg.valueCoins >= HashVerifierMinVerifyValue) throw HashVerifierErrors.NotEnoughValue;
      assert (verifyHashed(msg)) throw HashVerifierErrors.WrongProof;
    }
    else => {
      assert (inMsg.body.isEmpty()) throw HashVerifierErrors.InvalidInputs;
    }
  }
}

/// Только хеширование — чтобы отдельно измерить его стоимость и сверить с JS.
get fun hashInputs(oldStateRoot: uint256, newStateRoot: uint256, batchHash: uint256, withdrawalsRoot: uint256): int {
  return hashRollupValues(oldStateRoot, newStateRoot, batchHash, withdrawalsRoot);
}

/// Полная проверка без изменения состояния.
get fun verify(
  piA: slice, piB: slice, piC: slice,
  oldStateRoot: uint256, newStateRoot: uint256, batchHash: uint256, withdrawalsRoot: uint256
): bool {
  val pubInputs: array<int> = [hashRollupValues(oldStateRoot, newStateRoot, batchHash, withdrawalsRoot)];
  return HashVerifier.create().verify(piA, piB, piC, pubInputs);
}
