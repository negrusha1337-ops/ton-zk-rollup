import { readFileSync } from 'fs';
import path from 'path';
import { Blockchain, BlockchainSnapshot, createShardAccount, internal, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier, Bn254Proof, KeyUploadJson, keyUploadFromJson } from '../wrappers/Bn254Groth16Verifier';
import {
    BatchRoots,
    NullifierErrors,
    PlantedState,
    Rollup,
    RollupConfig,
    RollupErrors,
    RollupOpcodes,
    VerifierErrors,
} from '../wrappers/Rollup';
import {
    ESCAPE_SERVICE_VALUE,
    ESCAPE_TIMEOUT_SECONDS,
    FORCE_TRANSACTION_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    MAX_BLOCK_AGE_SECONDS,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    WITHDRAW_VALUE,
} from '../wrappers/rollupValues';
import {
    batchDataHash,
    batchDigest,
    BatchPublicValues,
    dataChunkCell,
    depositHash,
    forcedTransactionCell,
    forcedTransactionHash,
    MAX_FORCED_TX_BYTES,
    merkleProofCell,
    sha256Int,
    withdrawalTree,
} from '../wrappers/rollupMath';
import { saveGasReport } from './helpers/benchResults';
import { computePhaseOf } from './helpers/gas';
import { ProtocolConstants, readProtocolConstants } from './helpers/rollupSetup';

// Лимит газа на транзакцию: конфиг сети, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;
/** Сколько секунд после времени блока тест принимает батч: внутри maxBlockAge. */
const BATCH_DELAY = 60;

type Words = Record<keyof BatchPublicValues, string>;
type RootsJson = Record<keyof BatchRoots, string>;
type BatchFixture = {
    roots: RootsJson;
    /** Порции данных батча, которые секвенсор публикует до отправки пруфа. */
    dataChunksHex: string[];
    /** Одиннадцать слов, под дайджест которых построен пруф. */
    publicValues: Words;
    publicInput: string;
    proof: string[];
    hintsBoc: string;
    /** «Лучшая подделка»: тот же пруф под батч с другим словом состояния, подсказки честные. */
    forgery: { newStateRoot: string; publicInput: string; hintsBoc: string };
    /** Подделка второго вида: вход верный, точка C пруфа испорчена, подсказки честные. */
    tamperedProof: { c: string[]; hintsBoc: string };
};
const read = (...parts: string[]) => JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', ...parts), 'utf8'));
const scenario = read('rollup_batches', 'batches.json') as {
    protocolVersion: number;
    chainId: string;
    genesisStateRoot: string;
    words: (keyof BatchPublicValues)[];
    deposit: { l2Recipient: string; value: string; amount: string };
    forcedTransactionHex: string;
    /** queueHashes[n] — хеш очереди L1 после n элементов. */
    queueHashes: string[];
    withdrawals: { leafIndex: number; recipientHash: string; amount: string; rootAfter: string }[];
    batches: BatchFixture[];
    /** Пруф батча 3 с честными подсказками под дайджест, в котором подменено одно слово. */
    wordForgeries: { word: keyof BatchPublicValues; index: number; alteredValue: string; publicInput: string; hintsBoc: string }[];
    fullQueue: Omit<BatchFixture, 'roots' | 'tamperedProof'> & { batchIndexBefore: number };
    attacks: {
        forgedPriorWithdrawals: {
            roots: RootsJson;
            claimedPrevWithdrawalsRoot: string;
            claimedPrevWithdrawalsCount: string;
            publicInput: string;
            proof: string[];
            hintsBoc: string;
        };
    };
};
const keyFixture = read('multiplier_bn254', 'onchain.json').hinted as { vkDataBoc: string; keyUpload: KeyUploadJson };

