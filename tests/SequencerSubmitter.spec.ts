import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, Transaction, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import { batchRootsOf, EvmBatchReport, loadEvmRollupKey, loadProvenRethBatch, publicInputOf } from '../wrappers/evmProofs';
import { Rollup, RollupErrors, RollupOpcodes } from '../wrappers/Rollup';
import { dataChunkCell } from '../wrappers/rollupMath';
import { DEPLOY_VALUE, KEY_FINALIZE_VALUE, KEY_PART_VALUE, PUBLISH_DATA_VALUE, SUBMIT_BATCH_VALUE } from '../wrappers/rollupValues';
import { BatchProof, MOCK_PROOF } from '../sequencer/prover';
import { Batch, SandboxSubmitter } from '../sequencer/submitter';
import { BATCH_DELAY_SECONDS, blockOf, enqueueUpTo, RethActors, reportOf, rethExpected } from './helpers/rethChain';
import { finalizeDummyKeys, readProtocolConstants, testConfig } from './helpers/rollupSetup';

// Отправщик батчей (sequencer/submitter.ts) без узла: батчи — блоки цепочки Reth из фикстур,
// очередь L1 ставится сообщениями (enqueueUpTo). На двойнике — отказы и идемпотентность; на
// НАСТОЯЩЕМ контракте с пруфом SP1 блока 1 — что сверка публичного входа до SubmitBatch
// отсекает ровно то, что контракт отверг бы кодом 7300.

/** Опкоды входящих в контракт сообщений из результатов отправок. */
const opsTo = (results: { transactions: Transaction[] }[], rollup: { address: { equals(other: unknown): boolean } }) =>
    results.flatMap((result) =>
        result.transactions.flatMap((transaction) => {
            const message = transaction.inMessage;
            if (!message || message.info.type !== 'internal' || !rollup.address.equals(message.info.dest)) return [];
            const body = message.body.beginParse();
            return body.remainingBits >= 32 ? [body.loadUint(32)] : [];
        }),
    );
/** Подменить одно слово (номер с нуля) в 352 байтах публичных значений. */
const withWord = (report: EvmBatchReport, index: number, value: bigint): EvmBatchReport => {
    const bytes = Buffer.from(report.publicValuesBytes.replace(/^0x/, ''), 'hex');
    Buffer.from(value.toString(16).padStart(64, '0'), 'hex').copy(bytes, index * 32);
    return { ...report, publicValuesBytes: '0x' + bytes.toString('hex') };
};

describe('отправщик батчей на двойнике: отказы, идемпотентность, сверка публичного входа', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let actors: RethActors;
    let ready: BlockchainSnapshot;
    let sent: { transactions: Transaction[] }[];
    const mock: BatchProof = { kind: 'mock', proof: MOCK_PROOF, hintsBoc: null, jobKey: 'не проверяется отправщиком' };
    const batch = (number: number, report = reportOf(number), blockHash = blockOf(number).hash): Batch => ({
        number,
        blockHash,
        report,
        proof: mock,
    });
    const submitter = () => new SandboxSubmitter(rollup, owner.getSender(), (result) => sent.push(result));

    beforeAll(async () => {
        const code = await compile('RollupMock');
        const nullifierCode = await compile('RollupNullifier');
        const constants = await readProtocolConstants(code, nullifierCode);
        blockchain = await Blockchain.create();
        blockchain.now = blockOf(1).timestamp;
        owner = await blockchain.treasury('owner');
        const user = await blockchain.treasury('user');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                testConfig(constants, {
                    owner: owner.address,
                    sequencer: owner.address,
                    nullifierCode,
                    chainId: BigInt(rethExpected.chainId),
                    escapeTimeout: 3600 * 12,
                }),
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('0.05'));
        await finalizeDummyKeys(rollup, owner);
        actors = { blockchain, rollup, sequencer: owner, user };
        blockchain.now = blockOf(1).timestamp + BATCH_DELAY_SECONDS;
        await enqueueUpTo(actors, blockOf(1).headAtBatch);
        ready = blockchain.snapshot();
    });
    beforeEach(async () => {
        await blockchain.loadFrom(ready);
        sent = [];
    });

    it('честный батч принят; повторная отправка — «уже принят», ничего не шлёт', async () => {
        expect(await submitter().submit(batch(1))).toEqual({ accepted: true, alreadyAccepted: false });
        expect(opsTo(sent, rollup).filter((op) => op === RollupOpcodes.submitBatch)).toHaveLength(1);
        sent = [];
        expect(await submitter().submit(batch(1))).toEqual({ accepted: true, alreadyAccepted: true });
        expect(sent).toEqual([]);
    });

    it('контракт принял на этом номере другой блок — отказ с его хешем', async () => {
        await submitter().submit(batch(1));
        const other = '0x' + 'ee'.repeat(32);
        expect(await submitter().submit(batch(1, reportOf(1), other))).toEqual({
            accepted: false,
            reason: `контракт принял батч 1 с другим блоком ${blockOf(1).hash}`,
        });
    });

    it('контракт ждёт другой батч — отказ, ничего не отправлено', async () => {
        expect(await submitter().submit(batch(2))).toEqual({ accepted: false, reason: 'контракт ждёт батч 1, а не 2' });
        expect(sent).toEqual([]);
    });

    it('чужие частично опубликованные данные сбрасываются, данные батча публикуются заново', async () => {
        const stray = await rollup.sendPublishData(owner.getSender(), {
            batchIndex: 1,
            data: dataChunkCell(Buffer.from('stray data')),
            value: PUBLISH_DATA_VALUE,
        });
        expect(stray.transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await rollup.getBatchDataHash(1)).not.toBe(0n);
        expect(await submitter().submit(batch(1))).toEqual({ accepted: true, alreadyAccepted: false });
        const ops = opsTo(sent, rollup);
        expect(ops[0]).toBe(RollupOpcodes.discardBatchData);
        expect(ops.filter((op) => op === RollupOpcodes.publishData)).toHaveLength(reportOf(1).dataChunksHex.length);
        expect(ops[ops.length - 1]).toBe(RollupOpcodes.submitBatch);
    });

    it('подменённое слово в публичных значениях — отказ с точной причиной, SubmitBatch не отправлен', async () => {
        const honest = reportOf(1);
        const tampered = withWord(honest, 5, 0x1234n);
        const outcome = await submitter().submit(batch(1, tampered));
        // Публичный вход контракт собирает и из опубликованных данных: они уже опубликованы.
        const required = await rollup.getExpectedPublicInput(batchRootsOf(honest));
        expect(outcome).toEqual({
            accepted: false,
            reason: `контракт ждёт публичный вход 0x${required.toString(16)}, а программа доказывает 0x${publicInputOf(tampered.publicValuesBytes).toString(16)}`,
        });
        expect(opsTo(sent, rollup)).not.toContain(RollupOpcodes.submitBatch);
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
    });
});

