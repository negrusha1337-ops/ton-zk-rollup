# Grant application — TON ZK-Rollup (EVM validity rollup settled on TON)

Answers are written field by field for the TON Grants form on Questbook and can be reused for
other programs. Fields marked **[applicant]** are personal and are filled in by the applicant.

## Grant category

Other — open-source infrastructure for the TON ecosystem.

## Builder details

- Full name: **[applicant]**
- Email: **[applicant]**
- TON wallet address (payouts): **[applicant]**
- Personal Telegram handle: **[applicant]**

## Project details

- Website: https://github.com/negrusha1337-ops/ton-zk-rollup (the repository is the project site for now)
- Pitch deck: `grant/ONE-PAGER.md` in the repository
- Twitter: **[applicant]** or `-`
- Telegram channel: **[applicant]** or `-`
- Telegram bot: `-`
- GitHub: https://github.com/negrusha1337-ops/ton-zk-rollup

## Title (≤ 80 characters)

TON ZK-Rollup: EVM execution proven with SP1 and verified on TON L1

## Your idea in one sentence

A validity rollup that runs an EVM off-chain and settles on TON: every block is proven in the
SP1 zkVM and the Groth16 proof is verified by a TON smart contract. TON users get Ethereum
tooling, and the funds keep a proof-based exit to TON L1.

## Details — problem and solution

**Problem.** EVM developers, wallets and tooling are the largest smart-contract ecosystem.
Bringing them to TON today means trusting a separate validator set or a bridge committee:
nothing on TON L1 checks that the EVM state is correct, and users have no way to exit if the
operator disappears or censors them. TON also has no pairing opcode for BN254, the curve used
by every major zkVM (SP1, RISC Zero), so validity proofs from those systems could not be
checked on TON at all.

**Solution (already working on testnet).**

1. **BN254 Groth16 verifier in TVM.** A software pairing with prover-supplied hints, written
   in Tolk, verifies real SP1 v6 and RISC Zero proofs in a single TON transaction: 943,702 gas
   on testnet, exactly as in the Sandbox emulator. This makes any SP1/RISC Zero program
   verifiable on TON, not only this rollup.
2. **EVM block program for SP1.** Each block is executed by Reth (revm) inside SP1. The
   program enforces the rollup rules: deposits credited as EIP-4895 withdrawals, bridge
   withdrawals as logs of a predeployed bridge contract, forced transactions from the L1 queue,
   and the block data itself (published to TON for data availability). The public values
   (11 words) are hashed into one public input.
3. **Rollup contract on TON (protocol v2).**
   - Accepts a batch only with a valid proof (about 950k of the 1M gas limit).
   - Keeps an L1 queue of deposits and forced transactions, with a fee that doubles as the
     unprocessed tail grows.
   - Pays withdrawals by Merkle proof, with a nullifier contract per claim.
   - Has an **escape hatch**: if the oldest queue item waits longer than the escape timeout,
     anyone can freeze the rollup, and each L2 account exits by a Merkle-Patricia proof plus
     an Ethereum signature checked in the TVM. This works without the operator and without
     a new proof.
4. **Sequencer service.** It reads the L1 queue, builds blocks on a Reth node, checks every
   block with the zkVM program natively before treating it as final, proves on a local or
   remote GPU, and submits batches to TON.

**Demo / evidence.**

- Full protocol v2 cycle on TON testnet, 15.11.2026, contract
  `EQA9ohM26MxwBxY2Hhr-0QBqIqWfSYYrEbvgbFsNFjznASNW`:
  - three proven Reth blocks accepted;
  - five bridge withdrawals paid;
  - freeze, then two escape exits;
  - 76 transactions, none failed, gas identical to Sandbox.

  Report: `bench/testnet-run-reth.json`; walkthrough: `TESTNET.md`.
- Standalone SP1 proof verification on testnet: contract
  `EQA_7F9q37iRlriq9Z3nR4g6MJpEtOSe0HfTxjCWCyXBnIaA`, 943,702 gas.
- Security process: more than twenty rounds of adversarial review by independent AI reviewer
  agents. Every finding and fix is public in `REVIEW.md`; mutation testing has 361 mutants,
  each killed by a named test.

## Milestones

Total scope: 6 months. Payout after each milestone, verified against the repository and testnet.

