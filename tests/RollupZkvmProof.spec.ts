import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier, keyUploadFromJson } from '../wrappers/Bn254Groth16Verifier';
import { Rollup } from '../wrappers/Rollup';
import { batchDataHash, dataChunkCell, depositHash, merkleProofCell, withdrawalTree } from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    WITHDRAW_VALUE,
    ESCAPE_TIMEOUT_SECONDS,
} from '../wrappers/rollupValues';
import {
    loadProgramVKey,
    loadProvenBatch,
    loadProvenExit,
    loadZkvmScenario,
    ProvenBatch,
} from '../wrappers/zkvmProofs';
import { computePhaseOf } from './helpers/gas';

// Лимит газа на транзакцию: конфиг сети, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;

const program = loadZkvmScenario();

// Сквозной путь без заглушек: программа перехода состояния (zkvm/lib) исполнена в SP1,
// её Groth16-пруф (схема v6.1.0) проверяется настоящим rollup-контрактом. Пруф привязан
// и к программе (ключ программы — константа в ключе верификации), и к батчу (дайджест
// публичных значений контракт считает сам из своего состояния), и к данным батча,
// опубликованным в TON: транзакции программа берёт из тех же порций, хеш которых
// накопил контракт (DA.md).
describe('Rollup: пруфы SP1 нашей программы перехода состояния', () => {
    const genesis = BigInt(program.genesisStateRoot);
    const batch1 = loadProvenBatch(1);
    const batch2 = loadProvenBatch(2);
    const key = keyUploadFromJson(batch1.hinted.keyUpload);
    // Ключ программы выхода отличается от ключа программы батчей только константой IC0
    // (сам аварийный выход проверяется в tests/RollupEscapeProof.spec.ts).
    const exitKeyIc0 = keyUploadFromJson(loadProvenExit('alice').hinted.keyUpload).ic0;
    const gas: Record<string, number> = {};

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let ready: BlockchainSnapshot;

    const submit = (batch: ProvenBatch, overrides: { nonce?: bigint; newStateRoot?: bigint } = {}) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: batch.proof,
            hints: Cell.fromBase64(batch.hinted.hintsBoc),
            roots: { ...batch.roots, newStateRoot: overrides.newStateRoot ?? batch.roots.newStateRoot },
            nonce: overrides.nonce,
            value: SUBMIT_BATCH_VALUE,
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
        await rollup.sendSetExitKey(owner.getSender(), { ic0: exitKeyIc0, value: KEY_FINALIZE_VALUE });
        const finalize = await rollup.sendFinalizeKey(owner.getSender(), { key, value: KEY_FINALIZE_VALUE });
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
                    note: 'Газ rollup-контракта с Groth16-пруфами SP1 (схема v6.1.0) нашей программы перехода состояния; nonce = 0; данные батча 2 опубликованы сообщением PublishData',
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
        expect(result.transactions).toHaveTransaction({ to: twin.address, success: false });
        expect((await twin.getRollupState()).batchIndex).toBe(0);
    });

    it('батч не принимается, пока его данные не опубликованы в TON', async () => {
        await deposit();
        await submit(batch1);
        expect(batch2.dataChunks.length).toBeGreaterThan(0);

        // Данные не опубликованы: контракт подставляет нулевой хеш, пруф SP1 к нему не подходит.
        const withoutData = await submit(batch2);
        expect(withoutData.transactions).toHaveTransaction({ to: rollup.address, success: false });
        expect((await rollup.getRollupState()).batchIndex).toBe(1);

        // Опубликованы не те данные — тоже отказ.
        await publishData(batch2, 2, [dataChunkCell(Buffer.from('не те данные'))]);
        const wrongData = await submit(batch2);
        expect(wrongData.transactions).toHaveTransaction({ to: rollup.address, success: false });
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
    });

    it('полный путь на настоящих пруфах: депозит → батч 1 → данные → батч 2 → вывод', async () => {
        // Депозит приходит до первого батча; батч 2 обязан его обработать.
        expect((await deposit()).transactions).toHaveTransaction({ to: rollup.address, success: true });
        const queued = (await rollup.getDepositQueue()).head.hash;
        expect(queued).toBe(depositHash(0n, BigInt(program.deposit.l2Recipient), BigInt(program.deposit.amount)));
        expect(BigInt(batch2.output.newDepositHash)).toBe(queued);

        expect((await submit(batch1)).transactions).toHaveTransaction({ to: rollup.address, success: true });

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
            value: WITHDRAW_VALUE,
        });
        expect(withdraw.transactions).toHaveTransaction({ from: rollup.address, to: recipient });
        expect((await blockchain.getContract(recipient)).balance).toBe(amount);
    });
});
