// СГЕНЕРИРОВАНО: npm run zk:verifiers. Не править руками.

import "@stdlib/exotic-cells"


/// This verifier is stateless.
/// It does not provide:
/// - nullifier replay protection;
/// - nonce or query-id protection;
/// - known-root validation;
/// - recipient binding;
/// - chain-id or contract-address domain separation;
/// - state-transition validation.

/// Empty persistent storage; verifier constants are embedded in code.
struct HashVerifierStorage {}

struct HashVerifier {
  ic0: slice
  ic1: slice
  vkGamma2: slice
  vkDelta2: slice
  vkAlpha1: slice
  vkBeta2: slice
  nPublic: int
}

const HashVerifierMinVerifyValue: coins = 50000000

enum HashVerifierErrors {
  InvalidInputs = 258,
  WrongProof = 260,
  NotEnoughValue = 261,
}

fun HashVerifier.create(): HashVerifier {
  return HashVerifier {
    ic0: "ae42ff76d7553667af44faea6213d4e560c1b000142e19bfc9100d95be32d8be7e207e8a7f580286b1b44ae900f0e5de".hexToSlice(),
    ic1: "80dd58b4526bfb8ba18f5f72fd49bcd3d4a27950b9bef42ae4e7268479111d48be2aab67b306b29c9764a7d3f1862d51".hexToSlice(),
    vkGamma2: "93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8".hexToSlice(),
    vkDelta2: "a4a54e653333edb9cd326340ef3b2443c39059454bca63d34b76c2217d076055c9f41f5ed2721666a89c18a94be9a89313d8565937a7600735c6997bc3116b3e4149689fbb6b5c5a32cba5f101fd2e180a673d7f476c78d17f1193cc95c3250c".hexToSlice(),
    vkAlpha1: "8d4769058baf86841c099b5e9c24edac2073acd62e1d5b688bb94c51521cce905bad00f53ff289dbdaf99fba667847df".hexToSlice(),
    vkBeta2: "8fc0f3706a9927ddce55bbbf8f76551dca7c56ab9b9bcfcce7f328a9aefcb4cbcd4271564c101476a5f66eb2c7f1dc1c0bf5477574b919bd344a63b28eb02dae8afc3275035fc8195a440f08d39eb211a6fe7e6ec0cac673e18fb8805d84c549".hexToSlice(),
    nPublic: 1,
  };
}

/// # Safety
/// Expects both slices to contain canonically encoded BLS12-381 G1 points
/// accepted by the TVM `BLS_G1_ADD` opcode.
@pure fun HashVerifier.blsG1Add(x: slice, y: slice): slice asm "BLS_G1_ADD";

/// # Safety
/// Expects the slice to contain a canonically encoded BLS12-381 G1 point
/// accepted by the TVM `BLS_G1_NEG` opcode.
@pure fun HashVerifier.blsG1Neg(x: slice): slice asm "BLS_G1_NEG";

@pure fun HashVerifier.blsG1InGroup(x: slice): bool asm "BLS_G1_INGROUP";
@pure fun HashVerifier.blsG2InGroup(x: slice): bool asm "BLS_G2_INGROUP";
@pure fun HashVerifier.blsG1IsZero(x: slice): bool asm "BLS_G1_ISZERO";
@pure fun HashVerifier.blsG2IsZero(x: slice): bool asm "BLS_G2_ISZERO";

fun HashVerifier.checkProofPoints(piA: slice, piB: slice, piC: slice) {
  if (
    piA.remainingBitsCount() != 384 || piA.remainingRefsCount() != 0 ||
    piB.remainingBitsCount() != 768 || piB.remainingRefsCount() != 0 ||
    piC.remainingBitsCount() != 384 || piC.remainingRefsCount() != 0
  ) {
    throw HashVerifierErrors.InvalidInputs;
  }
  if (!HashVerifier.blsG1InGroup(piA) || !HashVerifier.blsG2InGroup(piB) || !HashVerifier.blsG1InGroup(piC)) {
    throw HashVerifierErrors.InvalidInputs;
  }
  if (HashVerifier.blsG1IsZero(piA) || HashVerifier.blsG2IsZero(piB) || HashVerifier.blsG1IsZero(piC)) {
    throw HashVerifierErrors.InvalidInputs;
  }
}