describe('отправщик батчей на НАСТОЯЩЕМ контракте: пруф SP1 блока 1 цепочки Reth', () => {
    const proven = loadProvenRethBatch(1);
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let ready: BlockchainSnapshot;
    const groth16: BatchProof = { kind: 'groth16', proof: proven.proof, hintsBoc: proven.hinted.hintsBoc, jobKey: 'не проверяется отправщиком' };

    beforeAll(async () => {
        const code = await compile('Rollup');
        const nullifierCode = await compile('RollupNullifier');
        const constants = await readProtocolConstants(code, nullifierCode);
        const key = loadEvmRollupKey();
        blockchain = await Blockchain.create();
        blockchain.now = blockOf(1).timestamp;
        owner = await blockchain.treasury('owner');
        const user = await blockchain.treasury('user');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                testConfig(constants, {
                    owner: owner.address,
                    sequencer: owner.address,
                    nullifierCode,
                    chainId: BigInt(rethExpected.chainId),
                    escapeTimeout: 3600 * 12,
                }),
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key.upload))
            await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
        await rollup.sendFinalizeKey(owner.getSender(), { key: key.upload, value: KEY_FINALIZE_VALUE });
        expect(await rollup.getKeyHash()).toBe(key.keyHash);
        blockchain.now = blockOf(1).timestamp + BATCH_DELAY_SECONDS;
        await enqueueUpTo({ blockchain, rollup, sequencer: owner, user }, blockOf(1).headAtBatch);
        ready = blockchain.snapshot();
    }, 300_000);
    beforeEach(async () => {
        await blockchain.loadFrom(ready);
    });

    it('честный батч с пруфом принят контрактом', async () => {
        const submitter = new SandboxSubmitter(rollup, owner.getSender());
        expect(proven.report.publicValuesBytes).toBe(reportOf(1).publicValuesBytes);
        expect(await submitter.submit({ number: 1, blockHash: blockOf(1).hash, report: proven.report, proof: groth16 })).toEqual({
            accepted: true,
            alreadyAccepted: false,
        });
        expect((await rollup.getRollupState()).stateRoot).toBe(BigInt(blockOf(1).hash));
    });

    it('подменённое слово состояния: сверка отсекает до SubmitBatch; без сверки тот же батч — отказ 7300', async () => {
        // «Лучшая подделка» фикстуры: честные подсказки для ложного утверждения (слово 2 — newStateRoot).
        const forgery = proven.hinted.statementForgery;
        if (!forgery) throw new Error('в фикстуре пруфа нет «лучшей подделки» (statementForgery)');
        expect(forgery.alteredWord).toBe(2);
        const tampered: EvmBatchReport = {
            ...proven.report,
            publicValues: { ...proven.report.publicValues, newStateRoot: forgery.alteredValue },
        };
        const sent: { transactions: Transaction[] }[] = [];
        const submitter = new SandboxSubmitter(rollup, owner.getSender(), (result) => sent.push(result));
        const outcome = await submitter.submit({
            number: 1,
            blockHash: forgery.alteredValue,
            report: tampered,
            proof: { ...groth16, hintsBoc: forgery.hintsBoc },
        });
        expect(outcome).toEqual({
            accepted: false,
            reason: `контракт ждёт публичный вход 0x${BigInt(forgery.input).toString(16)}, а программа доказывает 0x${publicInputOf(proven.report.publicValuesBytes).toString(16)}`,
        });
        expect(opsTo(sent, rollup)).not.toContain(RollupOpcodes.submitBatch);
        // То, что отправщик не отправил, контракт отверг бы замыкающим равенством пруфа.
        const direct = await rollup.sendSubmitBatch(owner.getSender(), {
            proof: proven.proof,
            hints: Cell.fromBase64(forgery.hintsBoc),
            roots: batchRootsOf(tampered),
            value: SUBMIT_BATCH_VALUE,
        });
        expect(direct.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: RollupErrors.wrongProof });
        expect(RollupErrors.wrongProof).toBe(7300);
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
    });
});
