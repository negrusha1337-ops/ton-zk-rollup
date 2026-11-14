import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import { Rollup, RollupErrors, VerifierErrors } from '../wrappers/Rollup';
import { batchDataHash, withdrawalTree } from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    ESCAPE_TIMEOUT_SECONDS,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
} from '../wrappers/rollupValues';
import {
    evmProofStatus,
    loadEvmProgramKeys,
    loadEvmRollupKey,
    loadProvenEvmBatch,
    publicInputOf,
} from '../wrappers/evmProofs';
import { saveGasReport } from './helpers/benchResults';
import { computePhaseOf } from './helpers/gas';

// Лимит газа на транзакцию: конфиг сети, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;

// Блок EVM, исполненный Reth внутри SP1 (zkvm-evm/), и его Groth16-пруф проверяются настоящим
// rollup-контрактом — тем же, что принимает батчи игрушечного реестра: контракту всё равно,
// что стоит за восемью словами. Это демонстрация приёма батча, а не готовый rollup на EVM:
// ключ выхода в контракте — заглушка (аварийного выхода для состояния EVM нет), депозитов и
// принудительных транзакций в батче нет, монеты L2 в блоке — из генезиса anvil, обеспечения на
// L1 у них нет, поэтому вывод здесь не проверяется (REVIEW.md, находки 6-А, 6-Б).
const SUITE = 'Rollup: пруф SP1 блока EVM';
const status = evmProofStatus();
if (status.current) {
    describe(SUITE, suite);
} else {
    // Пруфа для нынешней программы нет (или он от прежней версии): набор ждёт его, а не падает
    // и не проходит молча. Пруфы строятся только по команде пользователя.
    describe(SUITE, () => {
        it.todo(`ждёт пруфа SP1 блока EVM для нынешней программы (${status.reason})`);
    });
}

