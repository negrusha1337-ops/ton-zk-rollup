import { readFileSync } from 'fs';
import path from 'path';
import { Blockchain, BlockchainSnapshot, internal, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier, Bn254Proof, KeyUploadJson, keyUploadFromJson } from '../wrappers/Bn254Groth16Verifier';
import {
    ExitClaim,
    exitNullifierKey,
    NullifierErrors,
    Rollup,
    RollupErrors,
    RollupOpcodes,
    VerifierErrors,
} from '../wrappers/Rollup';
import {
    ESCAPE_SERVICE_VALUE,
    ESCAPE_TIMEOUT_SECONDS,
    FORCE_EXIT_VALUE,
    FORCE_TRANSACTION_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    WITHDRAW_VALUE,
} from '../wrappers/rollupValues';
import {
    batchDataHash,
    batchDigest,
    dataChunkCell,
    depositHash,
    forcedTransactionCell,
    forcedTransactionHash,
    merkleProofCell,
    withdrawalTree,
} from '../wrappers/rollupMath';
import { saveGasReport } from './helpers/benchResults';
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
    /** «Лучшая подделка»: тот же пруф под батч с другим корнем состояния, подсказки честные. */
    forgery: { newStateRoot: string; hintsBoc: string };
    /** Подделка второго вида: вход верный, точка C пруфа испорчена, подсказки честные. */
    tamperedProof: { c: string[]; hintsBoc: string };
};
/** Аварийный выход на игрушечной схеме (zk/gen-rollup-batches.mjs): состояние — после батча 2. */
type ExitFixture = {
    l2Account: string;
    amount: string;
    recipientHash: string;
    publicInput: string;
    proof: string[];
    hintsBoc: string;
    forgery: { amount: string; hintsBoc: string };
    /** IC0 ключа выхода: отличается от ключа батчей, как у настоящих программ. */
    keyIc0: string[];
    /** Пруф батча 2 с подсказками под ключ выхода и дайджест заявки. */
    batchProofAsExit: { proof: string[]; hintsBoc: string };
};
const read = (...parts: string[]) => JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', ...parts), 'utf8'));
const scenario = read('rollup_batches', 'batches.json') as {
    chainId: string;
    genesisStateRoot: string;
    deposit: { l2Recipient: string; value: string; amount: string; hashAfter: string };
    withdrawal: { leafIndex: number; recipientHash: string; amount: string; siblings: string[]; root: string };
    batches: BatchFixture[];
    exit: ExitFixture;
    attacks: {
        forgedPriorWithdrawals: {
            roots: { newStateRoot: string; withdrawalsRoot: string };
            claimedPrevWithdrawalsRoot: string;
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
    const [batch1, batch2, batch3] = scenario.batches;
    const key = keyUploadFromJson(keyFixture.keyUpload);
    const exitKeyIc0: [bigint, bigint] = [BigInt(scenario.exit.keyIc0[0]), BigInt(scenario.exit.keyIc0[1])];
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
            value: SUBMIT_BATCH_VALUE,
        });
    const publishData = async (batch: BatchFixture, batchIndex: number, chunks = dataOf(batch)) => {
        for (const data of chunks) {
            const result = await rollup.sendPublishData(sequencer.getSender(), {
                batchIndex,
                data,
                value: PUBLISH_DATA_VALUE,
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
                    escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
                },
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key)) {
            const upload = await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
            expect(upload.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        // Ключ выхода — свой: тот же ключ со сдвинутым IC0 (zk/gen-rollup-batches.mjs). Раньше он
        // совпадал с ключом батчей, и ошибка «выход проверяется ключом батчей» прошла бы все тесты.
        await rollup.sendSetExitKey(owner.getSender(), { ic0: exitKeyIc0, value: KEY_FINALIZE_VALUE });
        const finalize = await rollup.sendFinalizeKey(owner.getSender(), { key, value: KEY_FINALIZE_VALUE });
        expect(finalize.transactions).toHaveTransaction({ to: rollup.address, success: true });
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
    });

    afterAll(() => {
        saveGasReport(
            'rollup-submit-batch.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupProof.spec.ts; не редактировать вручную',
                note: 'Газ транзакций rollup-контракта с настоящей проверкой пруфа BN254 (один переменный публичный вход); пруфы — игрушечной схемы',
                gasLimit: TX_GAS_LIMIT,
            },
            gas,
            ['submitBatch', 'submitBatchWithDeposit', 'publishData', 'deposit', 'withdraw', 'forceExit', 'rejectedForgery'],
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
                prevWithdrawalsRoot: 0n,
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
        expect(replay.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: VerifierErrors.wrongSlope,
        });
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
    });

    it('батчи нельзя применить не по порядку', async () => {
        const result = await submit(batch2);
        expect(result.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: VerifierErrors.wrongSlope,
        });
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
    });

    it('чужой корень с настоящим пруфом не проходит', async () => {
        const result = await rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: proofOf(batch1),
            hints: Cell.fromBase64(batch1.hintsBoc),
            roots: { ...rootsOf(batch1), newStateRoot: rootsOf(batch1).newStateRoot ^ 1n },
            value: SUBMIT_BATCH_VALUE,
        });
        // Подсказки посчитаны для настоящего дайджеста, а контракт требует другой: отказ
        // на первой же проверке наклона, до замыкающего равенства дело не доходит.
        expect(result.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: VerifierErrors.wrongSlope,
        });
        expect((await rollup.getRollupState()).stateRoot).toBe(genesis);
    });

    it('батч не принимается, пока его данные не опубликованы в TON', async () => {
        await depositFromScenario();
        await submit(batch1);

        // Данных нет: контракт подставляет нулевой хеш, и настоящий пруф к нему не подходит.
        const withoutData = await submit(batch2);
        expect(withoutData.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: VerifierErrors.wrongSlope,
        });
        expect((await rollup.getRollupState()).batchIndex).toBe(1);

        // Опубликованы другие данные (порции в обратном порядке) — пруф тоже не подходит.
        await publishData(batch2, 2, dataOf(batch2).reverse());
        const wrongData = await submit(batch2);
        expect(wrongData.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: VerifierErrors.wrongSlope,
        });
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
                value: WITHDRAW_VALUE,
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

    describe('подделки и отказы на настоящем контракте', () => {
        // До этого набора строку `assert (ok) throw WrongProof` настоящего контракта не
        // исполнял ни один тест: все отказы случались раньше, на проверке наклонов (7006),
        // потому что подсказки не подходили к подменённому входу. Здесь подсказки посчитаны
        // честно для ложного утверждения — ложно только само утверждение.
        it('«лучшая подделка» батча отклоняется замыкающим равенством, а не раньше', async () => {
            const forgedRoots = { ...rootsOf(batch1), newStateRoot: BigInt(batch1.forgery.newStateRoot) };
            const result = await rollup.sendSubmitBatch(sequencer.getSender(), {
                proof: proofOf(batch1),
                hints: Cell.fromBase64(batch1.forgery.hintsBoc),
                roots: forgedRoots,
                value: SUBMIT_BATCH_VALUE,
            });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.wrongProof,
            });
            // Отказ — после всей проверки: газ почти тот же, что у принятого батча.
            gas.rejectedForgery = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
            expect(gas.rejectedForgery).toBeGreaterThan(800_000);
            expect(gas.rejectedForgery).toBeLessThan(TX_GAS_LIMIT);
            expect(await rollup.getRollupState()).toEqual({ stateRoot: genesis, withdrawalsRoot: 0n, batchIndex: 0 });
            // Тот же пруф с честными подсказками и честными корнями принимается.
            expect((await submit(batch1)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        });

        it('подделка второго батча (с депозитом и данными) тоже отклоняется, данные остаются', async () => {
            await depositFromScenario();
            await submit(batch1);
            await publishData(batch2, 2);
            const result = await rollup.sendSubmitBatch(sequencer.getSender(), {
                proof: proofOf(batch2),
                hints: Cell.fromBase64(batch2.forgery.hintsBoc),
                roots: { ...rootsOf(batch2), newStateRoot: BigInt(batch2.forgery.newStateRoot) },
                value: SUBMIT_BATCH_VALUE,
            });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.wrongProof,
            });
            expect((await rollup.getRollupState()).batchIndex).toBe(1);
            expect((await rollup.getDepositQueue()).processed.count).toBe(0n);
            expect(await rollup.getBatchDataHash(2)).toBe(batchDataHash(dataOf(batch2)));
            expect((await submit(batch2)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        });

        it('дерево выводов продолжается только от корня из хранилища: приписать лист нельзя', async () => {
            // Атака из первого круга проверки, теперь исполненная целиком на настоящем
            // контракте: секвенсор предъявляет ЧЕСТНЫЙ пруф батча 3, построенного от
            // поддельного прежнего дерева выводов (с лишним листом в свою пользу).
            await depositFromScenario();
            await submit(batch1);
            await publishData(batch2, 2);
            await submit(batch2);
            const attack = scenario.attacks.forgedPriorWithdrawals;
            const forgedRoots = {
                newStateRoot: BigInt(attack.roots.newStateRoot),
                withdrawalsRoot: BigInt(attack.roots.withdrawalsRoot),
            };
            // Контракт требует вход, посчитанный от СВОЕГО прежнего корня, а не от заявленного.
            const required = await rollup.getExpectedPublicInput(forgedRoots);
            expect(required).not.toBe(BigInt(attack.publicInput));
            expect(BigInt(attack.claimedPrevWithdrawalsRoot)).not.toBe(BigInt(scenario.withdrawal.root));
            const result = await rollup.sendSubmitBatch(sequencer.getSender(), {
                proof: proofOf(attack),
                hints: Cell.fromBase64(attack.hintsBoc),
                roots: forgedRoots,
                value: SUBMIT_BATCH_VALUE,
            });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: VerifierErrors.wrongSlope,
            });
            expect((await rollup.getRollupState()).withdrawalsRoot).toBe(BigInt(scenario.withdrawal.root));

            // Честный батч 3 продолжает ненулевой прежний корень и принимается.
            expect(await rollup.getExpectedPublicInput(rootsOf(batch3))).toBe(BigInt(batch3.publicInput));
            expect((await submit(batch3)).transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await rollup.getRollupState()).toEqual({
                stateRoot: rootsOf(batch3).newStateRoot,
                withdrawalsRoot: rootsOf(batch3).withdrawalsRoot,
                batchIndex: 3,
            });
        });

        it('батч с настоящим пруфом не принимается от постороннего', async () => {
            const result = await rollup.sendSubmitBatch(user.getSender(), {
                proof: proofOf(batch1),
                hints: Cell.fromBase64(batch1.hintsBoc),
                roots: rootsOf(batch1),
                value: SUBMIT_BATCH_VALUE,
            });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notSequencer,
            });
            expect((await rollup.getRollupState()).batchIndex).toBe(0);
        });

        it('подделка второго вида: верный вход, испорченная точка C пруфа, честные подсказки', async () => {
            // Первая подделка — верный пруф под чужой вход. Здесь наоборот: вход тот, что
            // требует контракт, а пруф негоден (к точке C прибавлена образующая; точка остаётся
            // на кривой, поэтому проверка точек её пропускает). Отказ — замыкающим равенством.
            const proof = proofOf(batch1);
            const tampered = batch1.tamperedProof;
            const result = await rollup.sendSubmitBatch(sequencer.getSender(), {
                proof: { ...proof, c: [BigInt(tampered.c[0]), BigInt(tampered.c[1])] },
                hints: Cell.fromBase64(tampered.hintsBoc),
                roots: rootsOf(batch1),
                value: SUBMIT_BATCH_VALUE,
            });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.wrongProof,
            });
            expect((await rollup.getRollupState()).batchIndex).toBe(0);
        });

        it('пруф с точкой не на кривой отклоняется до всякой арифметики', async () => {
            const proof = proofOf(batch1);
            const result = await rollup.sendSubmitBatch(sequencer.getSender(), {
                proof: { ...proof, a: [proof.a[0], proof.a[1] + 1n] },
                hints: Cell.fromBase64(batch1.hintsBoc),
                roots: rootsOf(batch1),
                value: SUBMIT_BATCH_VALUE,
            });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: VerifierErrors.pointNotOnCurve,
            });
        });
    });

    describe('остальные сообщения на настоящем контракте', () => {
        // Двойник и настоящий контракт отличаются только проверкой пруфа, но это утверждение о
        // тексте кода. Здесь те ветки точки входа rollup.tolk, которые иначе исполнял бы только
        // двойник, проходят на настоящем коде — с суммами сообщений из wrappers/rollupValues.ts.
        const recipientOfLeaf = () => {
            const hash = BigInt(scenario.withdrawal.recipientHash).toString(16).padStart(64, '0');
            return new Address(0, Buffer.from(hash, 'hex'));
        };
        const acceptTwoBatches = async () => {
            await depositFromScenario();
            await submit(batch1);
            await publishData(batch2, 2);
            await submit(batch2);
        };
        const claimedBody = (key: bigint, recipient: Address, amount: bigint) =>
            beginCell()
                .storeUint(RollupOpcodes.nullifierClaimed, 32)
                .storeUint(0, 64)
                .storeUint(key, 256)
                .storeAddress(recipient)
                .storeCoins(amount)
                .endCell();

        it('принудительная транзакция встаёт в очередь с хешем пересобранной ячейки', async () => {
            const transaction = forcedTransactionCell(Buffer.alloc(110, 0x5a));
            const result = await rollup.sendForceTransaction(user.getSender(), {
                l2Transaction: transaction,
                value: FORCE_TRANSACTION_VALUE,
            });
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await rollup.getDepositQueue()).toMatchObject({
                head: { count: 1n, hash: forcedTransactionHash(0n, transaction) },
            });
            const withRef = beginCell().storeBuffer(Buffer.alloc(8, 1)).storeRef(transaction).endCell();
            const malformed = await rollup.sendForceTransaction(user.getSender(), {
                l2Transaction: withRef,
                value: FORCE_TRANSACTION_VALUE,
            });
            expect(malformed.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.malformedForcedTransaction,
            });
        });

        it('секвенсор сбрасывает данные батча; посторонний — нет', async () => {
            await publishData(batch2, 1);
            expect(await rollup.getBatchDataHash(1)).toBe(batchDataHash(dataOf(batch2)));
            const stranger = await rollup.sendDiscardBatchData(user.getSender(), {
                batchIndex: 1,
                value: ESCAPE_SERVICE_VALUE,
            });
            expect(stranger.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notSequencer,
            });
            const discard = await rollup.sendDiscardBatchData(sequencer.getSender(), {
                batchIndex: 1,
                value: ESCAPE_SERVICE_VALUE,
            });
            expect(discard.transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await rollup.getBatchDataHash(1)).toBe(0n);
            // После сброса батч 1 (без данных) принимается своим пруфом.
            expect((await submit(batch1)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        });

        it('подтверждение «от нуллификатора» с чужого адреса не приводит к выплате', async () => {
            await acceptTwoBatches();
            const amount = BigInt(scenario.withdrawal.amount);
            const forged = await user.send({
                to: rollup.address,
                value: toNano('0.05'),
                body: claimedBody(0n, user.address, amount),
            });
            expect(forged.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notNullifier,
            });
            expect(await rollup.getOwedPayout(0n)).toBeNull();
        });

        it('шаг выплаты на худшем остатке монет: при нехватке баланса пишет долг, PayOwed его выплачивает', async () => {
            await acceptTwoBatches();
            const recipient = recipientOfLeaf();
            const amount = BigInt(scenario.withdrawal.amount);
            const budgets = await rollup.getPayoutBudgets();
            // Баланс контракта «съеден» (в жизни — платой за хранение): выплатить нечем.
            (await blockchain.getContract(rollup.address)).balance = toNano('0.01');
            // Подтверждение приходит с адреса настоящего нуллификатора листа 0 и несёт ровно
            // столько монет, сколько нуллификатор гарантирует шагу выплаты, — худший случай.
            const confirmation = await blockchain.sendMessage(
                internal({
                    from: await rollup.getNullifierAddress(scenario.withdrawal.leafIndex),
                    to: rollup.address,
                    value: budgets.payoutStepValue,
                    bounce: false,
                    body: claimedBody(BigInt(scenario.withdrawal.leafIndex), recipient, amount),
                }),
            );
            expect(confirmation.transactions).toHaveTransaction({ to: rollup.address, success: true });
            const used = Number(computePhaseOf(confirmation.transactions, rollup.address).gasUsed);
            expect(used).toBeLessThan(budgets.payoutStepGas);
            expect((await blockchain.getContract(recipient)).balance).toBe(0n);
            const debt = await rollup.getOwedPayout(BigInt(scenario.withdrawal.leafIndex));
            expect(debt?.recipient.toString()).toBe(recipient.toString());
            expect(debt?.amount).toBe(amount);

            // Денег нет — долг остаётся; пополнили — выплачивается, один раз.
            const pay = () =>
                rollup.sendPayOwed(user.getSender(), {
                    key: BigInt(scenario.withdrawal.leafIndex),
                    value: ESCAPE_SERVICE_VALUE,
                });
            expect((await pay()).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.insufficientFunds,
            });
            await owner.send({ to: rollup.address, value: toNano('1') });
            expect((await pay()).transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: amount });
            expect((await blockchain.getContract(recipient)).balance).toBe(amount);
            expect((await pay()).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.nothingOwed,
            });
        });
    });

    describe('аварийный выход на настоящем контракте', () => {
        // Ключ выхода в этом наборе — ключ игрушечной схемы со сдвинутым IC0: пруф выхода
        // проходит настоящую проверку ForceExit только под ним, а под ключом батчей — нет.
        // Выход по пруфам программы SP1 — в tests/RollupEscapeProof.spec.ts.
        const exit = scenario.exit;
        const recipient = new Address(0, Buffer.from(BigInt(exit.recipientHash).toString(16).padStart(64, '0'), 'hex'));
        const claim: ExitClaim = { l2Account: BigInt(exit.l2Account), amount: BigInt(exit.amount), recipient };
        const START = 1_900_000_000;
        const forceExit = (hintsBoc: string, exitClaim: ExitClaim) =>
            rollup.sendForceExit(user.getSender(), {
                proof: proofOf(exit),
                hints: Cell.fromBase64(hintsBoc),
                claim: exitClaim,
                value: FORCE_EXIT_VALUE,
            });
        /** Два батча приняты; поздний депозит ждёт дольше срока; rollup заморожен. */
        const freezeAfterBatch2 = async () => {
            blockchain.now = START;
            await depositFromScenario();
            await submit(batch1);
            await publishData(batch2, 2);
            await submit(batch2);
            await depositFromScenario(); // этот депозит уже никто не обработает
            blockchain.now = START + ESCAPE_TIMEOUT_SECONDS + 1;
            const frozen = await rollup.sendActivateEscapeHatch(user.getSender(), ESCAPE_SERVICE_VALUE);
            expect(frozen.transactions).toHaveTransaction({ to: rollup.address, success: true });
        };

        it('заявка фикстуры согласована с арифметикой контракта', async () => {
            await freezeAfterBatch2();
            expect(await rollup.getExpectedExitInput(claim)).toBe(BigInt(exit.publicInput));
            // Ключ выхода и ключ батчей различаются; оба зафиксированы.
            expect(await rollup.getExitKeyHash()).not.toBe(await rollup.getKeyHash());
            expect(await rollup.getExitKeyHash()).not.toBe(0n);
            expect(exitKeyIc0).not.toEqual(key.ic0);
        });

        it('пруф батча не годится как пруф выхода, даже с честными подсказками под ключ выхода', async () => {
            // Ключи двух программ различаются одной константой. Пруф батча 2, предъявленный как
            // пруф выхода, обязан быть отклонён замыкающим равенством — а не только потому, что
            // к нему приложены неподходящие подсказки.
            await freezeAfterBatch2();
            const result = await rollup.sendForceExit(user.getSender(), {
                proof: proofOf(exit.batchProofAsExit),
                hints: Cell.fromBase64(exit.batchProofAsExit.hintsBoc),
                claim,
                value: FORCE_EXIT_VALUE,
            });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.wrongProof,
            });
            expect((await blockchain.getContract(recipient)).balance).toBe(0n);
        });

        it('получатель вне basechain отклоняется, хотя пруф верен и дайджест совпадает', async () => {
            // Пруф привязан только к ХЕШУ адреса получателя, а ForceExit шлёт кто угодно. Адрес
            // masterchain с тем же хешем даёт тот же дайджест, то есть пруф к нему подходит:
            // без проверки workchain посторонний увёл бы чужой выход на другой адрес и погасил
            // нуллификатор счёта. Отказать обязана именно эта проверка.
            await freezeAfterBatch2();
            const masterchain = new Address(-1, recipient.hash);
            expect(await rollup.getExpectedExitInput({ ...claim, recipient: masterchain })).toBe(
                BigInt(exit.publicInput),
            );
            const result = await forceExit(exit.hintsBoc, { ...claim, recipient: masterchain });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.wrongRecipient,
            });
            for (const address of [recipient, masterchain]) {
                expect((await blockchain.getContract(address)).balance).toBe(0n);
            }
            const nullifier = await rollup.getExitNullifierAddress(claim.l2Account);
            expect((await blockchain.getContract(nullifier)).accountState?.type ?? 'uninit').toBe('uninit');
        });

        it('после заморозки необработанный депозит возвращается вносителю (суммы — как в testnet)', async () => {
            await freezeAfterBatch2();
            // Первый депозит обработан батчем 2, второй (номер 2) — нет.
            const receipt = await rollup.getDepositReceipt(2);
            expect(receipt?.depositor.toString()).toBe(user.address.toString());
            const processed = await rollup.sendCancelDeposit(user.getSender(), {
                depositIndex: 1,
                value: ESCAPE_SERVICE_VALUE,
            });
            expect(processed.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.depositAlreadyProcessed,
            });
            const refund = await rollup.sendCancelDeposit(sequencer.getSender(), {
                depositIndex: 2,
                value: ESCAPE_SERVICE_VALUE,
            });
            expect(refund.transactions).toHaveTransaction({
                from: rollup.address,
                to: user.address,
                value: receipt!.amount,
            });
            expect(await rollup.getDepositReceipt(2)).toBeNull();
            // Квитанцию обработанного депозита уже убрал второй депозит (попутная уборка);
            // явная уборка, доступная любому, на настоящем контракте проходит и ничего не ломает.
            expect(await rollup.getDepositReceipt(1)).toBeNull();
            const prune = await rollup.sendPruneDepositReceipts(sequencer.getSender(), {
                count: 5,
                value: ESCAPE_SERVICE_VALUE,
            });
            expect(prune.transactions).toHaveTransaction({ to: rollup.address, success: true });
        });

        it('до заморозки выход не принимается даже с верным пруфом', async () => {
            blockchain.now = START;
            await depositFromScenario();
            await submit(batch1);
            await publishData(batch2, 2);
            await submit(batch2);
            expect((await forceExit(exit.hintsBoc, claim)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupNotFrozen,
            });
        });

        it('выход с верным пруфом выплачивает ровно сумму заявки, один раз', async () => {
            await freezeAfterBatch2();
            const result = await forceExit(exit.hintsBoc, claim);
            expect(result.transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: claim.amount });
            gas.forceExit = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
            expect(gas.forceExit).toBeLessThan(TX_GAS_LIMIT);
            expect((await blockchain.getContract(recipient)).balance).toBe(claim.amount);

            const again = await forceExit(exit.hintsBoc, claim);
            expect(again.transactions).toHaveTransaction({
                to: await rollup.getExitNullifierAddress(claim.l2Account),
                success: false,
                exitCode: NullifierErrors.alreadyClaimed,
            });
            expect((await blockchain.getContract(recipient)).balance).toBe(claim.amount);
            expect(await rollup.getOwedPayout(exitNullifierKey(claim.l2Account))).toBeNull();
        });

        it('«лучшая подделка» выхода — тот же пруф под вдвое большую сумму — отклоняется замыкающим равенством', async () => {
            await freezeAfterBatch2();
            const greedy = { ...claim, amount: BigInt(exit.forgery.amount) };
            const result = await forceExit(exit.forgery.hintsBoc, greedy);
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.wrongProof,
            });
            expect((await blockchain.getContract(recipient)).balance).toBe(0n);
            const nullifier = await rollup.getExitNullifierAddress(claim.l2Account);
            expect((await blockchain.getContract(nullifier)).accountState?.type ?? 'uninit').toBe('uninit');
            // Честный выход после неудачной подделки по-прежнему доступен.
            expect((await forceExit(exit.hintsBoc, claim)).transactions).toHaveTransaction({
                from: rollup.address,
                to: recipient,
                value: claim.amount,
            });
        });

        it('верный пруф под другого получателя, другой счёт или другую сумму не подходит', async () => {
            await freezeAfterBatch2();
            const variants: ExitClaim[] = [
                { ...claim, recipient: user.address },
                { ...claim, l2Account: claim.l2Account + 1n },
                { ...claim, amount: claim.amount + 1n },
            ];
            for (const variant of variants) {
                expect((await forceExit(exit.hintsBoc, variant)).transactions).toHaveTransaction({
                    to: rollup.address,
                    success: false,
                    exitCode: VerifierErrors.wrongSlope,
                });
            }
            expect((await blockchain.getContract(recipient)).balance).toBe(0n);
        });

        it('после заморозки батч не принимается даже с верным пруфом', async () => {
            blockchain.now = START;
            await depositFromScenario();
            await submit(batch1);
            await depositFromScenario();
            blockchain.now = START + ESCAPE_TIMEOUT_SECONDS + 1;
            await rollup.sendActivateEscapeHatch(user.getSender(), ESCAPE_SERVICE_VALUE);
            // Данные замороженный rollup тоже не принимает.
            const data = await rollup.sendPublishData(sequencer.getSender(), {
                batchIndex: 2,
                data: dataOf(batch2)[0],
                value: PUBLISH_DATA_VALUE,
            });
            expect(data.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupFrozen,
            });
            expect((await submit(batch2)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupFrozen,
            });
        });
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
                    escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
                },
                await compile('Rollup'),
            ),
        );
        await twin.sendDeploy(owner.getSender(), toNano('5'));
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key)) {
            await twin.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
        }
        await twin.sendSetExitKey(owner.getSender(), { ic0: key.ic0, value: KEY_FINALIZE_VALUE });
        await twin.sendFinalizeKey(owner.getSender(), { key, value: KEY_FINALIZE_VALUE });
        expect(await twin.getKeyHash()).toBe(await rollup.getKeyHash());
        expect(await twin.getChainId()).toBe(chainId + 1n);

        // Настоящий пруф батча 1 нашего rollup'а: у себя принимается, у двойника — нет.
        const result = await twin.sendSubmitBatch(sequencer.getSender(), {
            proof: proofOf(batch1),
            hints: Cell.fromBase64(batch1.hintsBoc),
            roots: rootsOf(batch1),
            value: SUBMIT_BATCH_VALUE,
        });
        expect(result.transactions).toHaveTransaction({
            to: twin.address,
            success: false,
            exitCode: VerifierErrors.wrongSlope,
        });
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
                    escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
                },
                await compile('Rollup'),
            ),
        );
        await fresh.sendDeploy(owner.getSender(), toNano('1'));
        const result = await fresh.sendSubmitBatch(sequencer.getSender(), {
            proof: proofOf(batch1),
            hints: Cell.fromBase64(batch1.hintsBoc),
            roots: rootsOf(batch1),
            value: SUBMIT_BATCH_VALUE,
        });
        expect(result.transactions).toHaveTransaction({
            to: fresh.address,
            success: false,
            exitCode: RollupErrors.keyNotFinalized,
        });
    });
});
