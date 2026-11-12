import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier, Bn254Proof, KeyUploadJson, keyUploadFromJson } from '../wrappers/Bn254Groth16Verifier';
import { NullifierErrors, Rollup, RollupErrors } from '../wrappers/Rollup';
import {
    batchDataHash,
    batchDigest,
    dataChunkCell,
    depositHash,
    merkleProofCell,
    withdrawalTree,
} from '../wrappers/rollupMath';
import { computePhaseOf } from './helpers/gas';

// Лимит газа на транзакцию: конфиг сети, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;

type BatchFixture = {
    roots: { newStateRoot: string; withdrawalsRoot: string };
    /** Порции данных батча, которые секвенсор публикует до отправки пруфа. */
    dataChunksHex: string[];
    batchHash: string;
    publicInput: string;
    proof: string[];
    hintsBoc: string;
};
const read = (...parts: string[]) => JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', ...parts), 'utf8'));
const scenario = read('rollup_batches', 'batches.json') as {
    chainId: string;
    genesisStateRoot: string;
    deposit: { l2Recipient: string; value: string; amount: string; hashAfter: string };
    withdrawal: { leafIndex: number; recipientHash: string; amount: string; siblings: string[]; root: string };
    batches: BatchFixture[];
};
const keyFixture = read('multiplier_bn254', 'onchain.json').hinted as { vkDataBoc: string; keyUpload: KeyUploadJson };

const proofOf = (batch: BatchFixture): Bn254Proof => {
    const p = batch.proof.map(BigInt);
    return {
        a: [p[0], p[1]],
        b: [
            [p[2], p[3]],
            [p[4], p[5]],
        ],
        c: [p[6], p[7]],
    };
};
const rootsOf = (batch: BatchFixture) => ({
    newStateRoot: BigInt(batch.roots.newStateRoot),
    withdrawalsRoot: BigInt(batch.roots.withdrawalsRoot),
});
const dataOf = (batch: BatchFixture) => batch.dataChunksHex.map((hex) => dataChunkCell(Buffer.from(hex, 'hex')));

