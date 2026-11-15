// @ts-nocheck
// НАБОР ПРОТОКОЛА v1. Написан под обёртки и пруфы прежнего протокола (дайджест из восьми слов,
// сообщения ForceExit и SetExitKey); с контрактом протокола v2 несовместим. Не удалён и не
// подогнан: пока пруфы в fixtures/ не перестроены под v2 (wrappers/protocolVersion.ts), набор
// помечает себя todo через describeWithProofFixtures и не типизируется. Перенос на v2 — вместе
// с шагом программы и пруфов (PROTOCOL-V2.md, раздел 11); прежняя версия целиком — тег protocol-v1.
import { describeWithProofFixtures } from './helpers/protocolGate';
import { proofFixturesBlocker } from '../wrappers/protocolVersion';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import { Rollup, RollupErrors, VerifierErrors } from '../wrappers/Rollup';
import { loadRollupKey } from '../wrappers/rollupDeployment';
import {
    batchDataHash,
    dataChunkCell,
    depositHash,
    forcedTransactionHash,
    merkleProofCell,
    withdrawalTree,
} from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    KEY_FINALIZE_VALUE,
    FORCE_TRANSACTION_VALUE,
    KEY_PART_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    WITHDRAW_VALUE,
    ESCAPE_TIMEOUT_SECONDS,
} from '../wrappers/rollupValues';
import {
    forcedTransactionsOf,
    loadProgramVKey,
    loadProvenBatch,
    loadZkvmScenario,
    ProvenBatch,
    withdrawalLeavesAfterBatch3Of,
    withdrawalLeavesOf,
} from '../wrappers/zkvmProofs';
import { saveGasReport } from './helpers/benchResults';
import { computePhaseOf } from './helpers/gas';
import { loadProgramKeys, sp1ProofsStatus } from '../wrappers/sp1Proofs';

// Лимит газа на транзакцию: конфиг сети, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;

const program = loadZkvmScenario();

// Сквозной путь без заглушек: программа перехода состояния (zkvm/lib) исполнена в SP1,
// её Groth16-пруф (схема v6.1.0) проверяется настоящим rollup-контрактом. Пруф привязан
// и к программе (ключ программы — константа в ключе верификации), и к батчу (дайджест
// публичных значений контракт считает сам из своего состояния), и к данным батча,
// опубликованным в TON: транзакции программа берёт из тех же порций, хеш которых
// накопил контракт (DA.md).
const SUITE = 'Rollup: пруфы SP1 нашей программы перехода состояния';
const proofs = sp1ProofsStatus();
if (proofFixturesBlocker() !== null || proofs.current) {
    // Сначала — общая проверка версии протокола: пруфы прежнего протокола дают один todo.
    describeWithProofFixtures(SUITE, suite);
} else {
    // Пруфов для нынешних программ нет (или они от прежней версии): набор ждёт их, а не
    // падает и не проходит молча. Пруфы строятся только по команде пользователя.
    describe(SUITE, () => {
        it.todo(`ждёт пруфов SP1 для нынешних программ (${proofs.reason})`);
    });
}