const proofOf = (batch: { proof: string[] }): Bn254Proof => {
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
const rootsFrom = (roots: RootsJson): BatchRoots => ({
    newStateRoot: BigInt(roots.newStateRoot),
    withdrawalsRoot: BigInt(roots.withdrawalsRoot),
    withdrawalsCount: BigInt(roots.withdrawalsCount),
    queueProcessedUpTo: BigInt(roots.queueProcessedUpTo),
    blockTimestamp: BigInt(roots.blockTimestamp),
});
const rootsOf = (batch: BatchFixture) => rootsFrom(batch.roots);
const wordsOf = (batch: { publicValues: Words }): BatchPublicValues =>
    Object.fromEntries(Object.entries(batch.publicValues).map(([word, value]) => [word, BigInt(value)])) as BatchPublicValues;
const dataOf = (batch: { dataChunksHex: string[] }) => batch.dataChunksHex.map((hex) => dataChunkCell(Buffer.from(hex, 'hex')));
const addressOf = (hash: bigint) => new Address(0, Buffer.from(hash.toString(16).padStart(64, '0'), 'hex'));

// Сквозной путь протокола v2 на НАСТОЯЩЕМ контракте (contracts/rollup.tolk): ключ загружается
// частями, батчи принимаются только с верным Groth16-пруфом на BN254. Пруфы — игрушечной
// схемы: они привязаны к дайджесту одиннадцати слов батча, но переход состояния не доказывают
// (zk/gen-rollup-batches.mjs). SP1 для этого не нужен: проверяется всё, что делает контракт, —
// сборка дайджеста из хранилища и сообщения, верификатор, применение батча, газ.
describe('Rollup: настоящая проверка пруфа, протокол v2', () => {
    const genesis = BigInt(scenario.genesisStateRoot);
    const chainId = BigInt(scenario.chainId);
    const [batch1, batch2, batch3] = scenario.batches;
    const key = keyUploadFromJson(keyFixture.keyUpload);
    const vkData = Cell.fromBase64(keyFixture.vkDataBoc);
    const queueHashes = scenario.queueHashes.map(BigInt);
    const forcedBytes = Buffer.from(scenario.forcedTransactionHex, 'hex');
    const leaves = scenario.withdrawals.map((leaf) => ({
        leafIndex: leaf.leafIndex,
        recipientHash: BigInt(leaf.recipientHash),
        amount: BigInt(leaf.amount),
    }));
    const gas: Record<string, number> = {};

    let code: Cell;
    let nullifierCode: Cell;
    let constants: ProtocolConstants;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let config: RollupConfig;
    let ready: BlockchainSnapshot;

    const rejected = (result: { transactions: unknown }, exitCode: number, on = rollup) =>
        expect(result.transactions).toHaveTransaction({ to: on.address, success: false, exitCode });
    const accepted = (result: { transactions: unknown }, on = rollup) =>
        expect(result.transactions).toHaveTransaction({ to: on.address, success: true });
    const gasOf = (result: { transactions: Parameters<typeof computePhaseOf>[0] }, on = rollup) =>
        Number(computePhaseOf(result.transactions, on.address).gasUsed);
    /** Время L1 — через минуту после времени блока этого батча. */
    const at = (roots: BatchRoots, shift = BATCH_DELAY) => {
        blockchain.now = Number(roots.blockTimestamp) + shift;
    };
    const send = (
        batch: { proof: string[]; hintsBoc: string },
        roots: BatchRoots,
        overrides: { hintsBoc?: string; proof?: Bn254Proof; on?: SandboxContract<Rollup>; from?: SandboxContract<TreasuryContract> } = {},
    ) =>
        (overrides.on ?? rollup).sendSubmitBatch((overrides.from ?? sequencer).getSender(), {
            proof: overrides.proof ?? proofOf(batch),
            hints: Cell.fromBase64(overrides.hintsBoc ?? batch.hintsBoc),
            roots,
            value: SUBMIT_BATCH_VALUE,
        });
    /** Батч фикстуры в своё время. */
    const submit = (batch: BatchFixture) => {
        at(rootsOf(batch));
        return send(batch, rootsOf(batch));
    };
    const publishData = async (batch: { dataChunksHex: string[] }, batchIndex: number, chunks = dataOf(batch), on = rollup) => {
        for (const data of chunks) {
            const result = await on.sendPublishData(sequencer.getSender(), { batchIndex, data, value: PUBLISH_DATA_VALUE });
            accepted(result, on);
            gas.publishData = gasOf(result, on);
        }
    };
    const depositFromScenario = () =>
        rollup.sendDeposit(user.getSender(), {
            l2Recipient: BigInt(scenario.deposit.l2Recipient),
            value: BigInt(scenario.deposit.value),
        });
    const forceFromScenario = () =>
        rollup.sendForceTransaction(user.getSender(), {
            l2Transaction: forcedTransactionCell(forcedBytes),
            value: FORCE_TRANSACTION_VALUE,
        });
    /** Полный путь сценария до батча `upTo` включительно. */
    const acceptBatches = async (upTo: 1 | 2 | 3) => {
        accepted(await depositFromScenario());
        accepted(await submit(batch1));
        if (upTo === 1) return;
        accepted(await forceFromScenario());
        await publishData(batch2, 2);
        accepted(await submit(batch2));
        if (upTo === 2) return;
        await publishData(batch3, 3);
        accepted(await submit(batch3));
    };
    /** Настоящий контракт с подложенным состоянием и уже собранным ключом игрушечной схемы. */
    const plant = async (planted: PlantedState, overrides: Partial<RollupConfig> = {}) => {
        const contract = Rollup.createPlanted({ ...config, ...overrides }, { vkData, ...planted }, code);
        await blockchain.setShardAccount(
            contract.address,
            createShardAccount({ address: contract.address, code, data: contract.init!.data, balance: toNano('5') }),
        );
        return blockchain.openContract(contract);
    };
    const stored = async (contract = rollup) => {
        const account = (await blockchain.getContract(contract.address)).accountState;
        if (account?.type !== 'active') throw new Error('контракт не развёрнут');
        return Rollup.queueFromData(account.state.data!);
    };

    beforeAll(async () => {
        code = await compile('Rollup');
        nullifierCode = await compile('RollupNullifier');
        constants = await readProtocolConstants(code, nullifierCode);
        blockchain = await Blockchain.create();
        blockchain.now = Number(batch1.roots.blockTimestamp) - 3600;
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        user = await blockchain.treasury('user');
        config = {
            owner: owner.address,
            sequencer: sequencer.address,
            nullifierCode,
            genesisStateRoot: genesis,
            chainId,
            escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
            maxBlockAge: MAX_BLOCK_AGE_SECONDS,
        };
        rollup = blockchain.openContract(Rollup.createFromConfig(config, code));
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key)) {
            accepted(await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE }));
        }
        // Ключ фиксируется обычным путём: начальное слово состояния сценария — генезис протокола.
        accepted(await rollup.sendFinalizeKey(owner.getSender(), { key, value: KEY_FINALIZE_VALUE }));
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
        blockchain.now = Number(batch1.roots.blockTimestamp) - 3600;
    });

    afterAll(() => {
        const submits = Object.entries(gas).filter(([name]) => name.startsWith('submitBatch'));
        if (submits.length > 0) {
            gas.submitBatchWorst = Math.max(...submits.map(([, used]) => used));
            gas.submitBatchHeadroom = TX_GAS_LIMIT - gas.submitBatchWorst;
        }
        saveGasReport(
            'rollup-submit-batch.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupProof.spec.ts на настоящем контракте; не редактировать вручную',
                note: 'Газ транзакций rollup-контракта протокола v2 с настоящей проверкой пруфа BN254 (один переменный публичный вход — дайджест одиннадцати слов); пруфы — игрушечной схемы. submitBatch — отметка очереди в её середине, очередь из одного элемента, без данных; submitBatchWithData — отметка в середине, две порции данных; submitBatchAtHead — отметка на голове очереди, данные, ненулевые прежние корень и счётчик выводов; submitBatchFullQueue — словарь очереди заполнен до предела (maxTrackedItems − 1 записей), отметка в его середине, отрезок в maxBatchQueueItems элементов, данные. submitBatchWorst — наибольший из них, submitBatchHeadroom — запас до лимита газа транзакции. rejectedForgery и rejectedForgeryFullQueue — «лучшая подделка», отклонённая замыкающим равенством. depositFullQueue и forceTransactionFullQueue — шаги очереди на том же полном словаре при самой глубокой вставке (см. bench/rollup-queue-gas.json — те же шаги на двойнике).',
                gasLimit: TX_GAS_LIMIT,
                maxTrackedItems: constants.maxTrackedItems,
                maxBatchQueueItems: constants.maxBatchQueueItems,
                maxForcedTxBytes: constants.maxForcedTxBytes,
            },
            gas,
            [
                'submitBatch',
                'submitBatchWithData',
                'submitBatchAtHead',
                'submitBatchFullQueue',
                'submitBatchWorst',
                'submitBatchHeadroom',
                'publishData',
                'deposit',
                'forceTransaction',
                'withdraw',
                'rejectedForgery',
                'rejectedForgeryFullQueue',
                'depositFullQueue',
                'forceTransactionFullQueue',
            ],
        );
        console.table(gas);
    });

    it('ключ собран, а сценарий фикстуры согласован с арифметикой контракта и TypeScript', async () => {
        expect(await rollup.getKeyHash()).toBe(BigInt('0x' + vkData.hash().toString('hex')));
        expect(scenario.protocolVersion).toBe(constants.protocolVersion);
        // Начальное слово состояния сценария — константа генезиса контракта: иначе ключ не зафиксировался бы.
        expect(genesis).toBe(constants.genesisHash);
        expect(scenario.words).toHaveLength(11);
        // Очередь L1 и дерево выводов сценария пересчитываются в TypeScript.
        const afterDeposit = depositHash(0n, BigInt(scenario.deposit.l2Recipient), BigInt(scenario.deposit.amount));
        expect(queueHashes).toEqual([0n, afterDeposit, forcedTransactionHash(afterDeposit, forcedBytes)]);
        expect(forcedBytes.length).toBeLessThanOrEqual(MAX_FORCED_TX_BYTES);
        expect(withdrawalTree(leaves.slice(0, 1)).root).toBe(BigInt(scenario.withdrawals[0].rootAfter));
        expect(withdrawalTree(leaves).root).toBe(BigInt(scenario.withdrawals[1].rootAfter));
        for (const batch of [...scenario.batches, scenario.fullQueue]) {
            const words = wordsOf(batch);
            // Пруф построен под дайджест ровно этих одиннадцати слов.
            expect(batchDigest(words)).toBe(BigInt(batch.publicInput));
            expect(words.batchHash).toBe(batchDataHash(dataOf(batch)));
            expect(words.chainId).toBe(chainId);
        }
        // Батч 1 — без данных; у батча 3 все одиннадцать слов ненулевые.
        expect(batch1.dataChunksHex).toEqual([]);
        expect(Object.values(wordsOf(batch3)).every((word) => word !== 0n)).toBe(true);
        // До первого сообщения контракт требует от батча 1 другой вход: в очереди ещё нет депозита,
        // но отметка N = 0 и хеш в ней те же — вход совпадает; проверяется и это.
        expect(await rollup.getExpectedPublicInput(rootsOf(batch1))).toBe(BigInt(batch1.publicInput));
    });

    it('полный путь: депозит → батч → принудительная транзакция → два батча с данными → выводы', async () => {
        // Депозит приходит до первого батча, но блок 1 его не обрабатывает: отметка N = 0 лежит
        // в середине очереди, и хеш в ней контракт берёт из словаря.
        const deposit = await depositFromScenario();
        accepted(deposit);
        gas.deposit = gasOf(deposit);
        expect(await rollup.getExpectedPublicInput(rootsOf(batch1))).toBe(BigInt(batch1.publicInput));
        const first = await submit(batch1);
        expect(first.transactions).toHaveTransaction({ from: sequencer.address, to: rollup.address, success: true });
        gas.submitBatch = gasOf(first);
        expect(gas.submitBatch).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: rootsOf(batch1).newStateRoot,
            withdrawalsRoot: 0n,
            batchIndex: 1,
            withdrawalsCount: 0n,
        });
        expect((await rollup.getDepositQueue()).processed).toEqual({ count: 0n, hash: 0n });

        // Принудительная транзакция встаёт вторым элементом; батч 2 обрабатывает только депозит.
        const forced = await forceFromScenario();
        accepted(forced);
        gas.forceTransaction = gasOf(forced);
        expect((await rollup.getDepositQueue()).head).toEqual({ count: 2n, hash: queueHashes[2] });
        await publishData(batch2, 2);
        expect(await rollup.getExpectedPublicInput(rootsOf(batch2))).toBe(BigInt(batch2.publicInput));
        const second = await submit(batch2);
        accepted(second);
        gas.submitBatchWithData = gasOf(second);
        expect(gas.submitBatchWithData).toBeLessThan(TX_GAS_LIMIT);
        expect((await rollup.getDepositQueue()).processed).toEqual({ count: 1n, hash: queueHashes[1] });
        expect(await rollup.getBatchDataHash(2)).toBe(0n); // запись о данных принятого батча удалена

        // Батч 3: отметка на голове очереди, прежние корень и счётчик выводов уже не нулевые.
        await publishData(batch3, 3);
        expect(await rollup.getExpectedPublicInput(rootsOf(batch3))).toBe(BigInt(batch3.publicInput));
        const third = await submit(batch3);
        accepted(third);
        gas.submitBatchAtHead = gasOf(third);
        expect(gas.submitBatchAtHead).toBeLessThan(TX_GAS_LIMIT);
        const queue = await rollup.getDepositQueue();
        expect(queue.processed).toEqual(queue.head);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: rootsOf(batch3).newStateRoot,
            withdrawalsRoot: BigInt(scenario.withdrawals[1].rootAfter),
            batchIndex: 3,
            withdrawalsCount: 2n,
        });

        // Выводы обоих листьев по корню, который опубликовал батч 3.
        const tree = withdrawalTree(leaves);
        const withdraw = (leaf: (typeof leaves)[number]) =>
            rollup.sendWithdraw(user.getSender(), {
                leafIndex: leaf.leafIndex,
                recipient: addressOf(leaf.recipientHash),
                amount: leaf.amount,
                merkleProof: merkleProofCell(tree.proofFor(leaf.leafIndex)),
                value: WITHDRAW_VALUE,
            });
        for (const leaf of leaves) {
            const recipient = addressOf(leaf.recipientHash);
            const paid = await withdraw(leaf);
            expect(paid.transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: leaf.amount });
            gas.withdraw = gasOf(paid);
            expect((await blockchain.getContract(recipient)).balance).toBe(leaf.amount);
        }
        const again = await withdraw(leaves[0]);
        expect(again.transactions).toHaveTransaction({
            from: rollup.address,
            to: await rollup.getNullifierAddress(leaves[0].leafIndex),
            success: false,
            exitCode: NullifierErrors.alreadyClaimed,
        });
        expect((await blockchain.getContract(addressOf(leaves[0].recipientHash))).balance).toBe(leaves[0].amount);
    });

    it('принятый батч нельзя отправить повторно, а батчи — применить не по порядку', async () => {
        await depositFromScenario();
        accepted(await submit(batch1));
        // Повтор: прежнее слово состояния изменилось, контракт требует другой вход, а наклоны в
        // подсказках посчитаны для входа пруфа — отказ на первом же сложении.
        rejected(await submit(batch1), VerifierErrors.wrongSlope);
        expect((await rollup.getRollupState()).batchIndex).toBe(1);

        // Батч 2 раньше батча 1 (на исходном состоянии): очередь и данные — как он ждёт, но
        // прежнее слово состояния — генезис, а не слово батча 1.
        await blockchain.loadFrom(ready);
        blockchain.now = Number(batch1.roots.blockTimestamp) - 3600;
        await depositFromScenario();
        await forceFromScenario();
        await publishData(batch2, 1);
        expect(await rollup.getBatchDataHash(1)).toBe(BigInt(batch2.publicValues.batchHash));
        rejected(await submit(batch2), VerifierErrors.wrongSlope);
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
    });

    it('батч не принимается, пока его данные не опубликованы в TON', async () => {
        await acceptBatches(1);
        await forceFromScenario();
        // Данных нет: контракт подставляет нулевой хеш, и настоящий пруф к нему не подходит.
        rejected(await submit(batch2), VerifierErrors.wrongSlope);
        expect((await rollup.getRollupState()).batchIndex).toBe(1);

        // Опубликованы другие данные (порции в обратном порядке) — пруф тоже не подходит.
        await publishData(batch2, 2, dataOf(batch2).reverse());
        rejected(await submit(batch2), VerifierErrors.wrongSlope);
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
        // Отказ откатил транзакцию целиком: запись о данных на месте.
        expect(await rollup.getBatchDataHash(2)).toBe(batchDataHash(dataOf(batch2).reverse()));
    });

    describe('подделки и отказы на настоящем контракте', () => {
        // Строку `assert (ok) throw WrongProof` исполняют только «лучшие подделки»: подсказки
        // посчитаны честно для ложного утверждения — ложно только само утверждение. Пруф с
        // неподходящими подсказками падает раньше, на проверке наклонов (7006).
        it('«лучшая подделка» батча отклоняется замыкающим равенством, а не раньше', async () => {
            const forgedRoots = { ...rootsOf(batch1), newStateRoot: BigInt(batch1.forgery.newStateRoot) };
            at(forgedRoots);
            expect(await rollup.getExpectedPublicInput(forgedRoots)).toBe(BigInt(batch1.forgery.publicInput));
            const result = await send(batch1, forgedRoots, { hintsBoc: batch1.forgery.hintsBoc });
            rejected(result, RollupErrors.wrongProof);
            // Отказ — после всей проверки: газ почти тот же, что у принятого батча.
            gas.rejectedForgery = gasOf(result);
            expect(gas.rejectedForgery).toBeGreaterThan(800_000);
            expect(gas.rejectedForgery).toBeLessThan(TX_GAS_LIMIT);
            expect(await rollup.getRollupState()).toEqual({ stateRoot: genesis, withdrawalsRoot: 0n, batchIndex: 0, withdrawalsCount: 0n });
            // Тот же пруф с честными подсказками и честными значениями принимается.
            accepted(await submit(batch1));
        });

        it('подделка второго батча (с очередью и данными) тоже отклоняется, данные остаются', async () => {
            await acceptBatches(1);
            await forceFromScenario();
            await publishData(batch2, 2);
            const forgedRoots = { ...rootsOf(batch2), newStateRoot: BigInt(batch2.forgery.newStateRoot) };
            at(forgedRoots);
            rejected(await send(batch2, forgedRoots, { hintsBoc: batch2.forgery.hintsBoc }), RollupErrors.wrongProof);
            expect((await rollup.getRollupState()).batchIndex).toBe(1);
            expect((await rollup.getDepositQueue()).processed.count).toBe(0n);
            expect(await rollup.getBatchDataHash(2)).toBe(batchDataHash(dataOf(batch2)));
            accepted(await submit(batch2));
        });

        it('подделка второго вида: верный вход, испорченная точка C пруфа, честные подсказки', async () => {
            // Первая подделка — верный пруф под чужой вход. Здесь наоборот: вход тот, что требует
            // контракт, а пруф негоден (к точке C прибавлена образующая; точка остаётся на кривой,
            // поэтому проверка точек её пропускает). Отказ — замыкающим равенством.
            const proof = proofOf(batch1);
            const tampered = batch1.tamperedProof;
            at(rootsOf(batch1));
            const result = await send(batch1, rootsOf(batch1), {
                proof: { ...proof, c: [BigInt(tampered.c[0]), BigInt(tampered.c[1])] },
                hintsBoc: tampered.hintsBoc,
            });
            rejected(result, RollupErrors.wrongProof);
            expect((await rollup.getRollupState()).batchIndex).toBe(0);
        });

        it('пруф с точкой не на кривой отклоняется до всякой арифметики; батч от постороннего — до пруфа', async () => {
            const proof = proofOf(batch1);
            at(rootsOf(batch1));
            rejected(
                await send(batch1, rootsOf(batch1), { proof: { ...proof, a: [proof.a[0], proof.a[1] + 1n] } }),
                VerifierErrors.pointNotOnCurve,
            );
            rejected(await send(batch1, rootsOf(batch1), { from: user }), RollupErrors.notSequencer);
            expect((await rollup.getRollupState()).batchIndex).toBe(0);
        });

        it('дерево выводов продолжается только от корня и счётчика из хранилища: приписать лист нельзя', async () => {
            // Атака из первого круга проверки на настоящем контракте: секвенсор предъявляет ЧЕСТНЫЙ
            // пруф батча 3, построенного от поддельного прежнего дерева выводов (с лишним листом в
            // свою пользу: другой корень, счётчик на единицу больше).
            await acceptBatches(2);
            await publishData(batch3, 3);
            const attack = scenario.attacks.forgedPriorWithdrawals;
            const forgedRoots = rootsFrom(attack.roots);
            // Контракт требует вход, посчитанный от СВОИХ прежних корня и счётчика, а не от заявленных.
            expect(await rollup.getExpectedPublicInput(forgedRoots)).not.toBe(BigInt(attack.publicInput));
            expect(BigInt(attack.claimedPrevWithdrawalsRoot)).not.toBe(BigInt(scenario.withdrawals[0].rootAfter));
            expect(BigInt(attack.claimedPrevWithdrawalsCount)).not.toBe(1n);
            at(forgedRoots);
            rejected(await send(attack, forgedRoots), VerifierErrors.wrongSlope);
            const state = await rollup.getRollupState();
            expect(state.withdrawalsRoot).toBe(BigInt(scenario.withdrawals[0].rootAfter));
            expect(state.withdrawalsCount).toBe(1n);
            // Честный батч 3 продолжает ненулевые прежние корень и счётчик и принимается.
            accepted(await submit(batch3));
        });

        it("пруф одного rollup'а не подходит другому с тем же ключом и тем же состоянием", async () => {
            // Двойник отличается только идентификатором: тот же код, тот же ключ, тот же генезис.
            const twin = blockchain.openContract(Rollup.createFromConfig({ ...config, chainId: chainId + 1n }, code));
            await twin.sendDeploy(owner.getSender(), toNano('5'));
            for (const { slot, part } of Bn254Groth16Verifier.keyParts(key)) {
                await twin.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
            }
            accepted(await twin.sendFinalizeKey(owner.getSender(), { key, value: KEY_FINALIZE_VALUE }), twin);
            expect(await twin.getKeyHash()).toBe(await rollup.getKeyHash());
            expect(await twin.getChainId()).toBe(chainId + 1n);
            at(rootsOf(batch1));
            rejected(await send(batch1, rootsOf(batch1), { on: twin }), VerifierErrors.wrongSlope, twin);
            expect((await twin.getRollupState()).batchIndex).toBe(0);
            accepted(await send(batch1, rootsOf(batch1)));
        });
    });

    describe('каждое из одиннадцати слов привязано к пруфу', () => {
        // Пруф батча 3 — настоящий, для настоящих одиннадцати слов. Для каждого слова контракт
        // приводится в состояние, где он требует дайджест с подменённым словом: слово из
        // сообщения — меняется сообщение, слово из хранилища — меняется хранилище (состояние
        // «перед батчем 3» подложено, и одно его поле изменено). Подсказки к пруфу посчитаны
        // ЧЕСТНО под этот дайджест, поэтому отказать может только замыкающее равенство — 7300.
        const base = wordsOf(batch3);
        /** Состояние контракта перед батчем 3 — то же, что строят сообщения полного пути. */
        const beforeBatch3 = (words: BatchPublicValues): { planted: PlantedState; overrides: Partial<RollupConfig> } => {
            const pendingData = Rollup.pendingDataDictionary();
            pendingData.set(3n, words.batchHash);
            return {
                overrides: { chainId: words.chainId, genesisStateRoot: words.prevStateRoot },
                planted: {
                    withdrawalsRoot: words.prevWithdrawalsRoot,
                    withdrawalsCount: words.prevWithdrawalsCount,
                    batchIndex: 2n,
                    queue: {
                        head: { count: 2n, hash: words.newDepositHash },
                        processed: { count: 1n, hash: words.prevDepositHash },
                    },
                    pendingData,
                },
            };
        };
        const rootsFor = (words: BatchPublicValues): BatchRoots => ({
            newStateRoot: words.newStateRoot,
            withdrawalsRoot: words.withdrawalsRoot,
            withdrawalsCount: words.withdrawalsCount,
            queueProcessedUpTo: 2n,
            blockTimestamp: words.blockTimestamp,
        });

        it('подложенное состояние перед батчем 3 — то же, что построили сообщения; честный батч на нём принят', async () => {
            await acceptBatches(2);
            await publishData(batch3, 3);
            const viaMessages = await rollup.getExpectedPublicInput(rootsOf(batch3));
            const { planted, overrides } = beforeBatch3(base);
            const twin = await plant(planted, overrides);
            expect(rootsFor(base)).toEqual(rootsOf(batch3));
            expect(await twin.getExpectedPublicInput(rootsOf(batch3))).toBe(viaMessages);
            expect(viaMessages).toBe(BigInt(batch3.publicInput));
            at(rootsOf(batch3));
            accepted(await send(batch3, rootsOf(batch3), { on: twin }), twin);
            expect((await twin.getRollupState()).batchIndex).toBe(3);
        });

        it('в фикстуре — подмена каждого слова по одному разу, в порядке протокола', () => {
            expect(scenario.wordForgeries.map(({ word }) => word)).toEqual(scenario.words);
            expect(scenario.wordForgeries.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
            expect(new Set(scenario.wordForgeries.map(({ publicInput }) => publicInput)).size).toBe(11);
        });

        it.each(scenario.wordForgeries.map((forgery) => [forgery.index, forgery.word, forgery] as const))(
            'слово %i (%s) подменено → отказ замыкающим равенством, код 7300',
            async (_, word, forgery) => {
                const altered = { ...base, [word]: BigInt(forgery.alteredValue) };
                expect(altered[word]).not.toBe(base[word]);
                // Вход с подменённым словом пересчитывается в TypeScript и не равен настоящему.
                expect(batchDigest(altered)).toBe(BigInt(forgery.publicInput));
                expect(BigInt(forgery.publicInput)).not.toBe(BigInt(batch3.publicInput));
                const { planted, overrides } = beforeBatch3(altered);
                const target = await plant(planted, overrides);
                const roots = rootsFor(altered);
                at(roots);
                // Контракт требует ровно этот вход: подменённое слово действительно в него входит.
                expect(await target.getExpectedPublicInput(roots)).toBe(BigInt(forgery.publicInput));
                const result = await send(batch3, roots, { hintsBoc: forgery.hintsBoc, on: target });
                expect(RollupErrors.wrongProof).toBe(7300);
                rejected(result, RollupErrors.wrongProof, target);
                // Отказ — после всей проверки пруфа, а не на первой же сверке подсказок.
                expect(gasOf(result, target)).toBeGreaterThan(800_000);
                const state = await target.getRollupState();
                expect(state.batchIndex).toBe(2);
                expect(state.stateRoot).toBe(altered.prevStateRoot);
                // С подсказками настоящего пруфа тот же батч падает раньше — на проверке наклонов:
                // до замыкающего равенства доводят только честные подсказки под ложный вход.
                rejected(await send(batch3, roots, { on: target }), VerifierErrors.wrongSlope, target);
            },
        );
    });

    describe('время блока и отметка очереди на настоящем контракте', () => {
        it('блок из будущего и устаревший блок отклоняются до проверки пруфа; на границах батч принят', async () => {
            const roots = rootsOf(batch1);
            const timestamp = Number(roots.blockTimestamp);
            blockchain.now = timestamp - 1;
            rejected(await send(batch1, roots), RollupErrors.blockFromFuture);
            blockchain.now = timestamp + MAX_BLOCK_AGE_SECONDS + 1;
            rejected(await send(batch1, roots), RollupErrors.blockTooOld);
            expect((await rollup.getRollupState()).batchIndex).toBe(0);
            // Ровно на границах — принят (каждая граница — на своей копии состояния).
            for (const now of [timestamp + MAX_BLOCK_AGE_SECONDS, timestamp]) {
                await blockchain.loadFrom(ready);
                blockchain.now = now;
                accepted(await send(batch1, roots));
            }
        });

        it('отметка вне очереди отклоняется до проверки пруфа', async () => {
            await depositFromScenario();
            const roots = rootsOf(batch1);
            at(roots);
            rejected(await send(batch1, { ...roots, queueProcessedUpTo: 2n }), RollupErrors.queueMarkOutOfRange);
            // Отметка в пределах очереди, но не та, под которую построен пруф: другой хеш в точке N.
            rejected(await send(batch1, { ...roots, queueProcessedUpTo: 1n }), VerifierErrors.wrongSlope);
            accepted(await send(batch1, roots));
        });
    });

    describe('остальные сообщения на настоящем контракте', () => {
        // Двойник и настоящий контракт отличаются только проверкой пруфа, но это утверждение о
        // тексте кода. Здесь те ветки точки входа rollup.tolk, которые иначе исполнял бы только
        // двойник, проходят на настоящем коде — с суммами сообщений из wrappers/rollupValues.ts.
        const claimedBody = (key: bigint, recipient: Address, amount: bigint) =>
            beginCell()
                .storeUint(RollupOpcodes.nullifierClaimed, 32)
                .storeUint(0, 64)
                .storeUint(key, 256)
                .storeAddress(recipient)
                .storeCoins(amount)
                .endCell();

        it('принудительная транзакция встаёт в очередь с keccak-256 её байтов; негодная форма и длина — отказ', async () => {
            accepted(await forceFromScenario());
            expect((await rollup.getDepositQueue()).head).toEqual({ count: 1n, hash: forcedTransactionHash(0n, forcedBytes) });
            const twoRefs = beginCell()
                .storeBuffer(Buffer.alloc(8, 1))
                .storeRef(beginCell().endCell())
                .storeRef(beginCell().storeUint(1, 8).endCell())
                .endCell();
            const tooLong = beginCell()
                .storeBuffer(Buffer.alloc(127, 1))
                .storeRef(beginCell().storeBuffer(Buffer.alloc(127, 2)).storeRef(beginCell().storeBuffer(Buffer.alloc(3, 3)).endCell()).endCell())
                .endCell();
            for (const l2Transaction of [twoRefs, tooLong]) {
                const malformed = await rollup.sendForceTransaction(user.getSender(), { l2Transaction, value: FORCE_TRANSACTION_VALUE });
                rejected(malformed, RollupErrors.malformedForcedTransaction);
            }
            expect((await rollup.getDepositQueue()).head.count).toBe(1n);
        });

        it('секвенсор сбрасывает данные батча; посторонний — нет', async () => {
            await publishData(batch2, 1);
            expect(await rollup.getBatchDataHash(1)).toBe(batchDataHash(dataOf(batch2)));
            rejected(
                await rollup.sendDiscardBatchData(user.getSender(), { batchIndex: 1, value: ESCAPE_SERVICE_VALUE }),
                RollupErrors.notSequencer,
            );
            accepted(await rollup.sendDiscardBatchData(sequencer.getSender(), { batchIndex: 1, value: ESCAPE_SERVICE_VALUE }));
            expect(await rollup.getBatchDataHash(1)).toBe(0n);
            // После сброса батч 1 (без данных) принимается своим пруфом.
            accepted(await submit(batch1));
        });

        it('подтверждение «от нуллификатора» с чужого адреса не приводит к выплате', async () => {
            await acceptBatches(2);
            const forged = await user.send({
                to: rollup.address,
                value: toNano('0.05'),
                body: claimedBody(0n, user.address, leaves[0].amount),
            });
            rejected(forged, RollupErrors.notNullifier);
            expect(await rollup.getOwedPayout(0n)).toBeNull();
        });

        it('шаг выплаты на худшем остатке монет: при нехватке баланса пишет долг, PayOwed его выплачивает', async () => {
            await acceptBatches(2);
            const leaf = leaves[0];
            const recipient = addressOf(leaf.recipientHash);
            const budgets = await rollup.getPayoutBudgets();
            // Баланс контракта «съеден» (в жизни — платой за хранение): выплатить нечем.
            (await blockchain.getContract(rollup.address)).balance = toNano('0.01');
            // Подтверждение приходит с адреса настоящего нуллификатора листа 0 и несёт ровно
            // столько монет, сколько нуллификатор гарантирует шагу выплаты, — худший случай.
            const confirmation = await blockchain.sendMessage(
                internal({
                    from: await rollup.getNullifierAddress(leaf.leafIndex),
                    to: rollup.address,
                    value: budgets.payoutStepValue,
                    bounce: false,
                    body: claimedBody(BigInt(leaf.leafIndex), recipient, leaf.amount),
                }),
            );
            accepted(confirmation);
            expect(gasOf(confirmation)).toBeLessThan(budgets.payoutStepGas);
            expect((await blockchain.getContract(recipient)).balance).toBe(0n);
            const debt = await rollup.getOwedPayout(BigInt(leaf.leafIndex));
            expect(debt?.recipient.toString()).toBe(recipient.toString());
            expect(debt?.amount).toBe(leaf.amount);

            // Денег нет — долг остаётся; пополнили — выплачивается, один раз.
            const pay = () => rollup.sendPayOwed(user.getSender(), { key: BigInt(leaf.leafIndex), value: ESCAPE_SERVICE_VALUE });
            rejected(await pay(), RollupErrors.insufficientFunds);
            await owner.send({ to: rollup.address, value: toNano('1') });
            expect((await pay()).transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: leaf.amount });
            expect((await blockchain.getContract(recipient)).balance).toBe(leaf.amount);
            rejected(await pay(), RollupErrors.nothingOwed);
        });

        it('заморозка: батч и данные после неё не принимаются даже с верным пруфом; депозит возвращается', async () => {
            await acceptBatches(2);
            // Принудительная транзакция (элемент 2) так и не обработана; следом встаёт депозит.
            accepted(await depositFromScenario());
            const { oldestPendingAt } = await rollup.getEscapeState();
            await publishData(batch3, 3);
            blockchain.now = oldestPendingAt + ESCAPE_TIMEOUT_SECONDS;
            rejected(await rollup.sendActivateEscapeHatch(user.getSender(), ESCAPE_SERVICE_VALUE), RollupErrors.escapeNotDue);
            blockchain.now = oldestPendingAt + ESCAPE_TIMEOUT_SECONDS + 1;
            accepted(await rollup.sendActivateEscapeHatch(user.getSender(), ESCAPE_SERVICE_VALUE));
            expect((await rollup.getEscapeState()).frozen).toBe(true);

            // Отказ по заморозке — раньше проверки времени блока и пруфа.
            rejected(await send(batch3, rootsOf(batch3)), RollupErrors.rollupFrozen);
            const data = await rollup.sendPublishData(sequencer.getSender(), { batchIndex: 3, data: dataOf(batch3)[0], value: PUBLISH_DATA_VALUE });
            rejected(data, RollupErrors.rollupFrozen);
            rejected(await depositFromScenario(), RollupErrors.rollupFrozen);

            // Депозит 1 обработан батчем 2 — возврату не подлежит; у транзакции (2) квитанции нет;
            // поздний депозит (3) возвращается вносителю, кто бы ни попросил.
            const cancel = (depositIndex: number) =>
                rollup.sendCancelDeposit(sequencer.getSender(), { depositIndex, value: ESCAPE_SERVICE_VALUE });
            rejected(await cancel(1), RollupErrors.depositAlreadyProcessed);
            rejected(await cancel(2), RollupErrors.noSuchDeposit);
            const receipt = await rollup.getDepositReceipt(3);
            expect(receipt?.depositor.toString()).toBe(user.address.toString());
            expect((await cancel(3)).transactions).toHaveTransaction({ from: rollup.address, to: user.address, value: receipt!.amount });
            expect(await rollup.getDepositReceipt(3)).toBeNull();
            // Явная уборка, доступная любому, на настоящем контракте проходит и ничего не ломает.
            accepted(await rollup.sendPruneDepositReceipts(sequencer.getSender(), { count: 5, value: ESCAPE_SERVICE_VALUE }));
            // Вывод по корню из батча 2 работает и после заморозки.
            const tree = withdrawalTree(leaves.slice(0, 1));
            const withdrawn = await rollup.sendWithdraw(user.getSender(), {
                leafIndex: 0,
                recipient: addressOf(leaves[0].recipientHash),
                amount: leaves[0].amount,
                merkleProof: merkleProofCell(tree.proofFor(0)),
                value: WITHDRAW_VALUE,
            });
            expect(withdrawn.transactions).toHaveTransaction({ from: rollup.address, to: addressOf(leaves[0].recipientHash), value: leaves[0].amount });
        });
    });

    describe('газ на словаре очереди, заполненном до предела (REVIEW.md, 14-1 и 14-6)', () => {
        const full = scenario.fullQueue;
        const words = wordsOf(full);
        /** Сколько записей «убрано», чтобы следующая постановка получила номер из одних единиц (см. tests/RollupQueue.spec.ts). */
        const deepestBase = () => {
            const tracked = BigInt(constants.maxTrackedItems);
            let next = 1n;
            while (next < 2n * tracked - 1n) next = next * 2n + 1n;
            return next - tracked;
        };
        /**
         * Настоящий контракт со словарём очереди из maxTrackedItems − 1 записей с номерами подряд;
         * необработанных — `unprocessed`. Запись `hashAt.index` несёт заданный хеш очереди.
         */
        const fullQueue = async (unprocessed: bigint, processedHash: bigint, hashAt?: { index: bigint; hashBefore: bigint }) => {
            const pruned = deepestBase();
            const count = BigInt(constants.maxTrackedItems) - 1n;
            const items = Rollup.queueItemsDictionary();
            for (let index = pruned + 1n; index <= pruned + count; index++) {
                items.set(index, {
                    hashBefore: hashAt?.index === index ? hashAt.hashBefore : sha256Int(index),
                    queuedAt: Number(words.blockTimestamp),
                    receipt: index % 3n === 0n ? null : { depositor: user.address, amount: toNano('1') },
                });
            }
            const head = pruned + count;
            return plant(
                {
                    withdrawalsRoot: words.prevWithdrawalsRoot,
                    withdrawalsCount: words.prevWithdrawalsCount,
                    batchIndex: BigInt(full.batchIndexBefore),
                    queue: {
                        head: { count: head, hash: sha256Int(head + 1n) },
                        processed: { count: head - unprocessed, hash: processedHash },
                        prunedCount: pruned,
                    },
                    queueItems: items,
                },
                { genesisStateRoot: words.prevStateRoot },
            );
        };

        it('SubmitBatch на полном словаре: отметка в середине очереди, полный отрезок, данные — и «лучшая подделка» там же', async () => {
            const segment = BigInt(constants.maxBatchQueueItems);
            const unprocessed = segment + 8n;
            const head = deepestBase() + BigInt(constants.maxTrackedItems) - 1n;
            const mark = head - unprocessed + segment;
            // Хеш очереди в точке N лежит в записи элемента N + 1.
            const target = await fullQueue(unprocessed, words.prevDepositHash, { index: mark + 1n, hashBefore: words.newDepositHash });
            expect((await stored(target)).items.size).toBe(constants.maxTrackedItems - 1);
            expect(mark).toBeLessThan(head);
            const roots: BatchRoots = {
                newStateRoot: words.newStateRoot,
                withdrawalsRoot: words.withdrawalsRoot,
                withdrawalsCount: words.withdrawalsCount,
                queueProcessedUpTo: mark,
                blockTimestamp: words.blockTimestamp,
            };
            at(roots);
            await publishData(full, full.batchIndexBefore + 1, dataOf(full), target);
            expect(await target.getExpectedPublicInput(roots)).toBe(BigInt(full.publicInput));

            // Подделка на том же состоянии: отказ замыкающим равенством, состояние не тронуто.
            const forgedRoots = { ...roots, newStateRoot: BigInt(full.forgery.newStateRoot) };
            expect(await target.getExpectedPublicInput(forgedRoots)).toBe(BigInt(full.forgery.publicInput));
            const forged = await send(full, forgedRoots, { hintsBoc: full.forgery.hintsBoc, on: target });
            rejected(forged, RollupErrors.wrongProof, target);
            gas.rejectedForgeryFullQueue = gasOf(forged, target);
            expect(gas.rejectedForgeryFullQueue).toBeLessThan(TX_GAS_LIMIT);

            const result = await send(full, roots, { on: target });
            accepted(result, target);
            gas.submitBatchFullQueue = gasOf(result, target);
            expect(gas.submitBatchFullQueue).toBeLessThan(TX_GAS_LIMIT);
            const after = await stored(target);
            expect(after.processed).toEqual({ count: mark, hash: words.newDepositHash });
            // Батч записей не удаляет и счётчик убранных не трогает.
            expect(after.items.size).toBe(constants.maxTrackedItems - 1);
            expect(after.prunedCount).toBe(deepestBase());
            expect(await target.getRollupState()).toEqual({
                stateRoot: words.newStateRoot,
                withdrawalsRoot: words.withdrawalsRoot,
                batchIndex: full.batchIndexBefore + 1,
                withdrawalsCount: words.withdrawalsCount,
            });
        });

        it('депозит и принудительная транзакция наибольшей длины на настоящем контракте — на самой глубокой вставке', async () => {
            const budgets = await rollup.getQueueBudgets();
            const fresh = () => fullQueue(3n, sha256Int(7n));
            let target = await fresh();
            const before = await stored(target);
            const newIndex = before.head.count + 1n;
            // Номер новой записи — из одних единиц: последний лист заполненного поддерева.
            expect(newIndex & (newIndex + 1n)).toBe(0n);
            blockchain.now = Number(words.blockTimestamp) + BATCH_DELAY;

            const deposited = await target.sendDeposit(user.getSender(), {
                l2Recipient: BigInt(scenario.deposit.l2Recipient),
                value: BigInt(scenario.deposit.value),
            });
            accepted(deposited, target);
            gas.depositFullQueue = gasOf(deposited, target);
            expect(gas.depositFullQueue).toBeLessThanOrEqual(budgets.depositStepGas);
            expect((await stored(target)).head).toEqual({
                count: newIndex,
                hash: depositHash(before.head.hash, BigInt(scenario.deposit.l2Recipient), BigInt(scenario.deposit.amount)),
            });
            expect((await stored(target)).prunedCount).toBe(before.prunedCount + 2n);

            target = await fresh();
            const longest = Buffer.from(Array.from({ length: constants.maxForcedTxBytes }, (_, index) => (index * 131 + 7) & 255));
            const forced = await target.sendForceTransaction(user.getSender(), {
                l2Transaction: forcedTransactionCell(longest),
                value: FORCE_TRANSACTION_VALUE,
            });
            accepted(forced, target);
            gas.forceTransactionFullQueue = gasOf(forced, target);
            expect(gas.forceTransactionFullQueue).toBeLessThanOrEqual(budgets.forceTransactionStepGas);
            expect((await stored(target)).head).toEqual({ count: newIndex, hash: forcedTransactionHash(before.head.hash, longest) });
        });
    });
});
