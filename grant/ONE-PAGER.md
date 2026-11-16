# TON ZK-Rollup — one page

**What.** An EVM validity rollup settled on TON. EVM blocks are executed by Reth inside the
SP1 zkVM. The Groth16 (BN254) proof is verified by a TON smart contract. Users keep a
proof-free escape hatch back to TON L1.

**Why it matters.**
- EVM tooling and contracts reach TON users, and correctness is enforced on TON itself, not
  by a committee.
- The BN254 verifier in TVM is a new primitive: any SP1 or RISC Zero program can now be
  verified on TON.

**Proof it works (TON testnet, Nov 2026).**

| | |
|---|---|
| SP1 Groth16 proof verified on-chain | 943,702 gas, one transaction — `EQA_7F9q37iRlriq9Z3nR4g6MJpEtOSe0HfTxjCWCyXBnIaA` |
| Full rollup cycle, protocol v2 | 3 proven Reth blocks, 5 withdrawals, freeze + 2 escape exits, 76 txs, 0 failed — `EQA9ohM26MxwBxY2Hhr-0QBqIqWfSYYrEbvgbFsNFjznASNW` |
| Gas per batch | ~950k of the 1M limit; with aggregation (8 blocks) ~119k per block |
| Proving | ~1 min per block on one RTX A6000 (warm); RTX 4090 works |
| Assurance | 423 + 113 tests, 361 mutants killed, 20+ adversarial review rounds, public findings log |

**Architecture.**

```
L2 users ──tx──▶ Sequencer (Reth) ──block──▶ SP1 zkVM ──Groth16──▶ TON rollup contract
                     ▲                                                │ deposits, queue,
TON users ──deposit / forced tx (L1 queue)────────────────────────────┘ withdrawals, escape
```

**Next 6 months (grant scope).**

1. A 24-hour service run.
2. Exit for L2 contracts and arbitrary forced transactions (protocol v3).
3. Jettons and a developer SDK.
4. A public testnet with aggregation.

**Status.** Research prototype. Testnet only. Not audited by humans; a human audit is the step
after this grant. License: MIT OR Apache-2.0.

Repository: https://github.com/negrusha1337-ops/ton-zk-rollup