function suite() {
    const genesis = BigInt(program.genesisStateRoot);
    const batch1 = loadProvenBatch(1);
    const batch2 = loadProvenBatch(2);
    const batch3 = loadProvenBatch(3);
    // Ключ контракта выведен из исходников, а не взят из фикстуры пруфа (zk/gen-rollup-key.mjs).
    // Ключ программы выхода отличается от ключа программы батчей только константой IC0
    // (сам аварийный выход проверяется в tests/RollupEscapeProof.spec.ts).
    const expectedKey = loadRollupKey();
    const key = expectedKey.upload;
    const exitKeyIc0 = expectedKey.exitIc0;
    const gas: Record<string, number> = {};

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let ready: BlockchainSnapshot;

    const submit = (batch: ProvenBatch, overrides: { newStateRoot?: bigint; hintsBoc?: string } = {}) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: batch.proof,
            hints: Cell.fromBase64(overrides.hintsBoc ?? batch.hinted.hintsBoc),
            roots: { ...batch.roots, newStateRoot: overrides.newStateRoot ?? batch.roots.newStateRoot },
            value: SUBMIT_BATCH_VALUE,
        });
    /** Отказ верификатора на проверке наклона: подсказки посчитаны под другой публичный вход. */
    const rejectedBySlopeCheck = (result: { transactions: unknown }, address = rollup.address) =>
        expect(result.transactions).toHaveTransaction({
            to: address,
            success: false,
            exitCode: VerifierErrors.wrongSlope,
        });
    /** Публикует порции данных батча в том порядке, в каком их разбирала программа. */
    const publishData = async (batch: ProvenBatch, batchIndex: number, chunks = batch.dataChunks) => {
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
    const deposit = () =>
        rollup.sendDeposit(user.getSender(), {
            l2Recipient: BigInt(program.deposit.l2Recipient),
            value: BigInt(program.deposit.value),
        });
    /** Принудительные транзакции сценария: их ставит в очередь пользователь, не секвенсор. */
    const forceTransactions = async () => {
        for (const l2Transaction of forcedTransactionsOf(program)) {
            const result = await rollup.sendForceTransaction(user.getSender(), {
                l2Transaction,
                value: FORCE_TRANSACTION_VALUE,
            });
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            gas.forceTransaction = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        }
    };
    /** Второй депозит сценария: приходит после батча 1, его обязан обработать батч 3. */
    const secondDeposit = () =>
        rollup.sendDeposit(user.getSender(), {
            l2Recipient: BigInt(program.secondDeposit.l2Recipient),
            value: BigInt(program.secondDeposit.value),
        });
    /** Очередь L1 сценария до батча 1: депозит Алисы, её принудительный вывод и мусор. */
    const queueScenario = async () => {
        expect((await deposit()).transactions).toHaveTransaction({ to: rollup.address, success: true });
        await forceTransactions();
    };

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
                    chainId: BigInt(program.chainId),
                    escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
                },
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        const uploadedSlots = async () => {
            const account = (await blockchain.getContract(rollup.address)).accountState;
            if (account?.type !== 'active' || !account.state.data) throw new Error('контракт не развёрнут');
            return Rollup.uploadedKeySlots(account.state.data);
        };
        expect(await uploadedSlots()).toEqual([]);
        const parts = Bn254Groth16Verifier.keyParts(key);
        for (const { slot, part } of parts) {
            // Суммы — как в scripts/runRollupTestnet.ts: их должно хватать на газ загрузки.
            const upload = await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
            expect(upload.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        // Скрипт testnet определяет, что уже загружено, по данным контракта.
        expect((await uploadedSlots()).sort((a, b) => a - b)).toEqual(parts.map((p) => p.slot).sort((a, b) => a - b));
        // Скрипт testnet узнаёт, задан ли ключ выхода, по данным контракта.
        const exitKeySet = async () => {
            const account = (await blockchain.getContract(rollup.address)).accountState;
            if (account?.type !== 'active' || !account.state.data) throw new Error('контракт не развёрнут');
            return Rollup.isExitKeySet(account.state.data);
        };
        expect(await exitKeySet()).toBe(false);
        await rollup.sendSetExitKey(owner.getSender(), { ic0: exitKeyIc0, value: KEY_FINALIZE_VALUE });
        expect(await exitKeySet()).toBe(true);
        const finalize = await rollup.sendFinalizeKey(owner.getSender(), { key, value: KEY_FINALIZE_VALUE });
        expect(finalize.transactions).toHaveTransaction({ to: rollup.address, success: true });
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
    });

    afterAll(() => {
        saveGasReport(
            'rollup-zkvm-proof.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupZkvmProof.spec.ts; не редактировать вручную',
                note: 'Газ rollup-контракта с Groth16-пруфами SP1 (схема v6.1.0) нашей программы перехода состояния; нонс SP1 равен нулю и свёрнут в ключ; данные батча 2 опубликованы сообщением PublishData',
                gasLimit: TX_GAS_LIMIT,
                // Для каких программ сняты замеры: по этому полю отчёт о прогоне в testnet
                // (zk/testnet-rollup-report.mjs) решает, можно ли с ними сравнивать.
                sourcesSha256: loadProgramKeys().sourcesSha256,
            },
            gas,
            [
                'submitBatch',
                'submitBatchWithDeposit',
                'submitBatchThird',
                'publishData',
                'forceTransaction',
                'rejectedForgery',
            ],
        );
        console.table(gas);
    });

    it('пруфы построены для нашей программы и для этих батчей', async () => {
        // Оба пруфа проверяются одним ключом: меняется только дайджест. Ключ в контракте —
        // выведенный из исходников; ключ, под который построены подсказки пруфов, — тот же.
        expect(batch2.hinted.vkDataBoc).toBe(batch1.hinted.vkDataBoc);
        expect(await rollup.getKeyHash()).toBe(expectedKey.keyHash);
        expect(BigInt('0x' + Cell.fromBase64(batch1.hinted.vkDataBoc).hash().toString('hex'))).toBe(
            expectedKey.keyHash,
        );
        expect(await rollup.getExitKeyHash()).toBe(expectedKey.exitKeyHash);
        expect(batch3.hinted.vkDataBoc).toBe(batch1.hinted.vkDataBoc);
        for (const batch of [batch1, batch2, batch3]) {
            const [programVKey, digest, exitCode, , nonce] = batch.publicInputs;
            expect(programVKey).toBe(loadProgramVKey());
            // Дайджест в пруфе — тот, что дал нативный запуск программы.
            expect(digest).toBe(BigInt(batch.output.publicInput));
            expect(exitCode).toBe(0n);
            expect(nonce).toBe(0n);
        }
        expect(await rollup.getChainId()).toBe(BigInt(program.chainId));
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
        rejectedBySlopeCheck(await submit(batch1, { newStateRoot: batch1.roots.newStateRoot ^ 1n }));
        expect(await rollup.getRollupState()).toMatchObject({ stateRoot: genesis, batchIndex: 0 });
    });

    it('«лучшая подделка»: пруф SP1 под чужой корень состояния отклоняется замыкающим равенством', async () => {
        // Подсказки посчитаны честно для ложного утверждения (другой новый корень состояния),
        // поэтому все промежуточные проверки проходят; ложно только само утверждение.
        // Контракт обязан дойти до конца и отказать кодом WrongProof.
        const forgery = batch1.hinted.statementForgery;
        expect(forgery.alteredWord).toBe(2);
        const forgedRoot = BigInt(forgery.alteredValue);
        expect(forgedRoot).toBe(batch1.roots.newStateRoot ^ 1n);
        expect(await rollup.getExpectedPublicInput({ ...batch1.roots, newStateRoot: forgedRoot })).toBe(
            BigInt(forgery.input),
        );
        const result = await submit(batch1, { newStateRoot: forgedRoot, hintsBoc: forgery.hintsBoc });
        expect(result.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.wrongProof,
        });
        gas.rejectedForgery = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect(gas.rejectedForgery).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toMatchObject({ stateRoot: genesis, batchIndex: 0 });
    });

    it('пруф батча 2 нельзя применить вместо батча 1', async () => {
        rejectedBySlopeCheck(await submit(batch2));
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
    });

    it("пруф SP1 не подходит rollup'у с другим идентификатором", async () => {
        // Двойник: тот же код, тот же ключ, тот же генезис — другой chainId. Пруф, построенный
        // для нашего rollup'а (и транзакции, подписанные под него), у двойника не проходит.
        const twin = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode: await compile('RollupNullifier'),
                    genesisStateRoot: genesis,
                    chainId: BigInt(program.chainId) + 1n,
                    escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
                },
                await compile('Rollup'),
            ),
        );
        await twin.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key)) {
            await twin.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
        }
        await twin.sendSetExitKey(owner.getSender(), { ic0: exitKeyIc0, value: KEY_FINALIZE_VALUE });
        await twin.sendFinalizeKey(owner.getSender(), { key, value: KEY_FINALIZE_VALUE });
        expect(await twin.getKeyHash()).toBe(await rollup.getKeyHash());

        const result = await twin.sendSubmitBatch(sequencer.getSender(), {
            proof: batch1.proof,
            hints: Cell.fromBase64(batch1.hinted.hintsBoc),
            roots: batch1.roots,
            value: SUBMIT_BATCH_VALUE,
        });
        rejectedBySlopeCheck(result, twin.address);
        expect((await twin.getRollupState()).batchIndex).toBe(0);
    });

    it('батч не принимается, пока его данные не опубликованы в TON', async () => {
        await queueScenario();
        await submit(batch1);
        expect(batch2.dataChunks.length).toBeGreaterThan(0);

        // Данные не опубликованы: контракт подставляет нулевой хеш, пруф SP1 к нему не подходит.
        const withoutData = await submit(batch2);
        rejectedBySlopeCheck(withoutData);
        expect((await rollup.getRollupState()).batchIndex).toBe(1);

        // Опубликованы не те данные — тоже отказ.
        await publishData(batch2, 2, [dataChunkCell(Buffer.from('не те данные'))]);
        const wrongData = await submit(batch2);
        rejectedBySlopeCheck(wrongData);
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
    });

    it('секвенсор не может пропустить принудительную транзакцию из очереди', async () => {
        // Пруф батча 2 построен для очереди «депозит, вывод Алисы, мусор». Если бы секвенсор
        // обработал только депозит, ему понадобился бы пруф с другим хешем очереди — а хеш
        // контракт берёт из своего хранилища. И наоборот: пруф, честно обработавший всю
        // очередь, не подходит контракту, в очереди которого транзакций не было.
        await deposit();
        await submit(batch1);
        await publishData(batch2, 2);
        rejectedBySlopeCheck(await submit(batch2));
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
    });

    it('полный путь на настоящих пруфах: очередь L1 → батч 1 → второй депозит → батч 2 → батч 3 → выводы', async () => {
        // Депозит и принудительные транзакции встают в очередь L1 до первого батча; батч 2
        // обязан обработать их целиком.
        await queueScenario();
        const afterDeposit = depositHash(0n, BigInt(program.deposit.l2Recipient), BigInt(program.deposit.amount));
        const queue = await rollup.getDepositQueue();
        const queued = queue.head.hash;
        expect(queue.head.count).toBe(3n);
        expect(queued).toBe(forcedTransactionsOf(program).reduce(forcedTransactionHash, afterDeposit));
        expect(BigInt(batch2.output.newDepositHash)).toBe(queued);

        expect((await submit(batch1)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        // Второй депозит приходит после батча 1: его цель — батч 3.
        expect((await secondDeposit()).transactions).toHaveTransaction({ to: rollup.address, success: true });

        // Данные батча 2 — те самые байты, из которых программа в zkVM взяла транзакции.
        await publishData(batch2, 2);
        expect(await rollup.getBatchDataHash(2)).toBe(batchDataHash(batch2.dataChunks));
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
        expect(withdrawalTree(withdrawalLeavesOf(program)).root).toBe(batch2.roots.withdrawalsRoot);

        // Батч 3 продолжает НЕНУЛЕВЫЕ прежние корни: дерево выводов батча 2 и хеш очереди, на
        // котором тот остановился. Пруф батча 3 — единственное свидетельство на контракте, что
        // программа действительно коммитит прежние корни (в батчах 1 и 2 они оба нулевые).
        expect(BigInt(batch3.output.prevWithdrawalsRoot)).toBe(batch2.roots.withdrawalsRoot);
        expect(BigInt(batch3.output.prevWithdrawalsRoot)).not.toBe(0n);
        expect(BigInt(batch3.output.prevDepositHash)).toBe(queued);
        await publishData(batch3, 3);
        expect(await rollup.getExpectedPublicInput(batch3.roots)).toBe(BigInt(batch3.output.publicInput));
        const third = await submit(batch3);
        expect(third.transactions).toHaveTransaction({ to: rollup.address, success: true });
        gas.submitBatchThird = Number(computePhaseOf(third.transactions, rollup.address).gasUsed);
        expect(gas.submitBatchThird).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: batch3.roots.newStateRoot,
            withdrawalsRoot: batch3.roots.withdrawalsRoot,
            batchIndex: 3,
        });
        expect((await rollup.getDepositQueue()).processed.count).toBe(4n);

        // Выводы по корню, который программа посчитала внутри zkVM. Лист 0 — вывод Алисы,
        // проведённый через очередь L1 без участия секвенсора; лист 1 — вывод Боба; лист 2 —
        // вывод Алисы в батче 3.
        const leaves = withdrawalLeavesAfterBatch3Of(program);
        expect(leaves.length).toBe(3);
        const tree = withdrawalTree(leaves);
        expect(tree.root).toBe(batch3.roots.withdrawalsRoot);
        for (const { leafIndex, recipientHash, amount } of leaves) {
            const recipient = new Address(0, Buffer.from(recipientHash.toString(16).padStart(64, '0'), 'hex'));
            const withdraw = await rollup.sendWithdraw(user.getSender(), {
                leafIndex,
                recipient,
                amount,
                merkleProof: merkleProofCell(tree.proofFor(leafIndex)),
                value: WITHDRAW_VALUE,
            });
            expect(withdraw.transactions).toHaveTransaction({ from: rollup.address, to: recipient });
            expect((await blockchain.getContract(recipient)).balance).toBe(amount);
        }
    });

    it('батч 3 не принять, если очередь или дерево выводов в контракте не те, что в пруфе', async () => {
        // Без второго депозита хеш очереди, который подставляет контракт, другой: настоящий
        // пруф батча 3 к такому состоянию не подходит.
        await queueScenario();
        await submit(batch1);
        await publishData(batch2, 2);
        await submit(batch2);
        await publishData(batch3, 3);
        rejectedBySlopeCheck(await submit(batch3));
        expect((await rollup.getRollupState()).batchIndex).toBe(2);
    });
}
