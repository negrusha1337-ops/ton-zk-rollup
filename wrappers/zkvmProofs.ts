import { readFileSync } from 'fs';
import path from 'path';
import { Cell } from '@ton/core';
import { Bn254Proof, KeyUploadJson } from './Bn254Groth16Verifier';
import { Address } from '@ton/core';
import { BatchRoots, ExitClaim } from './Rollup';
import { dataChunkCell } from './rollupMath';

// Загрузка пруфов SP1 программы перехода состояния (zkvm/) из фикстур. Используется и
// тестами, и скриптом прогона в testnet: оба обязаны отправлять в контракт одно и то же.

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const read = (...parts: string[]) => JSON.parse(readFileSync(path.join(FIXTURES, ...parts), 'utf8'));

/** Публичные значения одного батча, как их выдал нативный запуск программы. */
export type BatchOutput = {
    /** Порции данных батча в порядке публикации (hex). */
    dataChunksHex: string[];
    /** 224 байта публичных значений программы (hex). */
    publicValuesHex: string;
    publicInput: string;
    prevStateRoot: string;
    roots: { newStateRoot: string; batchHash: string; withdrawalsRoot: string };
    prevDepositHash: string;
    newDepositHash: string;
};

export type ZkvmScenario = {
    /** Идентификатор rollup'а, под который построены пруфы и подписаны транзакции. */
    chainId: string;
    genesisStateRoot: string;
    deposit: { l2Recipient: string; value: string; amount: string };
    withdrawal: { leafIndex: number; recipientHash: string; amount: string };
    batches: BatchOutput[];
    chunkHashVectors: { vectors: { length: number; hash: string }[] };
};

/** Порции данных батча как ячейки, которые секвенсор публикует сообщениями PublishData. */
export const dataChunksOf = (output: BatchOutput): Cell[] =>
    output.dataChunksHex.map((hex) => dataChunkCell(Buffer.from(hex, 'hex')));

export type HintedFixture = { vkDataBoc: string; keyUpload: KeyUploadJson; hintsBoc: string; inputs: string[] };

export type ProvenBatch = {
    proof: Bn254Proof;
    hinted: HintedFixture;
    /** Пять публичных входов верификатора SP1: ключ программы, дайджест, код выхода, корень ключей, nonce. */
    publicInputs: bigint[];
    output: BatchOutput;
    roots: BatchRoots;
    /** Порции данных, которые нужно опубликовать до отправки батча. */
    dataChunks: Cell[];
};

/** Сценарий «депозит → два батча → вывод» (fixtures/zkvm_batches/batches.json). */
export const loadZkvmScenario = (): ZkvmScenario => read('zkvm_batches', 'batches.json');

/** Хеш ключа программы, под который построены пруфы (fixtures/zkvm_batches/program.json). */
export const loadProgramVKey = (): bigint => BigInt(read('zkvm_batches', 'program.json').programVKey);

/**
 * Пруф SP1 батча с номером `index` (с единицы): то, что построил zkvm/script и
 * импортировал zk/import-sp1-fixture.mjs, вместе с ключом и подсказками для контракта.
 */
export function loadProvenBatch(index: number): ProvenBatch {
    const directory = `sp1_rollup_batch${index}`;
    const output = loadZkvmScenario().batches[index - 1];
    if (!output) throw new Error(`В сценарии нет батча ${index}`);
    return {
        proof: proofFromFixture(directory),
        hinted: (read(directory, 'onchain.json') as { hinted: HintedFixture }).hinted,
        publicInputs: (read(directory, 'public.json') as string[]).map(BigInt),
        output,
        roots: {
            newStateRoot: BigInt(output.roots.newStateRoot),
            withdrawalsRoot: BigInt(output.roots.withdrawalsRoot),
        },
        dataChunks: dataChunksOf(output),
    };
}

// --- аварийный выход ---

/** Заявка на выход, как её выдал нативный запуск программы выхода. */
export type ExitClaimOutput = {
    name: string;
    l2Account: string;
    amount: string;
    recipientHash: string;
    /** 160 байт публичных значений программы выхода (hex). */
    publicValuesHex: string;
    publicInput: string;
};

export type ExitScenario = { chainId: string; stateRoot: string; claims: ExitClaimOutput[] };

export type ProvenExit = {
    proof: Bn254Proof;
    hinted: HintedFixture;
    publicInputs: bigint[];
    output: ExitClaimOutput;
    /** Заявка в том виде, в каком она уходит в контракт. */
    claim: ExitClaim;
};

/** Заявки на аварийный выход из состояния после батча 2 (fixtures/zkvm_exit/claims.json). */
export const loadExitScenario = (): ExitScenario => read('zkvm_exit', 'claims.json');

const proofFromFixture = (directory: string): Bn254Proof => {
    const raw = read(directory, 'proof.json');
    return {
        a: [BigInt(raw.pi_a[0]), BigInt(raw.pi_a[1])],
        b: [
            [BigInt(raw.pi_b[0][0]), BigInt(raw.pi_b[0][1])],
            [BigInt(raw.pi_b[1][0]), BigInt(raw.pi_b[1][1])],
        ],
        c: [BigInt(raw.pi_c[0]), BigInt(raw.pi_c[1])],
    };
};

/** Пруф SP1 аварийного выхода счёта сценария (alice или bob) с ключом и подсказками. */
export function loadProvenExit(name: string): ProvenExit {
    const directory = `sp1_rollup_exit_${name}`;
    const output = loadExitScenario().claims.find((claim) => claim.name === name);
    if (!output) throw new Error(`В сценарии нет заявки на выход ${name}`);
    const recipientHash = BigInt(output.recipientHash).toString(16).padStart(64, '0');
    return {
        proof: proofFromFixture(directory),
        hinted: (read(directory, 'onchain.json') as { hinted: HintedFixture }).hinted,
        publicInputs: (read(directory, 'public.json') as string[]).map(BigInt),
        output,
        claim: {
            l2Account: BigInt(output.l2Account),
            amount: BigInt(output.amount),
            recipient: new Address(0, Buffer.from(recipientHash, 'hex')),
        },
    };
}
