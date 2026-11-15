// @ts-nocheck
// НАБОР ПРОТОКОЛА v1. Написан под обёртки и пруфы прежнего протокола (дайджест из восьми слов,
// сообщения ForceExit и SetExitKey); с контрактом протокола v2 несовместим. Не удалён и не
// подогнан: пока пруфы в fixtures/ не перестроены под v2 (wrappers/protocolVersion.ts), набор
// помечает себя todo через describeWithProofFixtures и не типизируется. Перенос на v2 — вместе
// с шагом программы и пруфов (PROTOCOL-V2.md, раздел 11); прежняя версия целиком — тег protocol-v1.
import { describeWithProofFixtures } from './helpers/protocolGate';
import { proofFixturesBlocker } from '../wrappers/protocolVersion';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { keccak_256 } from '@noble/hashes/sha3';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import {
    evmHeaderCell,
    evmNodeItems,
    evmProofCell,
    evmProofSteps,
    evmSignatureCell,
    evmSignatureFromHex,
} from '../wrappers/evmExit';
import {
    loadEvmProgramKeys,
    loadEvmRollupKey,
    loadProvenRethBatch,
    loadRethExpected,
    ProvenEvmBatch,
    RETH_PROVEN_BLOCKS,
    rethProofStatus,
} from '../wrappers/evmProofs';
import { NullifierErrors, Rollup, RollupErrors, VerifierErrors } from '../wrappers/Rollup';
import { depositHash, merkleProofCell, withdrawalTree } from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
} from '../wrappers/rollupValues';
import { saveGasReport } from './helpers/benchResults';
import { computePhaseOf } from './helpers/gas';

// Лимит газа на транзакцию: конфиг сети, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;

// Полный цикл на настоящем контракте с настоящими пруфами SP1 блоков узла Reth
// (zkvm-evm/scenario/reth-scenario.mjs): депозиты на L1 → три батча по Groth16-пруфам → вывод
// через мост → заморозка → аварийный выход счёта → возврат позднего депозита. Генезис цепочки
// пуст: все монеты L2 — из депозитов этого теста.
//
// Тот же сценарий без пруфов, на двойнике, — tests/RollupEvmReth.spec.ts. Здесь проверка пруфа
// настоящая: батч принимается, только если программа в zkVM действительно выдала те восемь слов,
// которые контракт собрал из своего хранилища и очереди.
const SUITE = 'Rollup: пруфы SP1 блоков узла Reth, полный цикл';
const status = rethProofStatus();
if (proofFixturesBlocker() !== null || status.current) {
    // Сначала — общая проверка версии протокола: пруфы прежнего протокола дают один todo.
    describeWithProofFixtures(SUITE, suite);
} else {
    // Пруфов нет либо они от прежней цепочки (каждый запуск сценария Reth даёт новую): набор
    // ждёт их, а не падает и не проходит молча. Пруфы строятся только по команде пользователя.
    describe(SUITE, () => {
        it.todo(`ждёт пруфов SP1 блоков Reth для нынешней цепочки (${status.reason})`);
    });
}

