import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell } from '@ton/core';
import { compile } from '@ton/blueprint';
import { readFileSync } from 'fs';
import path from 'path';
import '@ton/test-utils';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import {
    loadEvmProgramKeys,
    loadEvmRollupKey,
    loadProvenRethBatch,
    loadProvenRethBatchFrom,
    loadRethBatchReport,
    ProvenEvmBatch,
    publicInputOf,
    rethProofStatus,
} from '../wrappers/evmProofs';
import { Rollup, RollupErrors } from '../wrappers/Rollup';
import { DEPLOY_VALUE, KEY_FINALIZE_VALUE, KEY_PART_VALUE, PUBLISH_DATA_VALUE, SUBMIT_BATCH_VALUE, TESTNET_ESCAPE_TIMEOUT_SECONDS } from '../wrappers/rollupValues';
import { computePhaseOf } from './helpers/gas';
import { blockOf, prepareRethBatch, RethActors, rethExpected } from './helpers/rethChain';
import { readProtocolConstants, testConfig } from './helpers/rollupSetup';

// Пруф блока цепочки Reth, построенный НЕ на этом маке (арендованный сервер с GPU,
// zkvm-evm/host/remote/README.md), на настоящем контракте в Sandbox:
//
//   REMOTE_PROOF_FIXTURE=sp1_evm_reth3_gpu npx blueprint test tests/RollupEvmRemoteProof.spec.ts
//
// Каталог фикстуры — sp1_evm_reth<N>_<метка>: его пишут zk/import-sp1-fixture.mjs (импортёр уже
// сверил ключ программы, ELF, публичные значения с block-<N>.json и проверил пруф спариванием) и
// zk/gen-bn254-groth16-fixture.mjs. Батчи 1…N−1 идут по основным пруфам (fixtures/sp1_evm_reth<k>),
// батч N — по присланному. Замер газа в bench/ не пишется: он принадлежит основному набору.
// Без переменной набор — один todo.
const TX_GAS_LIMIT = 1_000_000;
const DIRECTORY = process.env.REMOTE_PROOF_FIXTURE ?? '';
const SUITE = 'Rollup: пруф блока Reth, построенный на другой машине';

if (!DIRECTORY) {
    describe(SUITE, () => {
        it.todo('задайте REMOTE_PROOF_FIXTURE=sp1_evm_reth<N>_<метка> (zkvm-evm/host/remote/README.md)');
    });
} else {
    describe(SUITE, suite);
}

function suite() {
    const match = /^sp1_evm_reth([0-9]+)_[a-z0-9]+$/.exec(DIRECTORY);
    if (!match) throw new Error(`REMOTE_PROOF_FIXTURE=${DIRECTORY}: ожидается sp1_evm_reth<N>_<метка>`);
    const number = Number(match[1]);
    const status = rethProofStatus();
    const key = loadEvmRollupKey();
    const program = loadEvmProgramKeys();
    const remote: ProvenEvmBatch = loadProvenRethBatchFrom(DIRECTORY, number);
    const earlier: ProvenEvmBatch[] = Array.from({ length: number - 1 }, (_, index) => loadProvenRethBatch(index + 1));
    const source = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', DIRECTORY, 'source.json'), 'utf8'));
    const onchain = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', DIRECTORY, 'onchain.json'), 'utf8'));
    const keyFile = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'evm_batches', 'key.json'), 'utf8'));

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let actors: RethActors;
    let ready: BlockchainSnapshot;

    const submit = (batch: ProvenEvmBatch, overrides: { newStateRoot?: bigint; hintsBoc?: string } = {}) =>
        rollup.sendSubmitBatch(owner.getSender(), {
            proof: batch.proof,
            hints: Cell.fromBase64(overrides.hintsBoc ?? batch.hinted.hintsBoc),
            roots: { ...batch.roots, newStateRoot: overrides.newStateRoot ?? batch.roots.newStateRoot },
            value: SUBMIT_BATCH_VALUE,
        });
    /** Батчи 1…N−1 по основным пруфам и подготовка батча N (очередь, данные, публичный вход). */
    const upToRemote = async () => {
        for (const [index, batch] of earlier.entries()) {
            const prepared = await prepareRethBatch(actors, index + 1, PUBLISH_DATA_VALUE);
            expect(prepared.required).toBe(batch.publicInputs[1]);
            const result = await submit(batch);
            expect(result.transactions).toHaveTransaction({ from: owner.address, to: rollup.address, success: true });
        }
        const prepared = await prepareRethBatch(actors, number, PUBLISH_DATA_VALUE);
        expect(prepared.roots).toEqual(remote.roots);
        expect(prepared.required).toBe(remote.publicInputs[1]);
    };

    beforeAll(async () => {
        // Основные пруфы нужны для батчей до N: без них набор проверял бы не то.
        if (!status.current) throw new Error(`основные пруфы блоков Reth негодны: ${status.reason}`);
        const code = await compile('Rollup');
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
                    escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS,
                }),
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key.upload)) {
            await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
        }
        await rollup.sendFinalizeKey(owner.getSender(), { key: key.upload, value: KEY_FINALIZE_VALUE });
        expect(await rollup.getKeyHash()).toBe(key.keyHash);
        actors = { blockchain, rollup, sequencer: owner, user };
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
        blockchain.now = blockOf(1).timestamp;
    });

    it('фикстура — пруф этого блока, этой программы и этого ключа контракта', () => {
        expect(remote.publicInputs[0]).toBe(BigInt(program.programVKey));
        expect(remote.publicInputs[1]).toBe(publicInputOf(loadRethBatchReport(number).publicValuesBytes));
        expect(remote.publicInputs[2]).toBe(0n);
        expect(remote.publicInputs[3]).toBe(BigInt(keyFile.vkRoot));
        expect(remote.publicInputs[4]).toBe(0n);
        expect(source.elfSha256).toBe(program.programElfSha256);
        expect(String(source.publicValues).replace(/^0x/, '')).toBe(loadRethBatchReport(number).publicValuesBytes.replace(/^0x/, ''));
        expect('0x' + Cell.fromBase64(onchain.hinted.vkDataBoc).hash().toString('hex')).toBe(keyFile.keyHash);
    });

    it(`настоящий контракт принимает батч ${number} по присланному пруфу`, async () => {
        await upToRemote();
        const result = await submit(remote);
        expect(result.transactions).toHaveTransaction({ from: owner.address, to: rollup.address, success: true });
        const gas = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect(gas).toBeLessThan(TX_GAS_LIMIT);
        console.log(`Газ батча ${number} по пруфу из ${DIRECTORY}: ${gas}`);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: remote.roots.newStateRoot,
            withdrawalsRoot: remote.roots.withdrawalsRoot,
            batchIndex: number,
            withdrawalsCount: remote.roots.withdrawalsCount,
        });
    });

    it('«лучшая подделка» на присланном пруфе отклоняется замыкающим равенством', async () => {
        await upToRemote();
        const forgery = remote.hinted.statementForgery;
        if (!forgery) throw new Error('в фикстуре нет «лучшей подделки» (statementForgery)');
        expect(forgery.alteredWord).toBe(2);
        const forgedRoot = BigInt(forgery.alteredValue);
        expect(await rollup.getExpectedPublicInput({ ...remote.roots, newStateRoot: forgedRoot })).toBe(BigInt(forgery.input));
        const result = await submit(remote, { newStateRoot: forgedRoot, hintsBoc: forgery.hintsBoc });
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: RollupErrors.wrongProof });
        expect((await rollup.getRollupState()).batchIndex).toBe(number - 1);
    });
}
