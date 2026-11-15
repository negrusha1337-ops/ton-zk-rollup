import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import {
    loadEvmProgramKeys,
    loadEvmRollupKey,
    loadProvenRethBatch,
    ProvenEvmBatch,
    RETH_PROVEN_BLOCKS,
    rethProofStatus,
} from '../wrappers/evmProofs';
import { proofFixturesBlocker, proofSuiteMode } from '../wrappers/protocolVersion';
import { NullifierErrors, Rollup, RollupErrors, VerifierErrors } from '../wrappers/Rollup';
import { merkleProofCell, withdrawalTree } from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    TESTNET_ESCAPE_TIMEOUT_SECONDS,
} from '../wrappers/rollupValues';
import { saveGasReport } from './helpers/benchResults';
import { computePhaseOf } from './helpers/gas';
import {
    blockOf,
    enqueueUpTo,
    prepareRethBatch,
    RethActors,
    rethExitMessage,
    rethExpected,
    rethRecipient,
    WEI_PER_NANOTON,
    withdrawalLeavesUpTo,
} from './helpers/rethChain';
import { readProtocolConstants, testConfig } from './helpers/rollupSetup';

// Лимит газа на транзакцию: конфиг сети, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;

// Полный цикл протокола v2 на НАСТОЯЩЕМ контракте с настоящими пруфами SP1 блоков узла Reth:
// очередь L1 (депозиты и принудительные транзакции) → батчи по Groth16-пруфам → вывод через
// мост → заморозка → аварийный выход счетов → возврат позднего депозита.
//
// НАБОР ЖДЁТ ПРУФОВ v2 И ЕЩЁ НИ РАЗУ НЕ ИСПОЛНЯЛСЯ: пруфы блоков цепочки v2 не построены
// (строятся только по команде пользователя, после независимой проверки). Пока их нет либо в
// fixtures/sp1_evm_reth<N> лежат пруфы прежнего протокола, набор помечает себя одним todo. Он
// написан и типизирован под обёртки v2 и повторяет шаги набора на двойнике
// (tests/RollupEvmReth.spec.ts, общий код — tests/helpers/rethChain.ts), который проходит; но
// всё, что касается самих пруфов (формат фикстур импортёра, поле statementForgery, газ), будет
// проверено только первым прогоном с пруфами.
const SUITE = 'Rollup: пруфы SP1 блоков узла Reth, полный цикл';
const status = rethProofStatus();
const blocker = proofFixturesBlocker();
const mode = proofSuiteMode(blocker, status.current);
if (mode === 'run') {
    describe(SUITE, suite);
} else if (mode === 'todo') {
    // Пруфы в fixtures/ ещё прежнего протокола (PROOF_FIXTURES_PROTOCOL_VERSION не поднят).
    describe(SUITE, () => {
        it.todo(`ждёт пруфов SP1 протокола v2 для блоков ${RETH_PROVEN_BLOCKS.join(', ')} цепочки Reth: ${blocker}`);
    });
} else {
    // Версия пруфов объявлена нынешней, а пруфы негодны: это падение, а не ожидание.
    describe(SUITE, () => {
        it(`пруфы SP1 блоков ${RETH_PROVEN_BLOCKS.join(', ')} цепочки Reth годны для нынешних программы, ключа и цепочки`, () => {
            throw new Error(`пруфы объявлены пруфами протокола v2, но негодны: ${status.reason}`);
        });
    });
}