function suite() {
    const expected = loadRethExpected();
    const batches: ProvenEvmBatch[] = RETH_PROVEN_BLOCKS.map(loadProvenRethBatch);
    const key = loadEvmRollupKey();
    const bytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex');
    const gas: Record<string, number> = {};
    const TIMEOUT = 3600;
    const START = 1_800_000_000;
    /** 1 нанотон = 1 gwei (EVM_WEI_PER_NANOTON в evm_exit.tolk). */
    const WEI_PER_NANOTON = 1_000_000_000n;

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let ready: BlockchainSnapshot;

    const deposit = async (item: { l2Recipient: string; amount: string }) => {
        const { depositFee } = await rollup.getQueueFees();
        const before = (await rollup.getDepositQueue()).head;
        await rollup.sendDeposit(user.getSender(), {
            l2Recipient: BigInt(item.l2Recipient),
            value: BigInt(item.amount) + depositFee,
            maxFee: depositFee,
        });
        expect((await rollup.getDepositQueue()).head.hash).toBe(
            depositHash(before.hash, BigInt(item.l2Recipient), BigInt(item.amount)),
        );
    };
    const publish = async (number: number) => {
        for (const data of batches[number - 1].dataChunks) {
            const result = await rollup.sendPublishData(owner.getSender(), { batchIndex: number, data, value: PUBLISH_DATA_VALUE });
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        expect(await rollup.getBatchDataHash(number)).toBe(BigInt(batches[number - 1].report.publicValues.batchHash));
    };
    const submit = (number: number, overrides: { newStateRoot?: bigint; hintsBoc?: string } = {}) => {
        const batch = batches[number - 1];
        return rollup.sendSubmitBatch(owner.getSender(), {
            proof: batch.proof,
            hints: Cell.fromBase64(overrides.hintsBoc ?? batch.hinted.hintsBoc),
            roots: { ...batch.roots, newStateRoot: overrides.newStateRoot ?? batch.roots.newStateRoot },
            value: SUBMIT_BATCH_VALUE,
        });
    };
    /** Батч по пруфу: публичный вход контракта обязан совпасть с пруфом, газ — уложиться в лимит. */
    const accept = async (number: number) => {
        const batch = batches[number - 1];
        await publish(number);
        expect(await rollup.getExpectedPublicInput(batch.roots)).toBe(batch.publicInputs[1]);
        const result = await submit(number);
        expect(result.transactions).toHaveTransaction({ from: owner.address, to: rollup.address, success: true });
        gas[`submitBatch${number}`] = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect(gas[`submitBatch${number}`]).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: batch.roots.newStateRoot,
            withdrawalsRoot: batch.roots.withdrawalsRoot,
            batchIndex: number,
        });
    };

    beforeAll(async () => {
        const code = await compile('Rollup');
        const nullifierCode = await compile('RollupNullifier');
        blockchain = await Blockchain.create();
        blockchain.now = START;
        owner = await blockchain.treasury('owner');
        user = await blockchain.treasury('user');
        stranger = await blockchain.treasury('stranger');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: owner.address,
                    sequencer: owner.address,
                    nullifierCode,
                    // «Корень состояния генезиса» — хеш заголовка генезиса Reth.
                    genesisStateRoot: BigInt(expected.genesisHash),
                    chainId: BigInt(expected.chainId),
                    escapeTimeout: TIMEOUT,
                },
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key.upload)) {
            await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
        }
        await rollup.sendSetExitKey(owner.getSender(), { ic0: key.exitIc0, value: KEY_FINALIZE_VALUE });
        await rollup.sendFinalizeKey(owner.getSender(), { key: key.upload, value: KEY_FINALIZE_VALUE });
        expect(await rollup.getKeyHash()).toBe(key.keyHash);
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
        blockchain.now = START;
    });

    afterAll(() => {
        saveGasReport(
            'rollup-evm-reth-proof.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupEvmRethProof.spec.ts; не редактировать вручную',
                note: 'Газ rollup-контракта на настоящих Groth16-пруфах SP1 трёх блоков узла Reth (депозиты зачислениями EIP-4895, перевод, вывод через мост) и аварийного выхода счёта против последнего из них. Генезис цепочки пуст.',
                gasLimit: TX_GAS_LIMIT,
                sourcesSha256: loadEvmProgramKeys().sourcesSha256,
                zkvmCycles: batches.map((batch) => batch.report.zkvmCycles),
            },
            gas,
            ['submitBatch1', 'submitBatch2', 'submitBatch3', 'rejectedForgery', 'withdrawStep', 'forceExitEvm1', 'forceExitEvm2'],
        );
        console.table(gas);
    });

    it('полный цикл по настоящим пруфам: депозиты, три батча, вывод, заморозка, аварийный выход', async () => {
        const [first, second] = expected.deposits as { l2Recipient: string; amount: string }[];
        // Батч k зачисляет то, что встало в очередь между принятием батчей k−2 и k−1.
        await deposit(first);
        await accept(1);
        await deposit(second);
        await accept(2);
        await accept(3);
        const queue = await rollup.getDepositQueue();
        expect(queue.processed).toEqual(queue.head);

        // --- вывод через мост ---
        const leaf = {
            leafIndex: expected.withdrawal.leafIndex as number,
            recipientHash: BigInt(expected.withdrawal.recipientHash),
            amount: BigInt(expected.withdrawal.amount),
        };
        const tree = withdrawalTree([leaf]);
        expect(tree.root).toBe(batches[2].roots.withdrawalsRoot);
        const withdrawTo = new Address(0, bytes(expected.withdrawal.recipientHash));
        const owed = new Map<string, bigint>();
        const credit = (to: Address, amount: bigint) => owed.set(to.toString(), (owed.get(to.toString()) ?? 0n) + amount);
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
        credit(withdrawTo, leaf.amount);

        // --- секвенсор пропал: поздний депозит ждёт дольше срока ---
        const late = toNano('0.5');
        const { depositFee } = await rollup.getQueueFees();
        await rollup.sendDeposit(stranger.getSender(), { l2Recipient: 0xdeadn, value: late + depositFee, maxFee: depositFee });
        blockchain.now = START + TIMEOUT + 1;
        await rollup.sendActivateEscapeHatch(stranger.getSender(), toNano('0.05'));
        expect((await rollup.getEscapeState()).frozen).toBe(true);

        // --- аварийные выходы обоих счетов против блока 3, принятого по пруфу ---
        const header = evmNodeItems(bytes(batches[2].report.dataChunksHex.join('')))[0];
        expect(BigInt('0x' + Buffer.from(keccak_256(header)).toString('hex'))).toBe(batches[2].roots.newStateRoot);
        const exitTo = new Address(0, bytes(expected.exitRecipientHash));
        const exits = expected.exits as { account: string; balanceWei: string; accountProof: string[]; signature: string }[];
        const amounts = exits.map((exit) => BigInt(exit.balanceWei) / WEI_PER_NANOTON);
        const budget = await rollup.getEvmExitBudget();
        const sendExit = (index: number) =>
            rollup.sendForceExitEvm(stranger.getSender(), {
                recipient: exitTo,
                header: evmHeaderCell(header),
                proof: evmProofCell(evmProofSteps(exits[index].accountProof.map(bytes))),
                signature: evmSignatureCell(evmSignatureFromHex(exits[index].signature)),
                value: budget.minValue,
            });
        for (const index of [0, 1]) {
            const exited = await sendExit(index);
            expect(exited.transactions).toHaveTransaction({ from: rollup.address, to: exitTo, value: amounts[index] });
            gas[`forceExitEvm${index + 1}`] = Number(computePhaseOf(exited.transactions, rollup.address).gasUsed);
            expect(gas[`forceExitEvm${index + 1}`]).toBeLessThanOrEqual(budget.stepGas);
            credit(exitTo, amounts[index]);
        }

        // Повтор вывода и выходов не платит: деньги на контракте ещё есть (поздний депозит не
        // возвращён), отказ — от нуллификатора.
        expect((await sendWithdraw()).transactions).not.toHaveTransaction({ from: rollup.address, to: withdrawTo });
        for (const index of [0, 1]) {
            const again = await sendExit(index);
            expect(again.transactions).toHaveTransaction({ success: false, exitCode: NullifierErrors.alreadyClaimed });
            expect(again.transactions).not.toHaveTransaction({ from: rollup.address, to: exitTo });
        }

        // --- поздний депозит возвращается; каждый получил ровно своё ---
        const refund = await rollup.sendCancelDeposit(stranger.getSender(), { depositIndex: 3, value: toNano('0.05') });
        expect(refund.transactions).toHaveTransaction({ from: rollup.address, to: stranger.address, value: late });
        const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;
        for (const address of [withdrawTo, exitTo]) expect(await balanceOf(address)).toBe(owed.get(address.toString()));
    });

    it('пруф блока не подходит, если очередь L1 другая: без депозита батч 2 отклоняется', async () => {
        // Блок 2 зачисляет депозит пользователя. Если на L1 этого депозита нет, контракт соберёт
        // другие восемь слов — и настоящий пруф им не соответствует.
        // Батч 1 здесь идёт без замера газа: очередь другая, чем в полном цикле.
        await publish(1);
        expect((await submit(1)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        await publish(2);
        expect(await rollup.getExpectedPublicInput(batches[1].roots)).not.toBe(batches[1].publicInputs[1]);
        const result = await submit(2);
        // Подсказки посчитаны для дайджеста пруфа, а контракт подставил свой: отказ уже на первой
        // проверке секущей в верификаторе.
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: VerifierErrors.wrongSlope });
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
    });

    it('«лучшая подделка»: пруф блока 1 под чужой хеш блока отклоняется замыкающим равенством', async () => {
        const [first] = expected.deposits as { l2Recipient: string; amount: string }[];
        await deposit(first);
        await publish(1);
        const forgery = batches[0].hinted.statementForgery;
        expect(forgery.alteredWord).toBe(2);
        const forgedRoot = BigInt(forgery.alteredValue);
        expect(await rollup.getExpectedPublicInput({ ...batches[0].roots, newStateRoot: forgedRoot })).toBe(BigInt(forgery.input));
        const result = await submit(1, { newStateRoot: forgedRoot, hintsBoc: forgery.hintsBoc });
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: RollupErrors.wrongProof });
        gas.rejectedForgery = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
    });
}
