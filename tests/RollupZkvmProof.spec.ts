import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier, Bn254Proof, KeyUploadJson, keyUploadFromJson } from '../wrappers/Bn254Groth16Verifier';
import { Rollup } from '../wrappers/Rollup';
import { depositHash, merkleProofCell, withdrawalTree } from '../wrappers/rollupMath';
import { computePhaseOf } from './helpers/gas';

// Лимит газа на транзакцию: конфиг сети, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;

const read = (...parts: string[]) => JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', ...parts), 'utf8'));

type BatchOutput = {
    publicInput: string;
    prevStateRoot: string;
    roots: { newStateRoot: string; batchHash: string; withdrawalsRoot: string };
    newDepositHash: string;
};
const program = read('zkvm_batches', 'batches.json') as {
    genesisStateRoot: string;
    deposit: { l2Recipient: string; value: string; amount: string };
    withdrawal: { leafIndex: number; recipientHash: string; amount: string };
    batches: BatchOutput[];
};
const programKey = read('zkvm_batches', 'program.json') as { programVKey: string };

type Hinted = { vkDataBoc: string; keyUpload: KeyUploadJson; hintsBoc: string; inputs: string[] };
/** Пруф SP1 одного батча: то, что построил zkvm/script и импортировал zk/import-sp1-fixture.mjs. */
const provenBatch = (index: number) => {
    const directory = `sp1_rollup_batch${index}`;
    const raw = read(directory, 'proof.json');
    const proof: Bn254Proof = {
        a: [BigInt(raw.pi_a[0]), BigInt(raw.pi_a[1])],
        b: [
            [BigInt(raw.pi_b[0][0]), BigInt(raw.pi_b[0][1])],
            [BigInt(raw.pi_b[1][0]), BigInt(raw.pi_b[1][1])],
        ],
        c: [BigInt(raw.pi_c[0]), BigInt(raw.pi_c[1])],
    };
    const output = program.batches[index - 1];
    return {
        proof,
        hinted: (read(directory, 'onchain.json') as { hinted: Hinted }).hinted,
        publicInputs: (read(directory, 'public.json') as string[]).map(BigInt),
        output,
        roots: {
            newStateRoot: BigInt(output.roots.newStateRoot),
            batchHash: BigInt(output.roots.batchHash),
            withdrawalsRoot: BigInt(output.roots.withdrawalsRoot),
        },
    };
};

