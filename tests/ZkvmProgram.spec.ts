import { createHash } from 'crypto';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';
import { Rollup } from '../wrappers/Rollup';
import {
    batchDataHash,
    batchDigest,
    dataChunkCell,
    depositHash,
    merkleProofCell,
    withdrawalTree,
} from '../wrappers/rollupMath';
import { BatchOutput, dataChunksOf, loadZkvmScenario } from '../wrappers/zkvmProofs';

const program = loadZkvmScenario();

const MASK_253 = (1n << 253n) - 1n;
const rootsOf = (batch: BatchOutput) => ({
    newStateRoot: BigInt(batch.roots.newStateRoot),
    withdrawalsRoot: BigInt(batch.roots.withdrawalsRoot),
});
// Заглушка пруфа для тестового двойника контракта.
const ACCEPTED: Bn254Proof = {
    a: [1n, 0n],
    b: [
        [0n, 0n],
        [0n, 0n],
    ],
    c: [0n, 0n],
};

// Программа перехода состояния для zkVM (zkvm/lib) выдаёт публичные значения; контракт
// независимо считает, какой публичный вход он потребует. Тест сверяет одно с другим на
// сценарии «депозит → два батча → вывод». Пруфа здесь нет: проверяется формат и
// согласованность правил, поэтому контракт — двойник с заглушкой проверки.
describe('Программа zkVM и rollup-контракт согласованы', () => {
    const [batch1, batch2] = program.batches;
    let blockchain: Blockchain;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;

    const submit = (batch: BatchOutput) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: ACCEPTED,
            hints: beginCell().endCell(),
            roots: rootsOf(batch),
            value: toNano('0.2'),
        });

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        const owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        user = await blockchain.treasury('user');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode: await compile('RollupNullifier'),
                    genesisStateRoot: BigInt(program.genesisStateRoot),
                    chainId: BigInt(program.chainId),
                },
                await compile('RollupMock'),
            ),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
    });

    it('дайджест публичных значений считается так же, как в верификаторе SP1', () => {
        for (const batch of program.batches) {
            const bytes = Buffer.from(batch.publicValuesHex, 'hex');
            expect(bytes).toHaveLength(224);
            const digest = BigInt('0x' + createHash('sha256').update(bytes).digest('hex')) & MASK_253;
            expect(digest).toBe(BigInt(batch.publicInput));
            expect(digest).toBe(
                batchDigest({
                    chainId: BigInt(program.chainId),
                    prevStateRoot: BigInt(batch.prevStateRoot),
                    ...rootsOf(batch),
                    batchHash: BigInt(batch.roots.batchHash),
                    prevDepositHash: BigInt(batch.prevDepositHash),
                    newDepositHash: BigInt(batch.newDepositHash),
                }),
            );
        }
    });

    it('хеш порции данных в программе — это хеш ячейки TON', () => {
        // Программа считает хеш дерева ячеек сама (zkvm/lib, data_chunk_hash); контракт
        // получает его от сети. Сверяем на длинах вокруг границ ячеек и уровней дерева.
        expect(program.chunkHashVectors.vectors.length).toBeGreaterThan(8);
        for (const { length, hash } of program.chunkHashVectors.vectors) {
            const data = Buffer.from(Array.from({ length }, (_, i) => (i * 31 + length * 7 + (i >> 8)) & 0xff));
            expect(dataChunkCell(data).hash().toString('hex')).toBe(hash);
        }
        // Обязательство на данные батча: ноль без данных, иначе накопительный хеш порций.
        expect(BigInt(batch1.roots.batchHash)).toBe(0n);
        expect(batch2.dataChunksHex.length).toBeGreaterThan(0);
        for (const batch of program.batches) {
            expect(BigInt(batch.roots.batchHash)).toBe(batchDataHash(dataChunksOf(batch)));
        }
    });

    it('сценарий: депозит → батч 1 → данные → батч 2 → вывод', async () => {
        // Депозит на L1 приходит до первого батча.
        const deposit = await rollup.sendDeposit(user.getSender(), {
            l2Recipient: BigInt(program.deposit.l2Recipient),
            value: BigInt(program.deposit.value),
        });
        expect(deposit.transactions).toHaveTransaction({ to: rollup.address, success: true });
        const queued = (await rollup.getDepositQueue()).head.hash;
        expect(queued).toBe(depositHash(0n, BigInt(program.deposit.l2Recipient), BigInt(program.deposit.amount)));

        // Батч 1: контракт требует ровно тот публичный вход, который выдала программа.
        expect(BigInt(batch1.prevStateRoot)).toBe(BigInt(program.genesisStateRoot));
        expect(await rollup.getExpectedPublicInput(rootsOf(batch1))).toBe(BigInt(batch1.publicInput));
        expect((await submit(batch1)).transactions).toHaveTransaction({ to: rollup.address, success: true });

        // Батч 2 обязан обработать депозит: программа пришла к тому же хешу очереди, что и контракт.
        expect(BigInt(batch2.newDepositHash)).toBe(queued);
        expect(BigInt(batch2.prevStateRoot)).toBe(rootsOf(batch1).newStateRoot);
        // Пока данные батча не опубликованы, контракт ждёт другой публичный вход.
        expect(await rollup.getExpectedPublicInput(rootsOf(batch2))).not.toBe(BigInt(batch2.publicInput));
        for (const data of dataChunksOf(batch2)) {
            const published = await rollup.sendPublishData(sequencer.getSender(), {
                batchIndex: 2,
                data,
                value: toNano('0.05'),
            });
            expect(published.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        expect(await rollup.getBatchDataHash(2)).toBe(BigInt(batch2.roots.batchHash));
        expect(await rollup.getExpectedPublicInput(rootsOf(batch2))).toBe(BigInt(batch2.publicInput));
        expect((await submit(batch2)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: rootsOf(batch2).newStateRoot,
            withdrawalsRoot: rootsOf(batch2).withdrawalsRoot,
            batchIndex: 2,
        });

        // Вывод: дерево, построенное программой, сходится с деревом, которое проверяет контракт.
        const { leafIndex } = program.withdrawal;
        const recipientHash = BigInt(program.withdrawal.recipientHash);
        const amount = BigInt(program.withdrawal.amount);
        const tree = withdrawalTree([{ leafIndex, recipientHash, amount }]);
        expect(tree.root).toBe(rootsOf(batch2).withdrawalsRoot);

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

    it('чужой корень состояния меняет публичный вход', async () => {
        const forged = { ...rootsOf(batch1), newStateRoot: rootsOf(batch1).newStateRoot ^ 1n };
        expect(await rollup.getExpectedPublicInput(forged)).not.toBe(BigInt(batch1.publicInput));
    });
});
