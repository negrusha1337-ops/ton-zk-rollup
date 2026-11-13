import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier, keyUploadFromJson } from '../wrappers/Bn254Groth16Verifier';
import { NullifierErrors, Rollup, RollupErrors } from '../wrappers/Rollup';
import {
    DEPLOY_VALUE,
    FORCE_EXIT_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    WITHDRAW_VALUE,
} from '../wrappers/rollupValues';
import { merkleProofCell, withdrawalTree } from '../wrappers/rollupMath';
import {
    loadExitScenario,
    loadProvenBatch,
    loadProvenExit,
    loadZkvmScenario,
    ProvenExit,
} from '../wrappers/zkvmProofs';
import { computePhaseOf } from './helpers/gas';

// Лимит газа на транзакцию: конфиг сети, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;
const TIMEOUT = 3600;
const START = 1_800_000_000;

const program = loadZkvmScenario();
const exits = loadExitScenario();

// Аварийный выход без заглушек: настоящий rollup-контракт, настоящие пруфы SP1.
// Сценарий: депозит → два батча (как в tests/RollupZkvmProof.spec.ts) → секвенсор
// пропадает → новый депозит висит дольше срока → rollup заморожен → счета L2 выходят
// по пруфам программы выхода (zkvm/exit-program), необработанный депозит возвращается.
describe('Rollup: аварийный выход по пруфам SP1', () => {
    const batch1 = loadProvenBatch(1);
    const batch2 = loadProvenBatch(2);
    const alice = loadProvenExit('alice');
    const bob = loadProvenExit('bob');
    const key = keyUploadFromJson(batch1.hinted.keyUpload);
    const exitKey = keyUploadFromJson(alice.hinted.keyUpload);
    const gas: Record<string, number> = {};

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let lateDepositor: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let beforeFreeze: BlockchainSnapshot;
    let frozen: BlockchainSnapshot;

    const forceExit = (exit: ProvenExit, claim = exit.claim) =>
        rollup.sendForceExit(anyone.getSender(), {
            proof: exit.proof,
            hints: Cell.fromBase64(exit.hinted.hintsBoc),
            claim,
            value: FORCE_EXIT_VALUE,
        });
    const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = START;
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        user = await blockchain.treasury('user');
        lateDepositor = await blockchain.treasury('late-depositor');
        anyone = await blockchain.treasury('anyone');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode: await compile('RollupNullifier'),
                    genesisStateRoot: BigInt(program.genesisStateRoot),
                    chainId: BigInt(program.chainId),
                    escapeTimeout: TIMEOUT,
                },
                await compile('Rollup'),
            ),
        );
        await rollup.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key)) {
            await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
        }
        await rollup.sendSetExitKey(owner.getSender(), { ic0: exitKey.ic0, value: KEY_FINALIZE_VALUE });
        await rollup.sendFinalizeKey(owner.getSender(), { key, value: KEY_FINALIZE_VALUE });

        // Обычная жизнь rollup'а: депозит, два батча с пруфами SP1.
        await rollup.sendDeposit(user.getSender(), {
            l2Recipient: BigInt(program.deposit.l2Recipient),
            value: BigInt(program.deposit.value),
        });
        for (const [index, batch] of [batch1, batch2].entries()) {
            for (const data of batch.dataChunks) {
                await rollup.sendPublishData(sequencer.getSender(), {
                    batchIndex: index + 1,
                    data,
                    value: PUBLISH_DATA_VALUE,
                });
            }
            const result = await rollup.sendSubmitBatch(sequencer.getSender(), {
                proof: batch.proof,
                hints: Cell.fromBase64(batch.hinted.hintsBoc),
                roots: batch.roots,
                value: SUBMIT_BATCH_VALUE,
            });
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        expect((await rollup.getRollupState()).stateRoot).toBe(BigInt(exits.stateRoot));

        // Секвенсор пропал. Кто-то вносит депозит, и он остаётся необработанным.
        blockchain.now = START + 100;
        await rollup.sendDeposit(lateDepositor.getSender(), { l2Recipient: 0xdeadn, value: toNano('0.5') });
        beforeFreeze = blockchain.snapshot();

        blockchain.now = START + 100 + TIMEOUT + 1;
        const activation = await rollup.sendActivateEscapeHatch(anyone.getSender(), toNano('0.05'));
        expect(activation.transactions).toHaveTransaction({ to: rollup.address, success: true });
        gas.activateEscapeHatch = Number(computePhaseOf(activation.transactions, rollup.address).gasUsed);
        frozen = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(frozen);
    });

    afterAll(() => {
        const file = path.join(__dirname, '..', 'bench', 'rollup-escape.json');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
            file,
            JSON.stringify(
                {
                    source: 'Измерено в @ton/sandbox тестом tests/RollupEscapeProof.spec.ts; не редактировать вручную',
                    note: 'Газ аварийного выхода на настоящем rollup-контракте с Groth16-пруфами SP1 программы выхода; nonce = 0',
                    gasLimit: TX_GAS_LIMIT,
                    ...gas,
                },
                null,
                2,
            ) + '\n',
        );
        console.table(gas);
    });

    it('ключ программы выхода отличается от ключа батчей только константой IC0', async () => {
        const parts = (json: typeof alice.hinted.keyUpload) => ({ ...json, ic0: undefined });
        expect(parts(alice.hinted.keyUpload)).toEqual(parts(batch1.hinted.keyUpload));
        expect(alice.hinted.keyUpload.ic0).not.toEqual(batch1.hinted.keyUpload.ic0);
        expect(bob.hinted.vkDataBoc).toBe(alice.hinted.vkDataBoc);
        // Контракт собирает ключ выхода сам — из частей ключа батчей и заданного IC0.
        expect(await rollup.getExitKeyHash()).toBe(
            BigInt('0x' + Cell.fromBase64(alice.hinted.vkDataBoc).hash().toString('hex')),
        );
        expect(await rollup.getExitKeyHash()).not.toBe(await rollup.getKeyHash());
    });

    it('пруфы выхода построены для замороженного состояния и этих заявок', async () => {
        for (const exit of [alice, bob]) {
            // Публичный вход, который требует контракт, — тот, что выдала программа выхода.
            expect(await rollup.getExpectedExitInput(exit.claim)).toBe(BigInt(exit.output.publicInput));
            expect(exit.publicInputs[1]).toBe(BigInt(exit.output.publicInput));
            expect(exit.publicInputs[4]).toBe(0n);
        }
    });

    it('до заморозки выход по настоящему пруфу не принимается', async () => {
        await blockchain.loadFrom(beforeFreeze);
        expect((await forceExit(alice)).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.rollupNotFrozen,
        });
        expect(await balanceOf(alice.claim.recipient)).toBe(0n);
    });

    it('счёт L2 выходит с полным балансом и только один раз', async () => {
        const result = await forceExit(alice);
        expect(result.transactions).toHaveTransaction({
            from: rollup.address,
            to: alice.claim.recipient,
            value: alice.claim.amount,
        });
        gas.forceExit = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        gas.forceExitHeadroom = TX_GAS_LIMIT - gas.forceExit;
        expect(gas.forceExit).toBeLessThan(TX_GAS_LIMIT);
        expect(await balanceOf(alice.claim.recipient)).toBe(alice.claim.amount);

        const again = await forceExit(alice);
        expect(again.transactions).toHaveTransaction({
            to: await rollup.getExitNullifierAddress(alice.claim.l2Account),
            success: false,
            exitCode: NullifierErrors.alreadyClaimed,
        });
        expect(await balanceOf(alice.claim.recipient)).toBe(alice.claim.amount);
    });

    it('пруф не даёт вывести больше, другому получателю или с чужого счёта', async () => {
        const stranger = new Address(0, Buffer.alloc(32, 0x66));
        const forgeries = [
            { ...alice.claim, amount: alice.claim.amount + 1n },
            { ...alice.claim, recipient: stranger },
            // Пруф Алисы с заявкой Боба: его баланс на её пруфе не вывести.
            bob.claim,
        ];
        for (const claim of forgeries) {
            const result = await forceExit(alice, claim);
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false });
        }
        expect(await balanceOf(stranger)).toBe(0n);
        expect(await balanceOf(alice.claim.recipient)).toBe(0n);
        expect(await balanceOf(bob.claim.recipient)).toBe(0n);
    });

    it('пруф программы батчей не годится как пруф выхода', async () => {
        const result = await rollup.sendForceExit(anyone.getSender(), {
            proof: batch2.proof,
            hints: Cell.fromBase64(batch2.hinted.hintsBoc),
            claim: alice.claim,
            value: FORCE_EXIT_VALUE,
        });
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false });
        expect(await balanceOf(alice.claim.recipient)).toBe(0n);
    });

    it('все средства забираются без секвенсора: выходы, вывод и возврат депозита', async () => {
        const before = await balanceOf(rollup.address);

        // Оба счёта L2 выходят по своим пруфам.
        for (const exit of [alice, bob]) {
            await forceExit(exit);
            expect(await balanceOf(exit.claim.recipient)).toBe(exit.claim.amount);
        }

        // Вывод, который Боб оформил ещё в батче 2, идёт обычным путём.
        const { leafIndex } = program.withdrawal;
        const recipientHash = BigInt(program.withdrawal.recipientHash);
        const amount = BigInt(program.withdrawal.amount);
        const tree = withdrawalTree([{ leafIndex, recipientHash, amount }]);
        const withdrawRecipient = new Address(0, Buffer.from(recipientHash.toString(16).padStart(64, '0'), 'hex'));
        await rollup.sendWithdraw(anyone.getSender(), {
            leafIndex,
            recipient: withdrawRecipient,
            amount,
            merkleProof: merkleProofCell(tree.proofFor(leafIndex)),
            value: WITHDRAW_VALUE,
        });
        expect(await balanceOf(withdrawRecipient)).toBe(amount);

        // Депозит, не попавший в батч, возвращается вносителю (депозит 1 обработан, это второй).
        const receipt = await rollup.getDepositReceipt(2);
        expect(receipt?.depositor.equals(lateDepositor.address)).toBe(true);
        const refund = await rollup.sendCancelDeposit(anyone.getSender(), { depositIndex: 2, value: toNano('0.05') });
        expect(refund.transactions).toHaveTransaction({
            from: rollup.address,
            to: lateDepositor.address,
            value: receipt!.amount,
        });
        gas.cancelDeposit = Number(computePhaseOf(refund.transactions, rollup.address).gasUsed);

        // Обязательства rollup'а: балансы L2 + неоплаченный вывод + необработанный депозит.
        // Выплачено ровно столько; контракт не ушёл в минус и лишнего не отдал.
        const owed = alice.claim.amount + bob.claim.amount + amount + receipt!.amount;
        expect(owed).toBe(BigInt(program.deposit.amount) + receipt!.amount);
        expect(before - (await balanceOf(rollup.address))).toBeLessThanOrEqual(owed);
    });
});