// Сквозной путь без заглушек: программа перехода состояния (zkvm/lib) исполнена в SP1,
// её Groth16-пруф (схема v6.1.0) проверяется настоящим rollup-контрактом. Пруф привязан
// и к программе (ключ программы — константа в ключе верификации), и к батчу (дайджест
// публичных значений контракт считает сам из своего состояния).
describe('Rollup: пруфы SP1 нашей программы перехода состояния', () => {
    const genesis = BigInt(program.genesisStateRoot);
    const batch1 = provenBatch(1);
    const batch2 = provenBatch(2);
    const key = keyUploadFromJson(batch1.hinted.keyUpload);
    const gas: Record<string, number> = {};

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let ready: BlockchainSnapshot;

    const submit = (batch: ReturnType<typeof provenBatch>, overrides: { nonce?: bigint; newStateRoot?: bigint } = {}) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: batch.proof,
            hints: Cell.fromBase64(batch.hinted.hintsBoc),
            roots: { ...batch.roots, newStateRoot: overrides.newStateRoot ?? batch.roots.newStateRoot },
            nonce: overrides.nonce,
            value: toNano('0.3'),
        });
    const deposit = () =>
        rollup.sendDeposit(user.getSender(), {
            l2Recipient: BigInt(program.deposit.l2Recipient),
            value: BigInt(program.deposit.value),
        });

    beforeAll(async () => {
        const code = await compile('Rollup');
        const nullifierCode = await compile('RollupNullifier');
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        user = await blockchain.treasury('user');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                { owner: owner.address, sequencer: sequencer.address, nullifierCode, genesisStateRoot: genesis },
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key)) {
            const upload = await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: toNano('0.1') });
            expect(upload.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        const finalize = await rollup.sendFinalizeKey(owner.getSender(), { key, value: toNano('0.1') });
        expect(finalize.transactions).toHaveTransaction({ to: rollup.address, success: true });
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
    });

    afterAll(() => {
        const file = path.join(__dirname, '..', 'bench', 'rollup-zkvm-proof.json');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
            file,
            JSON.stringify(
                {
                    source: 'Измерено в @ton/sandbox тестом tests/RollupZkvmProof.spec.ts; не редактировать вручную',
                    note: 'Газ submit_batch с Groth16-пруфами SP1 (схема v6.1.0) нашей программы перехода состояния; nonce = 0',
                    gasLimit: TX_GAS_LIMIT,
                    ...gas,
                },
                null,
                2,
            ) + '\n',
        );
        console.table(gas);
    });

    it('пруфы построены для нашей программы и для этих батчей', async () => {
        // Оба пруфа проверяются одним ключом: меняются только дайджест и nonce.
        expect(batch2.hinted.vkDataBoc).toBe(batch1.hinted.vkDataBoc);
        expect(await rollup.getKeyHash()).toBe(
            BigInt('0x' + Cell.fromBase64(batch1.hinted.vkDataBoc).hash().toString('hex')),
        );
        for (const batch of [batch1, batch2]) {
            const [programVKey, digest, exitCode, , nonce] = batch.publicInputs;
            expect(programVKey).toBe(BigInt(programKey.programVKey));
            // Дайджест в пруфе — тот, что дал нативный запуск программы.
            expect(digest).toBe(BigInt(batch.output.publicInput));
            expect(exitCode).toBe(0n);
            expect(nonce).toBe(0n);
        }
        expect(BigInt(batch1.output.prevStateRoot)).toBe(genesis);
        expect(await rollup.getExpectedPublicInput(batch1.roots)).toBe(BigInt(batch1.output.publicInput));
    });

    it('батч с пруфом SP1 принимается и укладывается в лимит газа', async () => {
        const result = await submit(batch1);
        expect(result.transactions).toHaveTransaction({ from: sequencer.address, to: rollup.address, success: true });
        gas.submitBatch = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        gas.submitBatchHeadroom = TX_GAS_LIMIT - gas.submitBatch;
        expect(gas.submitBatch).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: batch1.roots.newStateRoot,
            withdrawalsRoot: batch1.roots.withdrawalsRoot,
            batchIndex: 1,
        });
    });

    it('чужой корень состояния с настоящим пруфом не проходит', async () => {
        const result = await submit(batch1, { newStateRoot: batch1.roots.newStateRoot ^ 1n });
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false });
        expect(await rollup.getRollupState()).toMatchObject({ stateRoot: genesis, batchIndex: 0 });
    });

    it('чужой nonce с настоящим пруфом не проходит', async () => {
        const result = await submit(batch1, { nonce: 1n });
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false });
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
    });

    it('пруф батча 2 нельзя применить вместо батча 1', async () => {
        const result = await submit(batch2);
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false });
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
    });

    it('полный путь на настоящих пруфах: депозит → батч 1 → батч 2 → вывод', async () => {
        // Депозит приходит до первого батча; батч 2 обязан его обработать.
        expect((await deposit()).transactions).toHaveTransaction({ to: rollup.address, success: true });
        const queued = (await rollup.getDepositQueue()).head.hash;
        expect(queued).toBe(depositHash(0n, BigInt(program.deposit.l2Recipient), BigInt(program.deposit.amount)));
        expect(BigInt(batch2.output.newDepositHash)).toBe(queued);

        expect((await submit(batch1)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await rollup.getExpectedPublicInput(batch2.roots)).toBe(BigInt(batch2.output.publicInput));

        const second = await submit(batch2);
        expect(second.transactions).toHaveTransaction({ to: rollup.address, success: true });
        gas.submitBatchWithDeposit = Number(computePhaseOf(second.transactions, rollup.address).gasUsed);
        gas.submitBatchWithDepositHeadroom = TX_GAS_LIMIT - gas.submitBatchWithDeposit;
        expect(gas.submitBatchWithDeposit).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: batch2.roots.newStateRoot,
            withdrawalsRoot: batch2.roots.withdrawalsRoot,
            batchIndex: 2,
        });

        // Вывод по корню, который программа посчитала внутри zkVM.
        const { leafIndex } = program.withdrawal;
        const recipientHash = BigInt(program.withdrawal.recipientHash);
        const amount = BigInt(program.withdrawal.amount);
        const tree = withdrawalTree([{ leafIndex, recipientHash, amount }]);
        expect(tree.root).toBe(batch2.roots.withdrawalsRoot);
        const recipient = new Address(0, Buffer.from(recipientHash.toString(16).padStart(64, '0'), 'hex'));
        const withdraw = await rollup.sendWithdraw(user.getSender(), {
            leafIndex,
            recipient,
            amount,
            merkleProof: merkleProofCell(tree.proofFor(leafIndex)),
            value: toNano('0.2'),
        });
        expect(withdraw.transactions).toHaveTransaction({ from: rollup.address, to: recipient });
        expect((await blockchain.getContract(recipient)).balance).toBe(amount);
    });
});
