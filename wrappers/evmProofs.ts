import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { Cell } from '@ton/core';
import { Bn254Proof, KeyUpload, keyUploadFromJson } from './Bn254Groth16Verifier';
import { BatchRoots } from './Rollup';
import { RollupKeyFile } from './rollupDeployment';
import { dataChunkCell } from './rollupMath';
import { HintedFixture } from './zkvmProofs';

// Пруф SP1 программы батча EVM (zkvm-evm/) и его привязка к исходникам — то же, что
// wrappers/sp1Proofs.ts и wrappers/zkvmProofs.ts для программ zkvm/, с отдельными файлами:
//   исходники → sourcesSha256 → fixtures/evm_batches/program.json → fixtures/evm_batches/key.json
//   → fixtures/sp1_evm_batch<N> (импорт пруфа: zk/import-sp1-fixture.mjs).
// Батч, под который строится пруф, — fixtures/evm_batches/contract/block-<N>.json: блок EVM с
// нулевым хешем очереди L1, как у только что развёрнутого контракта без депозитов.

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const read = (...parts: string[]) => JSON.parse(readFileSync(path.join(FIXTURES, ...parts), 'utf8'));

/** Номер блока EVM, который служит первым батчем контракта. */
export const EVM_BATCH_BLOCK = 2;
const PROOF_DIRECTORY = `sp1_evm_batch${EVM_BATCH_BLOCK}`;

export type EvmProgramKeys = { sourcesSha256: string; programVKey: string; programElfSha256: string };

/** Отчёт хоста о батче: восемь слов и данные, которые публикуются в TON. */
export type EvmBatchReport = {
    blockNumber: number;
    transactions: number;
    dataChunksHex: string[];
    publicValues: {
        chainId: string;
        prevStateRoot: string;
        newStateRoot: string;
        batchHash: string;
        prevWithdrawalsRoot: string;
        withdrawalsRoot: string;
        prevDepositHash: string;
        newDepositHash: string;
    };
    publicValuesBytes: string;
    zkvmCycles: number | null;
};

export const loadEvmProgramKeys = (): EvmProgramKeys => read('evm_batches', 'program.json');
export const loadEvmBatchReport = (): EvmBatchReport => read('evm_batches', 'contract', `block-${EVM_BATCH_BLOCK}.json`);

/** Ключ контракта для программы EVM (zk/gen-evm-rollup-key.mjs). Ключ выхода в нём — заглушка. */
export function loadEvmRollupKey(): { keyHash: bigint; exitKeyHash: bigint; exitIc0: [bigint, bigint]; upload: KeyUpload; file: RollupKeyFile & { vkRoot: string } } {
    const file = read('evm_batches', 'key.json');
    return {
        keyHash: BigInt(file.keyHash),
        exitKeyHash: BigInt(file.exitKeyHash),
        exitIc0: [BigInt(file.exitIc0[0]), BigInt(file.exitIc0[1])],
        upload: keyUploadFromJson(file.keyUpload),
        file,
    };
}

/** Хеш исходников программы EVM по дереву на диске (zk/evm-binding.mjs). */
export const currentEvmSourcesSha256 = (): string =>
    execFileSync('node', [path.join(ROOT, 'zk', 'evm-binding.mjs')], { encoding: 'utf8' }).trim();

/** Публичный вход схемы для 256 байт публичных значений: sha256, обрезанный до 253 бит. */
export const publicInputOf = (publicValuesHex: string): bigint =>
    BigInt('0x' + createHash('sha256').update(Buffer.from(publicValuesHex.replace(/^0x/, ''), 'hex')).digest('hex')) &
    ((1n << 253n) - 1n);

