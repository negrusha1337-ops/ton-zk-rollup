import { spawn } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { Cell } from '@ton/core';
import { EvmBatchReport, publicInputOf } from '../wrappers/evmProofs';
import { assertNotShuttingDown, track } from './children';
import { jobKeyOf } from './jobKey';
import type { BatchProof, ProverJob } from './prover';

// Пруф батча от прувера (локального или удалённого) → BatchProof, который принимает SubmitBatch.
// До отправщика доходит только пруф, прошедший все сверки:
//   1. файл пруфа: ключ программы и хеш ELF — из program.json, публичные значения — ровно байты
//      задания (а те — байты отчёта хоста о блоке);
//   2. zk/import-sp1-fixture.mjs: проверка спариванием эталонной библиотекой под закреплённым
//      ключом схемы, нонс ноль, публичные значения снова сверяются с отчётом блока (--report);
//      фикстура пишется в каталог задания (--out-dir), fixtures/ не трогается;
//   3. zk/gen-bn254-groth16-fixture.mjs --dir: подсказки для контракта;
//   4. импортированная фикстура: публичный вход — sha256 публичных значений задания, ключ
//      контракта (хеш vkData) — тот, что в fixtures/evm_batches/key.json.

const ROOT = path.join(__dirname, '..');

/** Пруф не тот, что нужен заданию: отправлять его нельзя. Повтор прувера тут не поможет. */
export class ProofRejected extends Error {}

export type ImportOptions = {
    /** Каталог артефактов схемы Groth16 (Groth16Verifier.sol, SP1VerifierGroth16.sol). */
    circuitsDir: string;
    /** fixtures/evm_batches/program.json и key.json. */
    programKeysPath?: string;
    rollupKeyPath?: string;
    /** Предел времени каждого скрипта, мс. */
    timeoutMs?: number;
};

export const DEFAULT_CIRCUITS_DIR = path.join(os.homedir(), '.sp1', 'circuits', 'groth16', 'v6.1.0');
const bare = (hex: string) => hex.toLowerCase().replace(/^0x/, '');
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** Сырой файл пруфа хоста (`--proof-out`). */
type RawProof = { vkey: string; publicValues: string; proof: string; elfSha256?: string };

/** Сверка файла пруфа с заданием и с отчётом блока — до тяжёлого импорта. Пусто — годен. */
export function rawProofProblems(raw: RawProof, job: ProverJob, keys: { programVKey: string; programElfSha256: string }): string[] {
    const problems: string[] = [];
    const report = readJson<EvmBatchReport>(job.report);
    if (bare(report.publicValuesBytes) !== bare(job.publicValuesBytes) || bare(report.publicValues.newStateRoot) !== bare(job.blockHash))
        problems.push(`задание пруверу для блока ${job.number} не совпадает с отчётом хоста`);
    if (typeof raw.publicValues !== 'string' || bare(raw.publicValues) !== bare(job.publicValuesBytes))
        problems.push(
            `пруф доказывает публичные значения ${String(raw.publicValues).slice(0, 18)}…, а у блока ${job.number} — ${job.publicValuesBytes.slice(0, 18)}…: пруф чужого батча`,
        );
    if (typeof raw.vkey !== 'string' || BigInt(raw.vkey) !== BigInt(keys.programVKey))
        problems.push(`пруф построен для ключа программы ${raw.vkey}, а в program.json ${keys.programVKey}`);
    if (bare(raw.elfSha256 ?? '') !== bare(keys.programElfSha256) || bare(job.programElfSha256) !== bare(keys.programElfSha256))
        problems.push(`пруф построен ELF ${raw.elfSha256}, задание — ELF ${job.programElfSha256}, а в program.json ${keys.programElfSha256}`);
    return problems;
}

/** node-скрипт из zk/ под nice, с пределом времени; ненулевой код — ProofRejected с хвостом вывода. */
function runScript(script: string, args: string[], timeoutMs: number): Promise<void> {
    assertNotShuttingDown(script);
    return new Promise((resolve, reject) => {
        const child = track(spawn('nice', ['-n', '15', process.execPath, path.join(ROOT, 'zk', script), ...args], { cwd: ROOT }));
        const output: Buffer[] = [];
        child.stdout!.on('data', (chunk: Buffer) => output.push(chunk));
        child.stderr!.on('data', (chunk: Buffer) => output.push(chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.once('error', (error) => (clearTimeout(timer), reject(error)));
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0) return resolve();
            const lines = Buffer.concat(output).toString().split('\n').map((line) => line.trim()).filter(Boolean);
            const reason = lines.find((line) => /^Error: /.test(line)) ?? lines[lines.length - 1] ?? `код ${code}, сигнал ${signal}`;
            reject(new ProofRejected(`${script} отказал: ${reason.replace(/^Error: /, '')}`));
        });
    });
}