function suite() {
    const batch = loadProvenEvmBatch();
    const words = batch.report.publicValues;
    const genesis = BigInt(words.prevStateRoot);
    const expectedKey = loadEvmRollupKey();
    const gas: Record<string, number> = {};

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let ready: BlockchainSnapshot;

    const submit = (overrides: { newStateRoot?: bigint; hintsBoc?: string } = {}) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: batch.proof,
            hints: Cell.fromBase64(overrides.hintsBoc ?? batch.hinted.hintsBoc),
            roots: { ...batch.roots, newStateRoot: overrides.newStateRoot ?? batch.roots.newStateRoot },
            value: SUBMIT_BATCH_VALUE,
        });
    /** Публикует блок EVM в TON: порции данных батча в том порядке, в каком их хешировала программа. */
    const publishData = async () => {
        for (const data of batch.dataChunks) {
            const result = await rollup.sendPublishData(sequencer.getSender(), {
                batchIndex: 1,
                data,
                value: PUBLISH_DATA_VALUE,
            });
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            gas.publishData = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        }
    };

    beforeAll(async () => {
        const code = await compile('Rollup');
        const nullifierCode = await compile('RollupNullifier');
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode,
                    // «Корень состояния генезиса» для EVM — хеш заголовка блока-родителя.
                    genesisStateRoot: genesis,
                    chainId: BigInt(words.chainId),
                    escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
                },
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(expectedKey.upload)) {
            const upload = await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
            expect(upload.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        await rollup.sendSetExitKey(owner.getSender(), { ic0: expectedKey.exitIc0, value: KEY_FINALIZE_VALUE });
        const finalize = await rollup.sendFinalizeKey(owner.getSender(), {
            key: expectedKey.upload,
            value: KEY_FINALIZE_VALUE,
        });
        expect(finalize.transactions).toHaveTransaction({ to: rollup.address, success: true });
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
    });

    afterAll(() => {
        saveGasReport(
            'rollup-evm-proof.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupEvmProof.spec.ts; не редактировать вручную',
                note: 'Газ rollup-контракта с Groth16-пруфом SP1 (схема v6.1.0) блока EVM: программа zkvm-evm (Reth внутри SP1). Ключ выхода в контракте — заглушка; депозитов и принудительных транзакций в батче нет.',
                gasLimit: TX_GAS_LIMIT,
                sourcesSha256: loadEvmProgramKeys().sourcesSha256,
                blockNumber: batch.report.blockNumber,
                transactions: batch.report.transactions,
                zkvmCycles: batch.report.zkvmCycles,
            },
            gas,
            ['submitBatch', 'publishData', 'rejectedForgery'],
        );
        console.table(gas);
    });

    it('пруф построен для программы EVM, для этого блока и под ключ контракта', async () => {
        expect(await rollup.getKeyHash()).toBe(expectedKey.keyHash);
        expect(BigInt('0x' + Cell.fromBase64(batch.hinted.vkDataBoc).hash().toString('hex'))).toBe(expectedKey.keyHash);
        const [programVKey, digest, exitCode, , nonce] = batch.publicInputs;
        expect(programVKey).toBe(BigInt(loadEvmProgramKeys().programVKey));
        expect(digest).toBe(publicInputOf(batch.report.publicValuesBytes));
        expect(exitCode).toBe(0n);
        expect(nonce).toBe(0n);
        expect(await rollup.getChainId()).toBe(BigInt(words.chainId));
        // Слова состояния — хеши заголовков блоков EVM: они разные и ненулевые.
        expect(genesis).not.toBe(0n);
        expect(batch.roots.newStateRoot).not.toBe(genesis);
        // Очередь L1 у свежего контракта пуста: под это построен пруф.
        expect(BigInt(words.prevDepositHash)).toBe(0n);
        expect(BigInt(words.newDepositHash)).toBe(0n);
        expect(BigInt(words.prevWithdrawalsRoot)).toBe(0n);
    });

    it('хеш данных и корень выводов программы совпадают с тем, как их считает сторона TON', async () => {
        // Хеш данных батча программа считала в zkVM на Rust; здесь — та же раскладка ячеек на
        // TypeScript, которой пользуется секвенсор при публикации.
        expect(batchDataHash(batch.dataChunks)).toBe(BigInt(words.batchHash));
        // Выводы блока по сценарию: 0,25 и 0,1 монеты на получателей с первыми байтами 0x11 и
        // 0x22 (zkvm-evm/scenario/anvil-scenario.sh, функция recipient).
        const recipient = (first: number) =>
            BigInt('0x' + [first, ...Array.from({ length: 31 }, (_, i) => parseInt(String(i + 1).padStart(2, '0'), 16))]
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join(''));
        const leaves = [
            { leafIndex: 0, recipientHash: recipient(0x11), amount: 250_000_000n },
            { leafIndex: 1, recipientHash: recipient(0x22), amount: 100_000_000n },
        ];
        expect(withdrawalTree(leaves).root).toBe(batch.roots.withdrawalsRoot);
    });

    it('без опубликованных данных батч не принимается', async () => {
        // Хеш данных батча контракт берёт из того, что опубликовано: без публикации он нулевой,
        // публичный вход другой, и подсказки пруфа к нему не подходят (отказ на проверке наклона).
        const result = await submit();
        expect(result.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: VerifierErrors.wrongSlope,
        });
        expect(await rollup.getRollupState()).toMatchObject({ stateRoot: genesis, batchIndex: 0 });
    });

    it('блок EVM с пруфом SP1 принимается контрактом и укладывается в лимит газа', async () => {
        await publishData();
        expect(await rollup.getBatchDataHash(1)).toBe(BigInt(words.batchHash));
        expect(await rollup.getExpectedPublicInput(batch.roots)).toBe(batch.publicInputs[1]);
        const result = await submit();
        expect(result.transactions).toHaveTransaction({ from: sequencer.address, to: rollup.address, success: true });
        gas.submitBatch = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        gas.submitBatchHeadroom = TX_GAS_LIMIT - gas.submitBatch;
        expect(gas.submitBatch).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: batch.roots.newStateRoot,
            withdrawalsRoot: batch.roots.withdrawalsRoot,
            batchIndex: 1,
        });
    });

    it('«лучшая подделка»: пруф под чужой хеш блока отклоняется замыкающим равенством', async () => {
        // Подсказки посчитаны честно для ложного утверждения (другой хеш нового блока), поэтому
        // все промежуточные проверки проходят; ложно только само утверждение.
        await publishData();
        const forgery = batch.hinted.statementForgery;
        expect(forgery.alteredWord).toBe(2);
        const forgedRoot = BigInt(forgery.alteredValue);
        expect(forgedRoot).toBe(batch.roots.newStateRoot ^ 1n);
        expect(await rollup.getExpectedPublicInput({ ...batch.roots, newStateRoot: forgedRoot })).toBe(
            BigInt(forgery.input),
        );
        const result = await submit({ newStateRoot: forgedRoot, hintsBoc: forgery.hintsBoc });
        expect(result.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.wrongProof,
        });
        gas.rejectedForgery = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect(gas.rejectedForgery).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toMatchObject({ stateRoot: genesis, batchIndex: 0 });
    });
}
