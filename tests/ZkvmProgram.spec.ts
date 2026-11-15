// @ts-nocheck
// НАБОР ПРОТОКОЛА v1. Написан под обёртки и пруфы прежнего протокола (дайджест из восьми слов,
// сообщения ForceExit и SetExitKey); с контрактом протокола v2 несовместим. Не удалён и не
// подогнан: пока пруфы в fixtures/ не перестроены под v2 (wrappers/protocolVersion.ts), набор
// помечает себя todo через describeWithProofFixtures и не типизируется. Перенос на v2 — вместе
// с шагом программы и пруфов (PROTOCOL-V2.md, раздел 11); прежняя версия целиком — тег protocol-v1.
import { describeWithProofFixtures } from './helpers/protocolGate';
import { createHash } from 'crypto';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { finalizeDummyKeys } from './helpers/rollupSetup';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';
import { Rollup } from '../wrappers/Rollup';
import { ESCAPE_TIMEOUT_SECONDS } from '../wrappers/rollupValues';
import {
    batchDataHash,
    batchDigest,
    dataChunkCell,
    depositHash,
    forcedTransactionHash,
    merkleProofCell,
    withdrawalTree,
} from '../wrappers/rollupMath';
import { FORCE_TRANSACTION_VALUE } from '../wrappers/rollupValues';
import {
    BatchOutput,
    dataChunksOf,
    forcedTransactionsOf,
    loadExitScenario,
    loadZkvmScenario,
    withdrawalLeavesAfterBatch3Of,
    withdrawalLeavesOf,
} from '../wrappers/zkvmProofs';

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
describeWithProofFixtures('Программа zkVM и rollup-контракт согласованы', () => {
    const [batch1, batch2, batch3] = program.batches;
    let genesis: BlockchainSnapshot;
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
                    escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
                },
                await compile('RollupMock'),
            ),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
        await finalizeDummyKeys(rollup, owner);
        genesis = blockchain.snapshot();
    });

    // Каждый тест начинает с генезиса: тесты не зависят от порядка и друг от друга.
    beforeEach(async () => {
        await blockchain.loadFrom(genesis);
    });

    it('дайджест публичных значений считается так же, как в верификаторе SP1', () => {
        for (const batch of program.batches) {
            const bytes = Buffer.from(batch.publicValuesHex, 'hex');
            expect(bytes).toHaveLength(256);
            const digest = BigInt('0x' + createHash('sha256').update(bytes).digest('hex')) & MASK_253;
            expect(digest).toBe(BigInt(batch.publicInput));
            expect(digest).toBe(
                batchDigest({
                    chainId: BigInt(program.chainId),
                    prevStateRoot: BigInt(batch.prevStateRoot),
                    ...rootsOf(batch),
                    batchHash: BigInt(batch.roots.batchHash),
                    prevWithdrawalsRoot: BigInt(batch.prevWithdrawalsRoot),
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

    /** Принимает батч сценария на двойнике: публикует его данные и сверяет публичный вход. */
    const accept = async (batch: BatchOutput, batchIndex: number) => {
        for (const data of dataChunksOf(batch)) {
            const published = await rollup.sendPublishData(sequencer.getSender(), {
                batchIndex,
                data,
                value: toNano('0.05'),
            });
            expect(published.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        expect(await rollup.getBatchDataHash(batchIndex)).toBe(BigInt(batch.roots.batchHash));
        // Контракт требует ровно тот публичный вход, который выдала программа.
        expect(await rollup.getExpectedPublicInput(rootsOf(batch))).toBe(BigInt(batch.publicInput));
        expect((await submit(batch)).transactions).toHaveTransaction({ to: rollup.address, success: true });
    };
    const depositOf = (deposit: { l2Recipient: string; value: string }) =>
        rollup.sendDeposit(user.getSender(), { l2Recipient: BigInt(deposit.l2Recipient), value: BigInt(deposit.value) });
    /** Очередь L1 сценария до батча 1: депозит и принудительные транзакции. */
    const queueBeforeBatch1 = async () => {
        expect((await depositOf(program.deposit)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        for (const l2Transaction of forcedTransactionsOf(program)) {
            const result = await rollup.sendForceTransaction(user.getSender(), {
                l2Transaction,
                value: FORCE_TRANSACTION_VALUE,
            });
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
    };
    /** Весь сценарий: три батча; второй депозит приходит между батчами 1 и 2. */
    const runScenario = async () => {
        await queueBeforeBatch1();
        await accept(batch1, 1);
        expect((await depositOf(program.secondDeposit)).transactions).toHaveTransaction({
            to: rollup.address,
            success: true,
        });
        await accept(batch2, 2);
        await accept(batch3, 3);
    };

    it('сценарий: депозит и принудительные транзакции → батч 1 → второй депозит → батч 2 → батч 3 → выводы', async () => {
        // Депозит на L1 приходит до первого батча; за ним — принудительные транзакции L2,
        // которые ставит в очередь кто угодно: корректный вывод Алисы и мусор.
        await queueBeforeBatch1();
        const afterDeposit = depositHash(0n, BigInt(program.deposit.l2Recipient), BigInt(program.deposit.amount));
        const forced = forcedTransactionsOf(program);
        expect(forced.length).toBe(2);
        const queue = await rollup.getDepositQueue();
        const queued = queue.head.hash;
        expect(queue.head.count).toBe(3n);
        expect(queued).toBe(forced.reduce(forcedTransactionHash, afterDeposit));

        expect(BigInt(batch1.prevStateRoot)).toBe(BigInt(program.genesisStateRoot));
        await accept(batch1, 1);

        // Второй депозит встаёт в очередь после батча 1: батч 2 его не обрабатывает, батч 3 — обязан.
        expect((await depositOf(program.secondDeposit)).transactions).toHaveTransaction({
            to: rollup.address,
            success: true,
        });
        const afterSecondDeposit = depositHash(
            queued,
            BigInt(program.secondDeposit.l2Recipient),
            BigInt(program.secondDeposit.amount),
        );
        expect((await rollup.getDepositQueue()).head).toEqual({ count: 4n, hash: afterSecondDeposit });

        // Батч 2 обязан обработать очередь до цели — депозит и обе принудительные транзакции:
        // программа пришла к тому же хешу очереди, что и контракт.
        expect(BigInt(batch2.newDepositHash)).toBe(queued);
        expect(BigInt(batch2.prevStateRoot)).toBe(rootsOf(batch1).newStateRoot);
        // Пока данные батча не опубликованы, контракт ждёт другой публичный вход.
        expect(await rollup.getExpectedPublicInput(rootsOf(batch2))).not.toBe(BigInt(batch2.publicInput));
        await accept(batch2, 2);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: rootsOf(batch2).newStateRoot,
            withdrawalsRoot: rootsOf(batch2).withdrawalsRoot,
            batchIndex: 2,
        });

        // Батч 3 продолжает НЕНУЛЕВЫЕ прежние корни: дерево выводов батча 2 и хеш очереди, на
        // котором тот остановился. В батчах 1 и 2 оба прежних значения нулевые, и программа,
        // коммитящая вместо них ноль, сошлась бы с контрактом; здесь она разойдётся.
        expect(BigInt(batch3.prevWithdrawalsRoot)).toBe(rootsOf(batch2).withdrawalsRoot);
        expect(BigInt(batch3.prevWithdrawalsRoot)).not.toBe(0n);
        expect(BigInt(batch3.prevDepositHash)).toBe(queued);
        expect(BigInt(batch3.prevDepositHash)).not.toBe(0n);
        expect(BigInt(batch3.newDepositHash)).toBe(afterSecondDeposit);
        // В байтах программы эти значения стоят на местах слов 5 и 7 (с единицы).
        const bytes = Buffer.from(batch3.publicValuesHex, 'hex');
        const word = (index: number) => BigInt('0x' + bytes.subarray(index * 32, (index + 1) * 32).toString('hex'));
        expect(word(4)).toBe(rootsOf(batch2).withdrawalsRoot);
        expect(word(6)).toBe(queued);
        await accept(batch3, 3);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: rootsOf(batch3).newStateRoot,
            withdrawalsRoot: rootsOf(batch3).withdrawalsRoot,
            batchIndex: 3,
        });
        expect((await rollup.getDepositQueue()).processed).toEqual({ count: 4n, hash: afterSecondDeposit });

        // Выводы: дерево, построенное программой, сходится с деревом, которое проверяет контракт.
        // Лист 0 — принудительный вывод Алисы из очереди L1, лист 1 — вывод Боба через
        // секвенсор, лист 2 — вывод Алисы в батче 3.
        expect(withdrawalTree(withdrawalLeavesOf(program)).root).toBe(rootsOf(batch2).withdrawalsRoot);
        const leaves = withdrawalLeavesAfterBatch3Of(program);
        expect(leaves.length).toBe(3);
        const tree = withdrawalTree(leaves);
        expect(tree.root).toBe(rootsOf(batch3).withdrawalsRoot);
        for (const { leafIndex, recipientHash, amount } of leaves) {
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
        }
    });

    it('пустое дерево выводов: корень — ноль в программе, в контракте и в скриптах', async () => {
        // Батч 1 сценария выводов не содержит: программа выдаёт нулевой корень, скрипты — тоже,
        // а контракт после его приёма хранит ноль.
        expect(BigInt(batch1.roots.withdrawalsRoot)).toBe(0n);
        expect(withdrawalTree([]).root).toBe(0n);
        expect((await rollup.getRollupState()).withdrawalsRoot).toBe(0n);
        await queueBeforeBatch1();
        await accept(batch1, 1);
        expect((await rollup.getRollupState()).withdrawalsRoot).toBe(0n);
    });

    it('заявки на аварийный выход: программа выхода и контракт считают один и тот же публичный вход', async () => {
        // Двойник принимает все три батча сценария: его корень состояния — тот, из которого
        // программа выхода (zkvm/exit-lib) посчитала заявки. Пруфа здесь нет: сверяется формат
        // пяти слов и их дайджест.
        await runScenario();
        const exits = loadExitScenario();
        expect((await rollup.getRollupState()).stateRoot).toBe(BigInt(exits.stateRoot));
        expect(exits.claims.map((claim) => claim.name)).toEqual(['alice', 'bob']);
        for (const claim of exits.claims) {
            const recipientHash = BigInt(claim.recipientHash).toString(16).padStart(64, '0');
            const values = Buffer.from(claim.publicValuesHex, 'hex');
            expect(values.length).toBe(160);
            const digest = BigInt('0x' + createHash('sha256').update(values).digest('hex')) & MASK_253;
            expect(digest).toBe(BigInt(claim.publicInput));
            expect(
                await rollup.getExpectedExitInput({
                    l2Account: BigInt(claim.l2Account),
                    amount: BigInt(claim.amount),
                    recipient: new Address(0, Buffer.from(recipientHash, 'hex')),
                }),
            ).toBe(digest);
        }
    });

    it('каждое слово из сообщения меняет публичный вход, который требует контракт', async () => {
        // На генезисе контракт ждёт вход батча 1; подмена любого из двух корней сообщения
        // даёт другой вход — и только она (сравниваются два ответа одного get-метода).
        const honest = await rollup.getExpectedPublicInput(rootsOf(batch1));
        expect(honest).toBe(BigInt(batch1.publicInput));
        const { newStateRoot, withdrawalsRoot } = rootsOf(batch1);
        expect(await rollup.getExpectedPublicInput({ newStateRoot: newStateRoot ^ 1n, withdrawalsRoot })).not.toBe(honest);
        expect(await rollup.getExpectedPublicInput({ newStateRoot, withdrawalsRoot: withdrawalsRoot ^ 1n })).not.toBe(
            honest,
        );
    });
});