/**
 * Импорт и проверка пруфа задания. `rawProof` — файл хоста, `outDir` — каталог фикстуры (стирается
 * и пишется заново). Возвращает пруф для SubmitBatch; любой отказ — ProofRejected с причиной.
 */
export async function importBatchProof(job: ProverJob, rawProof: string, outDir: string, options: ImportOptions): Promise<BatchProof> {
    const keys = readJson<{ programVKey: string; programElfSha256: string }>(
        options.programKeysPath ?? path.join(ROOT, 'fixtures', 'evm_batches', 'program.json'),
    );
    const rollupKey = readJson<{ keyHash: string }>(options.rollupKeyPath ?? path.join(ROOT, 'fixtures', 'evm_batches', 'key.json'));
    let raw: RawProof;
    try {
        raw = readJson<RawProof>(rawProof);
    } catch (error) {
        throw new ProofRejected(`файл пруфа ${rawProof} не читается: ${(error as Error).message}`);
    }
    const problems = rawProofProblems(raw, job, keys);
    if (problems.length > 0) throw new ProofRejected(`пруф блока ${job.number} отвергнут до импорта: ${problems.join('; ')}`);
    for (const file of ['Groth16Verifier.sol', 'SP1VerifierGroth16.sol'])
        if (!existsSync(path.join(options.circuitsDir, file)))
            throw new ProofRejected(`нет ${path.join(options.circuitsDir, file)}: артефакты схемы Groth16 (PROVING.md → «Ресурсы»)`);
    rmSync(outDir, { recursive: true, force: true });
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    await runScript(
        'import-sp1-fixture.mjs',
        [
            path.join(options.circuitsDir, 'Groth16Verifier.sol'),
            path.join(options.circuitsDir, 'SP1VerifierGroth16.sol'),
            rawProof,
            'sp1_evm_sequencer',
            '--out-dir',
            outDir,
            '--report',
            job.report,
        ],
        timeoutMs,
    );
    await runScript('gen-bn254-groth16-fixture.mjs', ['--dir', outDir], timeoutMs);

    // Сверка импортированного: публичный вход и ключ контракта.
    const inputs = readJson<string[]>(path.join(outDir, 'public.json')).map(BigInt);
    const source = readJson<{ elfSha256?: string; variableInputs?: number[] }>(path.join(outDir, 'source.json'));
    const onchain = readJson<{ hinted: { vkDataBoc: string; hintsBoc: string } }>(path.join(outDir, 'onchain.json'));
    const after: string[] = [];
    if (inputs[0] !== BigInt(keys.programVKey)) after.push('ключ программы в публичных входах не тот, что в program.json');
    if (inputs[1] !== publicInputOf(job.publicValuesBytes)) after.push('публичный вход не тот, что дают публичные значения задания');
    if (inputs[2] !== 0n || inputs[4] !== 0n) after.push('exitCode или нонс пруфа не ноль');
    if (bare(source.elfSha256 ?? '') !== bare(keys.programElfSha256)) after.push('импорт записал другой ELF');
    if (JSON.stringify(source.variableInputs) !== '[1]') after.push('переменных входов не ровно один (дайджест)');
    const vkHash = '0x' + Cell.fromBase64(onchain.hinted.vkDataBoc).hash().toString('hex');
    if (BigInt(vkHash) !== BigInt(rollupKey.keyHash)) after.push(`ключ контракта пруфа ${vkHash}, а в key.json ${rollupKey.keyHash}`);
    if (after.length > 0) throw new ProofRejected(`пруф блока ${job.number} отвергнут после импорта: ${after.join('; ')}`);

    const proof = readJson<{ pi_a: string[]; pi_b: string[][]; pi_c: string[] }>(path.join(outDir, 'proof.json'));
    return {
        kind: 'groth16',
        proof: {
            a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
            b: [
                [BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1])],
                [BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1])],
            ],
            c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
        },
        hintsBoc: onchain.hinted.hintsBoc,
        jobKey: jobKeyOf(job),
    };
}
