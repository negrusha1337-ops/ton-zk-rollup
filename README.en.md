# TON ZK-Rollup — an EVM validity rollup settled on TON

*Русская версия — [README.md](README.md).*

**Status: research prototype. Testnet only. No human audit.** Do not use with real funds.

This repository is, to our knowledge, the first working ZK-rollup with an EVM whose validity
proofs are verified **on TON L1** inside the TVM:

- EVM blocks are executed by **Reth** inside the **SP1 zkVM** (Succinct); the zkVM program
  enforces the rollup rules (deposits, bridge withdrawals, forced transactions, block data).
- SP1 produces a **Groth16 proof over BN254**. TON has no BN254 pairing opcode, so the rollup
  contract verifies it with a **software pairing with prover-supplied hints** written in Tolk
  (`contracts/bn254/`): about **950k gas** of the 1M per-transaction limit.
- The rollup contract (`contracts/rollup.tolk`, `contracts/rollup/`) keeps the L2 state word,
  an L1 queue of deposits and forced transactions with growing fees, a withdrawal tree with
  Merkle proofs and a nullifier per claim, batch data published in TON messages, and an
  **escape hatch**: if the queue is censored for longer than the escape timeout, anyone can
  freeze the rollup and every regular L2 account exits **without a proof**, by a
  Merkle-Patricia account proof from `eth_getProof` and an Ethereum signature checked in the TVM.

## What has been demonstrated

All numbers come from the Sandbox emulator or from testnet transactions (`bench/`).

| Result | Where |
|---|---|
| A real SP1 v6 Groth16 proof verified on TON testnet in one transaction: **943,702 gas**, identical to Sandbox | `bench/testnet-run-sp1_v6_fibonacci.json`, contract `EQA_7F9q37iRlriq9Z3nR4g6MJpEtOSe0HfTxjCWCyXBnIaA` |
| The same verifier accepts a RISC Zero receipt (944–949k gas) | `fixtures/risc0_v3_test_receipt/` |
| Protocol v2 full cycle on testnet, 15.11.2026: three Reth blocks proven with Groth16 and accepted (950,178 / 949,452 / 951,962 gas), five bridge withdrawals paid out, escape-hatch exits of two accounts (73,646 / 99,623 gas) after a freeze; 76 transactions, none failed; gas matched Sandbox to the unit | `bench/testnet-run-reth.json`, contract `EQA9ohM26MxwBxY2Hhr-0QBqIqWfSYYrEbvgbFsNFjznASNW`, [TESTNET.md](TESTNET.md) |
| A forged proof with honest hints for a false statement is rejected (code 7300) | `tests/RollupEvmRethProof.spec.ts` |
| GPU proving: one RTX A6000 — about 3 minutes per block cold, about 1 minute with a warm prover; an RTX 4090 (24 GB) works with reduced shards; a laptop (16 GB) needs 20–25 minutes | `bench/remote-gpu-proof.json` |
| Aggregation spike: one Groth16 for 8 blocks — about 119k gas per block on TON | `bench/aggregation-spike.json`, `zkvm-evm/spike-aggregate/` |

Quality work done so far:

- 423 jest tests (27 suites) and 113 native Rust tests;
- mutation testing — 166 mutants in the zkVM program, 141 in the contract, 54 in the EVM-exit
  parser, each killed by a named test;
- more than twenty rounds of adversarial review by independent AI reviewer agents. Every
  finding, fix and open question is public in [REVIEW.md](REVIEW.md). These reviews found
  critical bugs even in code that had already passed testnet — that is exactly why a human
  audit is still required before any real value.

## Repository map

| Path | What |
|---|---|
| `contracts/bn254/`, `contracts/bn254_groth16_verifier.tolk` | BN254 Groth16 verifier in TVM (software pairing with hints) |
| `contracts/rollup.tolk`, `contracts/rollup/`, `contracts/rollup_nullifier.tolk` | Rollup contract, protocol v2 |
| `zkvm-evm/` | SP1 program (Rust): Reth-based EVM block execution and rollup rules; host for execution, keys and proofs; Reth scenario |
| `sequencer/` | Sequencer service: L1 queue reader, block builder, native pre-check, local/remote GPU prover, testnet submitter |
| `wrappers/`, `scripts/`, `tests/` | TypeScript wrappers, Blueprint scripts, tests |
| `zk/` | Fixture generators, key binding, mutation scripts |
| `bench/` | Gas and proving measurements |

Design documents (in Russian): [ARCHITECTURE.md](ARCHITECTURE.md),
[PROTOCOL-V2.md](PROTOCOL-V2.md), [PROVING.md](PROVING.md), [DA.md](DA.md),
[ROADMAP.md](ROADMAP.md), [REVIEW.md](REVIEW.md), [REPORT.md](REPORT.md) (stage 0: Groth16 on
BLS12-381 in TVM), [ROUTES.md](ROUTES.md) (zkVM → TON proof route).

## Quick start

```bash
npm ci
npx jest --maxWorkers=2          # all contract tests; proofs are committed as fixtures
cd zkvm-evm && cargo test --release --locked -p rollup-evm   # native tests of the zkVM program
```

Rebuilding proofs needs the SP1 toolchain and a GPU (or 32 GB+ of RAM) — see
[PROVING.md](PROVING.md) and `zkvm-evm/host/remote/README.md`.

## What is missing (roadmap)

See [ROADMAP.md](ROADMAP.md). In short:

1. **Sequencer and prover as services** — implemented, a 24-hour testnet run is pending.
2. **Exit for everything** — today the escape hatch returns only regular account balances;
   coins held by L2 contracts are lost on freeze; forced transactions are limited to bridge
   withdrawals.
3. **Jettons and bridge as a product** — events, named get-methods, TL-B descriptions.
4. **Safety margin** — proof aggregation (gas headroom is only ~5% today), reproducible builds.
5. **Governance** — sequencer rotation, delayed upgrades, role separation, withdrawal limits.
6. **Mainnet path** — human audit, bug bounty, public testnet, deposit caps.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
Vendored code keeps its own license (`zkvm-evm/vendor/rsp-mpt/`).