| # | Milestone (≤ 1024 chars) | Deliverables / how to verify (≤ 2048 chars) | Deadline | Funding |
|---|---|---|---|---|
| 1 | **Rollup operates as a service.** 24-hour continuous testnet run of the sequencer with a GPU prover, plus public operator documentation. | The sequencer service runs for 24 hours against a freshly deployed protocol v2 contract on TON testnet, with traffic (deposits, bridge withdrawals). Run report: number of batches, gas per batch, prover time per block, failures and recoveries. Operator guide in English: deploy, run, monitor, recover. | +4 weeks | $3,000 |
| 2 | **Exit for everything (protocol v3).** The escape hatch covers coins held by L2 contracts, not only regular accounts. Forced transactions can be arbitrary L2 calls (declared gas, fee by gas). Exit consent uses EIP-712. | Protocol v3 specification. Updated zkVM program and contract. Tests and mutation tests for every new check. An independent adversarial review round with every finding fixed or documented. New Groth16 proofs accepted on testnet. Testnet demo: freeze, then exit of a balance held by an L2 contract. | +10 weeks | $8,000 |
| 3 | **Jettons and developer-facing bridge.** Deposit, withdrawal and escape of jettons. Events and named get-methods for explorers. TL-B schema of all messages. | A jetton bridge on testnet: deposit, L2 representation, withdrawal, escape. External-out events with fixed opcodes. Documented get-methods and exit codes. A TypeScript SDK for deposits and withdrawals. | +16 weeks | $6,000 |
| 4 | **Public testnet.** Public RPC for the L2, proof aggregation to cut gas per block, and documentation for EVM developers. | A public L2 RPC endpoint and faucet guide. Aggregation of several blocks into one Groth16 (spike measured: about 119k gas per block for 8 blocks) wired into the contract. A developer guide: deploy a Solidity contract to the rollup and bridge TON in and out. | +24 weeks | $3,000 |

**Total funding requested: $20,000 in TON** (the maximum for the "Other" category; can be
rescoped).

The grant pays for development time. GPU proving costs during the 24-hour run and the public
testnet (rented GPU, about $0.4–0.8 per hour) are also covered by the developer from these funds.

## Team

Solo developer **[applicant: name, background, links]**. The work so far is the evidence of
execution: protocol v2 — contract, zkVM program, sequencer, about 6,000 lines of Rust and
6,400 of TypeScript, 423 + 113 tests — designed, proven and run on testnet. The repository
history documents the whole path from the stage-0 experiment (Groth16 on BLS12-381 in TVM) to
the full testnet cycle.

## Current traction

The project is pre-launch infrastructure, so it has no MAU/TVL. Technical traction:

- the first BN254 Groth16 verification on TON — real SP1 and RISC Zero proofs, 943,702 gas on testnet;
- a full validity-rollup cycle on TON testnet: proven EVM blocks, withdrawals, freeze, escape exits;
- GPU proving measured: about 1 minute per block with a warm prover on one RTX A6000; an RTX 4090 works;
- a public security log (`REVIEW.md`) and mutation testing.

## Competitors

To our knowledge, no other project verifies EVM validity proofs on TON L1.

- **Existing EVM-on-TON solutions** (for example TAC, the TON Application Chain) rely on their
  own validator or sequencer set and messaging. TON L1 does not check that their EVM state is
  correct.
- **Bridges to Ethereum L2s** keep the funds outside TON.

Our advantages:

- correctness is enforced by a proof checked by the TON contract;
- funds stay on TON;
- users can exit without the operator.

The BN254 verifier is also reusable on its own: any team can verify SP1 or RISC Zero programs
on TON — for example light clients, ZK identity or provable off-chain computation.

## User acquisition strategy

The first users are developers, not retail.

1. **Open source and reuse.** The BN254 verifier and the SP1-to-TON proof pipeline as a
   standalone, documented package for TON developers. It is valuable even without the rollup.
2. **EVM developers.** A guide on deploying an existing Solidity contract to the rollup and
   reaching TON users through the bridge, published in TON and Ethereum developer channels.
3. **Public testnet** (milestone 4) with an RPC endpoint, plus a bug bounty on testnet issues.
4. **Write-ups.** Technical posts on software pairing in TVM, gas numbers and the escape hatch.

## Target user

- EVM/Solidity developers who want TON's user base without rewriting contracts in Tolk/FunC.
- TON teams that need heavy or verifiable computation off-chain (ZK proofs of any SP1 program).
- Later: TON users who want EVM DeFi with a proof-based exit to L1.

## Vision on further funding

After the grant:

- a human security audit of the contracts and the zkVM program (separate funding — audit
  firms or ecosystem audit-support programs);
- then a capped mainnet launch.

Longer-term options:

- ecosystem or infrastructure funding for operating the sequencer and prover;
- a sustainable fee model of sequencer fees on L2.

## Technology stack

- TON contracts: Tolk, Blueprint, @ton/sandbox and jest.
- zkVM: SP1 6.10 (Succinct), Groth16 over BN254, Rust, Reth / revm with RSP libraries.
- Sequencer: TypeScript, a Reth node, a remote GPU prover over SSH.
- Proving: CUDA GPUs (RTX A6000 / RTX 4090).

## How the project uses TON — what is on-chain

On TON L1:

- the Groth16 verifier and the rollup contract;
- deposits and the L1 queue (deposits, forced transactions);
- the batch data of every block, published in TON messages;
- verification of every batch proof;
- withdrawal payouts with nullifier contracts;
- the freeze and the escape hatch: Merkle-Patricia account proofs and secp256k1 signatures
  verified in the TVM.

Off-chain: EVM execution, the sequencer and the prover.

## Agreement

yes
