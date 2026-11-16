# Succinct — "Partner with Succinct" form answers

Form: https://docs.google.com/forms/d/e/1FAIpQLSdRkAJbsQo74anO0olda-a3S3C0HY-6rV3qxVz5eHvU3vLW3A/viewform
Fields marked **[applicant]** are filled in by the applicant.

- **Name:** [applicant]
- **Are you looking to:** Build with SP1
- **Category:** Rollup
- **Company / Project name:** TON ZK-Rollup
- **Project website:** https://github.com/negrusha1337-ops/ton-zk-rollup
- **Volume / users / TVL:** Pre-launch, testnet only. Full protocol cycle on TON testnet:
  76 transactions, none failed.
- **Email:** [applicant]
- **Telegram:** [applicant]
- **Social link:** [applicant]

**What are you planning on building with SP1?**

We built the first EVM validity rollup settled on TON, and SP1 is its core.

- **Execution.** Each L2 block is executed by Reth inside SP1 6.10, using the RSP libraries.
  We hardened RSP for an untrusted sequencer: bytecode and trie-node shapes from the witness
  are now checked, a gap found in our own review.
- **Proof.** The SP1 Groth16 (BN254) proof is verified on TON L1. TON has no BN254 pairing
  opcode, so we wrote a software pairing with prover-supplied hints in Tolk. A real SP1 v6
  proof verifies in one TON transaction for 943,702 gas, about 950k per rollup batch, out of
  the 1M limit.
- **Testnet results, Nov 2026.**
  - three proven Reth blocks accepted;
  - bridge withdrawals paid out;
  - a freeze, followed by proof-free escape exits through Merkle-Patricia proofs and
    secp256k1 signatures checked in the TVM.
- **Proving.** About 1 minute per block with a warm prover on one RTX A6000; an RTX 4090 works
  with reduced shards. An aggregation spike (8 blocks in one Groth16) gives about 119k gas per
  block on TON.

**Next:**
- a 24-hour sequencer run with a remote GPU prover;
- exits for L2 contracts and arbitrary forced transactions;
- jettons;
- a public testnet with aggregation.

**We would value:**
- Prover Network access or credits for the public testnet;
- a review of how we pin and use the SP1 Groth16 verifier key;
- visibility for SP1 on a non-EVM L1.

The code is open source (MIT OR Apache-2.0). Every finding from 20+ adversarial review rounds
is public in REVIEW.md.