/** Годен ли пруф SP1 блока EVM для сквозного теста и почему нет. */
export function evmProofStatus(): { current: boolean; reason: string } {
    const file = (name: string) => path.join(FIXTURES, PROOF_DIRECTORY, name);
    for (const required of [['evm_batches', 'program.json'], ['evm_batches', 'key.json'], ['evm_batches', 'contract', `block-${EVM_BATCH_BLOCK}.json`]]) {
        if (!existsSync(path.join(FIXTURES, ...required))) return { current: false, reason: `нет fixtures/${required.join('/')}` };
    }
    const program = loadEvmProgramKeys();
    if (program.sourcesSha256 !== currentEvmSourcesSha256()) {
        return { current: false, reason: 'fixtures/evm_batches/program.json описывает прежние исходники программы' };
    }
    if (!['proof.json', 'public.json', 'source.json', 'onchain.json'].every((name) => existsSync(file(name)))) {
        return { current: false, reason: `${PROOF_DIRECTORY}: пруфа нет` };
    }
    const problems: string[] = [];
    const key = read('evm_batches', 'key.json');
    const inputs = (read(PROOF_DIRECTORY, 'public.json') as string[]).map(BigInt);
    const source = read(PROOF_DIRECTORY, 'source.json');
    const onchain = read(PROOF_DIRECTORY, 'onchain.json');
    if (key.programVKey !== program.programVKey) problems.push('ключ контракта выведен для другой программы');
    if (inputs[0] !== BigInt(program.programVKey)) problems.push('ключ программы не тот, что в program.json');
    if (inputs[2] !== 0n) problems.push('exitCode не ноль');
    if (inputs[3] !== BigInt(key.vkRoot)) problems.push('vkRoot не тот, что у закреплённого верификатора');
    if (inputs[4] !== 0n) problems.push('нонс не ноль');
    if (source.kind !== 'batch' || source.program !== 'evm') problems.push('это не пруф программы батча EVM');
    if (source.elfSha256 !== program.programElfSha256) problems.push('построен для другого ELF, чем записан в program.json');
    if (inputs[1] !== publicInputOf(loadEvmBatchReport().publicValuesBytes)) {
        problems.push('публичный вход не тот, что даёт батч для контракта');
    }
    if (JSON.stringify(source.variableInputs) !== '[1]') problems.push('переменных входов должно быть ровно один (дайджест)');
    const vkHash = '0x' + Cell.fromBase64(onchain.hinted.vkDataBoc).hash().toString('hex');
    if (vkHash !== key.keyHash) problems.push('ключ контракта не тот, что выведен из исходников (key.json)');
    return { current: problems.length === 0, reason: problems.map((problem) => `${PROOF_DIRECTORY}: ${problem}`).join('; ') };
}

export type ProvenEvmBatch = {
    proof: Bn254Proof;
    hinted: HintedFixture;
    publicInputs: bigint[];
    report: EvmBatchReport;
    roots: BatchRoots;
    /** Порции данных (RLP блока), которые публикуются в TON до отправки батча. */
    dataChunks: Cell[];
};

/** Пруф SP1 блока EVM вместе с подсказками для контракта и данными батча. */
export function loadProvenEvmBatch(): ProvenEvmBatch {
    const raw = read(PROOF_DIRECTORY, 'proof.json');
    const report = loadEvmBatchReport();
    return {
        proof: {
            a: [BigInt(raw.pi_a[0]), BigInt(raw.pi_a[1])],
            b: [
                [BigInt(raw.pi_b[0][0]), BigInt(raw.pi_b[0][1])],
                [BigInt(raw.pi_b[1][0]), BigInt(raw.pi_b[1][1])],
            ],
            c: [BigInt(raw.pi_c[0]), BigInt(raw.pi_c[1])],
        },
        hinted: (read(PROOF_DIRECTORY, 'onchain.json') as { hinted: HintedFixture }).hinted,
        publicInputs: (read(PROOF_DIRECTORY, 'public.json') as string[]).map(BigInt),
        report,
        roots: {
            newStateRoot: BigInt(report.publicValues.newStateRoot),
            withdrawalsRoot: BigInt(report.publicValues.withdrawalsRoot),
        },
        dataChunks: report.dataChunksHex.map((hex) => dataChunkCell(Buffer.from(hex, 'hex'))),
    };
}