function suite() {
    const batches: ProvenEvmBatch[] = RETH_PROVEN_BLOCKS.map(loadProvenRethBatch);
    const key = loadEvmRollupKey();
    const gas: Record<string, number> = {};
    const recipient = rethRecipient();
    const last = RETH_PROVEN_BLOCKS[RETH_PROVEN_BLOCKS.length - 1];

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let actors: RethActors;
    let ready: BlockchainSnapshot;

    const proven = (number: number) => batches[RETH_PROVEN_BLOCKS.indexOf(number)];
    const submit = (number: number, overrides: { newStateRoot?: bigint; hintsBoc?: string } = {}) => {
        const batch = proven(number);
        return rollup.sendSubmitBatch(owner.getSender(), {
            proof: batch.proof,
            hints: Cell.fromBase64(overrides.hintsBoc ?? batch.hinted.hintsBoc),
            roots: { ...batch.roots, newStateRoot: overrides.newStateRoot ?? batch.roots.newStateRoot },
            value: SUBMIT_BATCH_VALUE,
        });
    };
    /** Батч по пруфу: публичный вход контракта обязан совпасть с пруфом, газ — уложиться в лимит. */
    const accept = async (number: number) => {
        const batch = proven(number);
        const prepared = await prepareRethBatch(actors, number, PUBLISH_DATA_VALUE);
        expect(prepared.roots).toEqual(batch.roots);
        expect(prepared.required).toBe(prepared.proven);
        expect(prepared.required).toBe(batch.publicInputs[1]);
        const result = await submit(number);
        expect(result.transactions).toHaveTransaction({ from: owner.address, to: rollup.address, success: true });
        gas[`submitBatch${number}`] = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect(gas[`submitBatch${number}`]).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: batch.roots.newStateRoot,
            withdrawalsRoot: batch.roots.withdrawalsRoot,
            batchIndex: number,
            withdrawalsCount: batch.roots.withdrawalsCount,
        });
    };

    beforeAll(async () => {
        const code = await compile('Rollup');
        const nullifierCode = await compile('RollupNullifier');
        const constants = await readProtocolConstants(code, nullifierCode);
        expect(constants.genesisHash).toBe(BigInt(rethExpected.genesisHash));
        blockchain = await Blockchain.create();
        blockchain.now = blockOf(1).timestamp;
        owner = await blockchain.treasury('owner');
        user = await blockchain.treasury('user');
        stranger = await blockchain.treasury('stranger');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                testConfig(constants, {
                    owner: owner.address,
                    sequencer: owner.address,
                    nullifierCode,
                    chainId: BigInt(rethExpected.chainId),
                    escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS,
                }),
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key.upload)) {
            await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
        }
        await rollup.sendFinalizeKey(owner.getSender(), { key: key.upload, value: KEY_FINALIZE_VALUE });
        expect(await rollup.getKeyHash()).toBe(key.keyHash);
        actors = { blockchain, rollup, sequencer: owner, user };
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
        blockchain.now = blockOf(1).timestamp;
    });

    afterAll(() => {
        saveGasReport(
            'rollup-evm-reth-proof.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupEvmRethProof.spec.ts; не редактировать вручную',
                note: 'Газ rollup-контракта протокола v2 на настоящих Groth16-пруфах SP1 блоков узла Reth (депозиты, принудительные выводы, выводы через мост) и аварийных выходов счетов против последнего из них.',
                gasLimit: TX_GAS_LIMIT,
                sourcesSha256: loadEvmProgramKeys().sourcesSha256,
                zkvmCycles: batches.map((batch) => batch.report.zkvmCycles),
            },
            gas,
            [...RETH_PROVEN_BLOCKS.map((number) => `submitBatch${number}`), 'rejectedForgery', 'withdrawStep', 'forceExitEvm1', 'forceExitEvm2'],
        );
        console.table(gas);
    });

    it('полный цикл по настоящим пруфам: очередь, батчи, вывод, заморозка, аварийный выход', async () => {
        for (const number of RETH_PROVEN_BLOCKS) await accept(number);

        // --- вывод через мост: первый лист дерева после последнего батча ---
        const leaves = withdrawalLeavesUpTo(last);
        expect(leaves.length).toBeGreaterThan(0);
        const tree = withdrawalTree(leaves);
        expect(tree.root).toBe(proven(last).roots.withdrawalsRoot);
        const leaf = leaves[0];
        const withdrawTo = new Address(0, Buffer.from(leaf.recipientHash.toString(16).padStart(64, '0'), 'hex'));
        const sendWithdraw = async () =>
            rollup.sendWithdraw(stranger.getSender(), {
                leafIndex: leaf.leafIndex,
                recipient: withdrawTo,
                amount: leaf.amount,
                merkleProof: merkleProofCell(tree.proofFor(leaf.leafIndex)),
                value: (await rollup.getMinimumValues()).withdraw,
            });
        const withdraw = await sendWithdraw();
        expect(withdraw.transactions).toHaveTransaction({ from: rollup.address, to: withdrawTo, value: leaf.amount });
        gas.withdrawStep = Number(computePhaseOf(withdraw.transactions, rollup.address).gasUsed);
        let paid = leaf.amount;

        // --- секвенсор пропал: поздний депозит ждёт дольше срока ---
        const late = toNano('0.5');
        const { depositFee } = await rollup.getQueueFees();
        await rollup.sendDeposit(stranger.getSender(), { l2Recipient: 0xdeadn, value: late + depositFee, maxFee: depositFee });
        const lateIndex = Number((await rollup.getDepositQueue()).head.count);
        const { oldestPendingAt } = await rollup.getEscapeState();
        blockchain.now = oldestPendingAt + TESTNET_ESCAPE_TIMEOUT_SECONDS + 1;
        await rollup.sendActivateEscapeHatch(stranger.getSender(), toNano('0.05'));
        expect((await rollup.getEscapeState()).frozen).toBe(true);

        // --- аварийные выходы счетов против последнего блока, принятого по пруфу ---
        const entry = rethExpected.exitsByBlock.find(({ block }) => block === last)!;
        expect(await rollup.getEvmExitConsentHash(BigInt(rethExpected.exitRecipientHash))).toBe(BigInt(entry.consentHash));
        expect(withdrawTo.equals(recipient)).toBe(true);
        const budget = await rollup.getEvmExitBudget();
        const sendExit = (index: number) =>
            rollup.sendForceExitEvm(stranger.getSender(), { recipient, ...rethExitMessage(last, entry.exits[index]), value: budget.minValue });
        for (const index of [0, 1]) {
            const amount = BigInt(entry.exits[index].balanceWei) / WEI_PER_NANOTON;
            const exited = await sendExit(index);
            expect(exited.transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: amount });
            gas[`forceExitEvm${index + 1}`] = Number(computePhaseOf(exited.transactions, rollup.address).gasUsed);
            expect(gas[`forceExitEvm${index + 1}`]).toBeLessThanOrEqual(budget.stepGas);
            paid += amount;
        }
        const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;
        expect(await balanceOf(recipient)).toBe(paid);

        // Повтор вывода и выходов не платит: отказ — от нуллификатора (контракт пополнен, чтобы
        // ранняя проверка «нечем платить» его не опередила).
        await owner.send({ to: rollup.address, value: toNano('10') });
        expect((await sendWithdraw()).transactions).toHaveTransaction({ success: false, exitCode: NullifierErrors.alreadyClaimed });
        for (const index of [0, 1]) {
            expect((await sendExit(index)).transactions).toHaveTransaction({ success: false, exitCode: NullifierErrors.alreadyClaimed });
        }
        expect(await balanceOf(recipient)).toBe(paid);

        // --- поздний депозит возвращается вносителю ---
        const refund = await rollup.sendCancelDeposit(stranger.getSender(), { depositIndex: lateIndex, value: toNano('0.05') });
        expect(refund.transactions).toHaveTransaction({ from: rollup.address, to: stranger.address, value: late });
    });

    it('пруф блока не подходит, если очередь L1 другая: без её элементов батч 2 отклоняется', async () => {
        // Блок 2 обрабатывает элементы очереди, вставшие после батча 1. Если на L1 их нет, контракт
        // отвергает саму отметку; если очередь другая — соберёт другие одиннадцать слов.
        await accept(1);
        const batch = proven(2);
        const before = await rollup.getDepositQueue();
        expect(BigInt(batch.report.queueProcessedUpTo)).toBeGreaterThan(before.head.count);
        const early = await submit(2);
        expect(early.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: RollupErrors.queueMarkOutOfRange });
        // Очередь той же длины, но с чужим депозитом на месте последнего элемента.
        await enqueueUpTo(actors, blockOf(2).headAtBatch - 1);
        const { depositFee } = await rollup.getQueueFees();
        await rollup.sendDeposit(stranger.getSender(), { l2Recipient: 0xdeadn, value: toNano('1') + depositFee, maxFee: depositFee });
        for (const data of batch.dataChunks) {
            await rollup.sendPublishData(owner.getSender(), { batchIndex: 2, data, value: PUBLISH_DATA_VALUE });
        }
        expect(await rollup.getExpectedPublicInput(batch.roots)).not.toBe(batch.publicInputs[1]);
        // Подсказки посчитаны для дайджеста пруфа, а контракт подставил свой: отказ уже на первой
        // проверке наклона в верификаторе.
        const result = await submit(2);
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: VerifierErrors.wrongSlope });
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
    });

    it('«лучшая подделка»: пруф блока 1 под чужой хеш блока отклоняется замыкающим равенством', async () => {
        await prepareRethBatch(actors, 1, PUBLISH_DATA_VALUE);
        const forgery = proven(1).hinted.statementForgery;
        if (!forgery) throw new Error('в фикстуре пруфа нет «лучшей подделки» (statementForgery)');
        expect(forgery.alteredWord).toBe(2);
        const forgedRoot = BigInt(forgery.alteredValue);
        expect(await rollup.getExpectedPublicInput({ ...proven(1).roots, newStateRoot: forgedRoot })).toBe(BigInt(forgery.input));
        const result = await submit(1, { newStateRoot: forgedRoot, hintsBoc: forgery.hintsBoc });
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: RollupErrors.wrongProof });
        gas.rejectedForgery = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
    });
}