fun HashVerifier.loadCheckedG1(point: cell): slice {
  val (pointSlice, isExotic) = point.beginParseSpecial();
  if (isExotic || pointSlice.remainingBitsCount() != 384 || pointSlice.remainingRefsCount() != 0) {
    throw HashVerifierErrors.InvalidInputs;
  }
  return pointSlice;
}

fun HashVerifier.loadCheckedG2(point: cell): slice {
  val (pointSlice, isExotic) = point.beginParseSpecial();
  if (isExotic || pointSlice.remainingBitsCount() != 768 || pointSlice.remainingRefsCount() != 0) {
    throw HashVerifierErrors.InvalidInputs;
  }
  return pointSlice;
}

fun HashVerifier.loadCheckedProof(proof: cell): (slice, slice, slice) {
  val (initialProof, isExotic) = proof.beginParseSpecial();
  var proofSlice = initialProof;
  if (isExotic || proofSlice.remainingBitsCount() != 0 || proofSlice.remainingRefsCount() != 3) {
    throw HashVerifierErrors.InvalidInputs;
  }
  val piA = HashVerifier.loadCheckedG1(proofSlice.loadRef());
  val piB = HashVerifier.loadCheckedG2(proofSlice.loadRef());
  val piC = HashVerifier.loadCheckedG1(proofSlice.loadRef());
  proofSlice.assertEnd();
  return (piA, piB, piC);
}

@pure fun HashVerifier.blsR(): int asm "BLS_PUSHR";

fun HashVerifier.checkPublicInput(x: int): int {
  // TVM scalar multiplication reduces modulo r, so x and x+r would otherwise alias.
  if (x < 0 || x >= HashVerifier.blsR()) {
    throw HashVerifierErrors.InvalidInputs;
  }
  return x;
}

/// # Safety
/// Expects the provided slices to contain canonically encoded BLS12-381 proof
/// and verification-key points in the order required by TVM `BLS_PAIRING`.
@pure fun HashVerifier.blsPairing(
  x1: slice, y1: slice,
  x2: slice, y2: slice,
  x3: slice, y3: slice,
  x4: slice, y4: slice,
  n: int
): int asm "BLS_PAIRING";

/// # Safety
/// Expects x1..x1 to be canonical BLS12-381 G1 points and y1..y1
/// to be scalars encoded in the format expected by TVM `BLS_G1_MULTIEXP`.
@pure
fun HashVerifier.blsG1Multiexp1(
  x1: slice, y1: int,
  n: int
): slice asm "BLS_G1_MULTIEXP";


// Internal messages carry public inputs as a custom payload:
// uint8 length, then canonical three-int257 chunks chained through refs.
fun HashVerifier.checkPublicInputsPayloadShape(payload: slice) {
  var remaining: int = 1;

  while (remaining > 0) {
    var chunk: int = remaining;
    if (chunk > 3) { chunk = 3; }
    if (payload.remainingBitsCount() != chunk * 257) { throw HashVerifierErrors.InvalidInputs; }
    remaining -= chunk;

    if (remaining > 0) {
      if (payload.remainingRefsCount() != 1) { throw HashVerifierErrors.InvalidInputs; }
      val (nextPayload, isExotic) = payload.loadRef().beginParseSpecial();
      if (isExotic) { throw HashVerifierErrors.InvalidInputs; }
      payload = nextPayload;
    } else if (payload.remainingRefsCount() != 0) {
      throw HashVerifierErrors.InvalidInputs;
    }
  }
}