// Сквозной путь на настоящем контракте (contracts/rollup.tolk): ключ загружается
// частями, батчи принимаются только с верным Groth16-пруфом на BN254.
// Пруфы — игрушечной схемы: они привязаны к дайджесту батча, но переход состояния
// не доказывают (см. zk/gen-rollup-batches.mjs).
describe('Rollup: настоящая проверка пруфа', () => {
    const genesis = BigInt(scenario.genesisStateRoot);
    const chainId = BigInt(scenario.chainId);
    const [batch1, batch2] = scenario.batches;
    const key = keyUploadFromJson(keyFixture.keyUpload);
    const gas: Record<string, number> = {};

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let ready: BlockchainSnapshot;

    const submit = (batch: BatchFixture) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: proofOf(batch),
            hints: Cell.fromBase64(batch.hintsBoc),
            roots: rootsOf(batch),
            value: toNano('0.3'),
        });
    const publishData = async (batch: BatchFixture, batchIndex: number, chunks = dataOf(batch)) => {
        for (const data of chunks) {
            const result = await rollup.sendPublishData(sequencer.getSender(), {
                batchIndex,
                data,
                value: toNano('0.05'),
            });
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            gas.publishData = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        }
    };
    const depositFromScenario = () =>
        rollup.sendDeposit(user.getSender(), {
            l2Recipient: BigInt(scenario.deposit.l2Recipient),
            value: BigInt(scenario.deposit.value),
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
                {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode,
                    genesisStateRoot: genesis,
                    chainId,
                },
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
        const file = path.join(__dirname, '..', 'bench', 'rollup-submit-batch.json');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
            file,
            JSON.stringify(
                {
                    source: 'Измерено в @ton/sandbox тестом tests/RollupProof.spec.ts; не редактировать вручную',
                    note: 'Газ транзакций rollup-контракта с настоящей проверкой пруфа BN254 (один переменный публичный вход)',
                    gasLimit: TX_GAS_LIMIT,
                    ...gas,
                },
                null,
                2,
            ) + '\n',
        );
        console.table(gas);
    });

    it('ключ собран, а сценарий фикстуры согласован с арифметикой контракта', async () => {
        expect(await rollup.getKeyHash()).toBe(
            BigInt('0x' + Cell.fromBase64(keyFixture.vkDataBoc).hash().toString('hex')),
        );
        // Публичный вход, который потребует контракт, совпадает с тем, под который строился пруф.
        expect(await rollup.getExpectedPublicInput(rootsOf(batch1))).toBe(BigInt(batch1.publicInput));
        expect(BigInt(batch1.publicInput)).toBe(
            batchDigest({
                chainId,
                prevStateRoot: genesis,
                ...rootsOf(batch1),
                batchHash: 0n,
                prevDepositHash: 0n,
                newDepositHash: 0n,
            }),
        );
        // Батч 1 — без данных; у батча 2 обязательство равно накопительному хешу его порций.
        expect(batch1.dataChunksHex).toEqual([]);
        expect(BigInt(batch2.batchHash)).toBe(batchDataHash(dataOf(batch2)));
        expect(BigInt(scenario.deposit.hashAfter)).toBe(
            depositHash(0n, BigInt(scenario.deposit.l2Recipient), BigInt(scenario.deposit.amount)),
        );
    });

    it('батч с настоящим пруфом принимается и укладывается в лимит газа', async () => {
        const result = await submit(batch1);
        expect(result.transactions).toHaveTransaction({ from: sequencer.address, to: rollup.address, success: true });
        gas.submitBatch = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        gas.submitBatchHeadroom = TX_GAS_LIMIT - gas.submitBatch;
        expect(gas.submitBatch).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: rootsOf(batch1).newStateRoot,
            withdrawalsRoot: 0n,
            batchIndex: 1,
        });
    });

    it('принятый батч нельзя отправить повторно', async () => {
        await submit(batch1);
        const replay = await submit(batch1);
        // Прежний корень изменился, значит контракт требует другой публичный вход,
        // а наклоны в подсказках посчитаны для старого: отказ на первом же сложении.
        expect(replay.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: 7006 });
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
    });

    it('батчи нельзя применить не по порядку', async () => {
        const result = await submit(batch2);
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: 7006 });
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
    });

    it('чужой корень с настоящим пруфом не проходит', async () => {
        const result = await rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: proofOf(batch1),
            hints: Cell.fromBase64(batch1.hintsBoc),
            roots: { ...rootsOf(batch1), newStateRoot: rootsOf(batch1).newStateRoot ^ 1n },
            value: toNano('0.3'),
        });
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false });
        expect((await rollup.getRollupState()).stateRoot).toBe(genesis);
    });

    it('батч не принимается, пока его данные не опубликованы в TON', async () => {
        await depositFromScenario();
        await submit(batch1);

        // Данных нет: контракт подставляет нулевой хеш, и настоящий пруф к нему не подходит.
        const withoutData = await submit(batch2);
        expect(withoutData.transactions).toHaveTransaction({ to: rollup.address, success: false });
        expect((await rollup.getRollupState()).batchIndex).toBe(1);

        // Опубликованы другие данные (порции в обратном порядке) — пруф тоже не подходит.
        await publishData(batch2, 2, dataOf(batch2).reverse());
        const wrongData = await submit(batch2);
        expect(wrongData.transactions).toHaveTransaction({ to: rollup.address, success: false });
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
        // Отказ откатил транзакцию целиком: запись о данных на месте.
        expect(await rollup.getBatchDataHash(2)).toBe(batchDataHash(dataOf(batch2).reverse()));
    });

    it('полный путь: депозит → два батча → вывод', async () => {
        // Депозит приходит до первого батча.
        const deposit = await depositFromScenario();
        expect(deposit.transactions).toHaveTransaction({ to: rollup.address, success: true });
        gas.deposit = Number(computePhaseOf(deposit.transactions, rollup.address).gasUsed);

        expect((await submit(batch1)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        // Теперь цель очереди — этот депозит, и батч 2 обязан его обработать. Его данные
        // должны быть опубликованы в TON до пруфа.
        await publishData(batch2, 2);
        expect(await rollup.getExpectedPublicInput(rootsOf(batch2))).toBe(BigInt(batch2.publicInput));

        const second = await submit(batch2);
        expect(second.transactions).toHaveTransaction({ to: rollup.address, success: true });
        gas.submitBatchWithDeposit = Number(computePhaseOf(second.transactions, rollup.address).gasUsed);
        expect(gas.submitBatchWithDeposit).toBeLessThan(TX_GAS_LIMIT);

        const queue = await rollup.getDepositQueue();
        expect(queue.processed).toEqual({ count: 1n, hash: BigInt(scenario.deposit.hashAfter) });
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: rootsOf(batch2).newStateRoot,
            withdrawalsRoot: BigInt(scenario.withdrawal.root),
            batchIndex: 2,
        });

        // Вывод по корню, который опубликовал батч 2.
        const { leafIndex } = scenario.withdrawal;
        const recipientHash = BigInt(scenario.withdrawal.recipientHash);
        const amount = BigInt(scenario.withdrawal.amount);
        const tree = withdrawalTree([{ leafIndex, recipientHash, amount }]);
        expect(tree.root).toBe(BigInt(scenario.withdrawal.root));
        const recipient = new Address(0, Buffer.from(recipientHash.toString(16).padStart(64, '0'), 'hex'));
        const withdraw = () =>
            rollup.sendWithdraw(user.getSender(), {
                leafIndex,
                recipient,
                amount,
                merkleProof: merkleProofCell(tree.proofFor(leafIndex)),
                value: toNano('0.2'),
            });

        const first = await withdraw();
        expect(first.transactions).toHaveTransaction({ from: rollup.address, to: recipient });
        gas.withdraw = Number(computePhaseOf(first.transactions, rollup.address).gasUsed);
        expect((await blockchain.getContract(recipient)).balance).toBe(amount);

        const again = await withdraw();
        expect(again.transactions).toHaveTransaction({
            from: rollup.address,
            to: await rollup.getNullifierAddress(leafIndex),
            success: false,
            exitCode: NullifierErrors.alreadyClaimed,
        });
        expect((await blockchain.getContract(recipient)).balance).toBe(amount);
    });

    it("пруф одного rollup'а не подходит другому с тем же ключом и тем же состоянием", async () => {
        // Двойник отличается только идентификатором: тот же код, тот же ключ, тот же генезис.
        const twin = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode: await compile('RollupNullifier'),
                    genesisStateRoot: genesis,
                    chainId: chainId + 1n,
                },
                await compile('Rollup'),
            ),
        );
        await twin.sendDeploy(owner.getSender(), toNano('5'));
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key)) {
            await twin.sendUploadKeyPart(owner.getSender(), { slot, part, value: toNano('0.1') });
        }
        await twin.sendFinalizeKey(owner.getSender(), { key, value: toNano('0.1') });
        expect(await twin.getKeyHash()).toBe(await rollup.getKeyHash());
        expect(await twin.getChainId()).toBe(chainId + 1n);

        // Настоящий пруф батча 1 нашего rollup'а: у себя принимается, у двойника — нет.
        const result = await twin.sendSubmitBatch(sequencer.getSender(), {
            proof: proofOf(batch1),
            hints: Cell.fromBase64(batch1.hintsBoc),
            roots: rootsOf(batch1),
            value: toNano('0.3'),
        });
        expect(result.transactions).toHaveTransaction({ to: twin.address, success: false });
        expect((await twin.getRollupState()).batchIndex).toBe(0);
        expect((await submit(batch1)).transactions).toHaveTransaction({ to: rollup.address, success: true });
    });

    it('до фиксации ключа батчи не принимаются', async () => {
        const fresh = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode: await compile('RollupNullifier'),
                    genesisStateRoot: genesis + 1n,
                    chainId,
                },
                await compile('Rollup'),
            ),
        );
        await fresh.sendDeploy(owner.getSender(), toNano('1'));
        const result = await fresh.sendSubmitBatch(sequencer.getSender(), {
            proof: proofOf(batch1),
            hints: Cell.fromBase64(batch1.hintsBoc),
            roots: rootsOf(batch1),
            value: toNano('0.3'),
        });
        expect(result.transactions).toHaveTransaction({
            to: fresh.address,
            success: false,
            exitCode: RollupErrors.keyNotFinalized,
        });
    });
});