fun HashVerifier.loadNextPubInput(mutate payload: slice): int {
  if (payload.remainingBitsCount() < 257) {
    if (payload.remainingBitsCount() != 0 || payload.remainingRefsCount() != 1) {
      throw HashVerifierErrors.InvalidInputs;
    }
    val (nextPayload, isExotic) = payload.loadRef().beginParseSpecial();
    if (isExotic || nextPayload.remainingBitsCount() < 257) {
      throw HashVerifierErrors.InvalidInputs;
    }
    payload = nextPayload;
  }
  return HashVerifier.checkPublicInput(payload.loadInt(257));
}

fun HashVerifier.finishGroth16(
  self,
  piA: slice,
  piB: slice,
  piC: slice,
  acc: slice,
  haveAcc: bool
): bool {
  // Final cpub = IC0 + acc (IC0 is always added exactly once)
  var cpub: slice;
  if (!haveAcc) {
    cpub = self.ic0;
  } else {
    cpub = HashVerifier.blsG1Add(acc, self.ic0);
  }

  // Pairing check: e(cpub, gamma) * e(-piA, piB) * e(piC, delta) * e(alpha, beta) == 1
  val piANeg: slice = HashVerifier.blsG1Neg(piA);
  val ok: int = HashVerifier.blsPairing(
    cpub,         self.vkGamma2,
    piANeg,       piB,
    piC,          self.vkDelta2,
    self.vkAlpha1, self.vkBeta2,
    4
  );

  return ok != 0;
}

fun HashVerifier.verifyPayload(
  self,
  piA: slice,
  piB: slice,
  piC: slice,
  mutate payload: slice
): bool {
  HashVerifier.checkProofPoints(piA, piB, piC);

  // Compute: cpub = IC0 + sum(pubInputs[i] * IC(i+1))
  var haveAcc: bool = false;
  var acc: slice = self.ic0; // placeholder until haveAcc == true

  val y1: int = HashVerifier.loadNextPubInput(mutate payload);
  acc = HashVerifier.blsG1Multiexp1(
    self.ic1, y1
    , 1
  );
  haveAcc = true;

  if (payload.remainingBitsCount() != 0 || payload.remainingRefsCount() != 0) {
    throw HashVerifierErrors.InvalidInputs;
  }

  return self.finishGroth16(piA, piB, piC, acc, haveAcc);
}

fun HashVerifier.verify(self, piA: slice, piB: slice, piC: slice, pubInputs: array<int>): bool {
  HashVerifier.checkProofPoints(piA, piB, piC);
  if (pubInputs.size() != self.nPublic) { throw HashVerifierErrors.InvalidInputs; }

  // Compute: cpub = IC0 + sum(pubInputs[i] * IC(i+1))
  var haveAcc: bool = false;
  var acc: slice = self.ic0; // placeholder until haveAcc == true

  acc = HashVerifier.blsG1Multiexp1(
    self.ic1, HashVerifier.checkPublicInput(pubInputs.get(0))
    , 1
  );
  haveAcc = true;

  return self.finishGroth16(piA, piB, piC, acc, haveAcc);
}

/// Internal message containing Groth16 proof points and serialized public inputs.
struct (0x3b3cca17) HashVerifierVerify {
  /// Ordinary cell with exactly three refs: piA, piB, piC.
  proof: cell
  /// Ordinary cell with uint8 length followed by a linear int257 ref chain.
  pubInputs: cell
}

fun HashVerifier.verifyProof(self, msg: HashVerifierVerify): bool {
  val (piA, piB, piC) = HashVerifier.loadCheckedProof(msg.proof);
  val (initialPayload, payloadIsExotic) = msg.pubInputs.beginParseSpecial();
  var payload = initialPayload;

  if (payloadIsExotic || payload.remainingBitsCount() < 8) { throw HashVerifierErrors.InvalidInputs; }
  if (payload.loadUint(8) != self.nPublic) { throw HashVerifierErrors.InvalidInputs; }
  HashVerifier.checkPublicInputsPayloadShape(payload);

  return self.verifyPayload(piA, piB, piC, mutate payload);
}
