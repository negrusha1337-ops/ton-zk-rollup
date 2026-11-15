import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { EvmBatchReport } from '../wrappers/evmProofs';

// Вызовы программы батча: хост zkvm-evm (нативный расчёт той же библиотекой, что в zkVM) и
// штатный rsp (вход блока: блок, заголовки предков и свидетель состояния от узла одним
// запросом debug_executionWitness). Тяжёлое — под nice, по одному.

export type ProgramTools = {
    /** zkvm-evm/target/release/rollup-evm-host */
    host: string;
    /** .tools/rsp/target/release/rsp */
    rsp: string;
    /** Исполнять ли программу ещё и в zkVM (без пруфа): минуты на блок. */
    executeInZkvm: boolean;
};

/** Ответ программы о форме принудительной транзакции (`--classify-forced`). */
export type FormVerdict =
    { index: number; form: 'valid'; signer: string; hash: string } | { index: number; form: 'skipped'; reason: string };

export type ProcessResult = { code: number | null; stdout: string; stderr: string };

const ENVIRONMENT = { ...process.env, SP1_PROVER: 'mock', RAYON_NUM_THREADS: '4' };

/** Запуск под `nice -n 15`; код выхода и вывод — всегда, без исключения на ненулевом коде. */
export function runNiced(binary: string, args: string[], logFile?: string): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        execFile(
            'nice',
            ['-n', '15', binary, ...args],
            { env: ENVIRONMENT, maxBuffer: 256 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error && typeof (error as NodeJS.ErrnoException).code === 'string') return reject(error);
                const code = error ? ((error as { code?: number }).code ?? null) : 0;
                if (logFile)
                    writeFileSync(
                        logFile,
                        `$ ${path.basename(binary)} ${args.join(' ')}\n# код ${code}\n${stdout}\n--- stderr ---\n${stderr}`,
                    );
                resolve({ code, stdout, stderr });
            },
        );
    });
}

/** Самая содержательная строка отказа: паника хоста («нативный расчёт отверг батч: …») либо первая строка stderr. */
export function refusalReason(result: ProcessResult): string {
    const lines = result.stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const panic = lines.find((line) => /отверг|не продолжает|нет пути|не согласуется|предыдущий батч|zkVM/.test(line));
    return (
        panic ??
        lines.find((line) => !line.startsWith('note:') && !line.startsWith('thread ')) ??
        `код выхода ${result.code}`
    );
}

export async function classifyForced(
    tools: ProgramTools,
    chainId: bigint,
    items: Buffer[],
    workDir: string,
): Promise<FormVerdict[]> {
    if (items.length === 0) return [];
    mkdirSync(workDir, { recursive: true });
    const input = path.join(workDir, 'forced-items.json');
    const output = path.join(workDir, 'forced-form.json');
    writeFileSync(input, JSON.stringify(items.map((bytes) => '0x' + bytes.toString('hex'))));
    rmSync(output, { force: true });
    const result = await runNiced(
        tools.host,
        ['--classify-forced', input, '--chain-id', chainId.toString(), '--report', output],
        path.join(workDir, 'forced-form.log'),
    );
    if (result.code !== 0)
        throw new Error(`хост не проверил форму принудительных транзакций: ${refusalReason(result)}`);
    const answer = JSON.parse(readFileSync(output, 'utf8')) as { chainId: string; verdicts: FormVerdict[] };
    if (answer.chainId !== chainId.toString() || answer.verdicts.length !== items.length)
        throw new Error('ответ хоста о форме не о тех элементах');
    return answer.verdicts.map((verdict) =>
        verdict.form === 'valid' ? { ...verdict, signer: verdict.signer.toLowerCase() } : verdict,
    );
}

/**
 * Вход блока для хоста — штатным rsp (`--state-backend execution-witness`). rsp берёт блок по
 * НОМЕРУ: блок обязан быть в канонической цепочке узла (см. README: «свидетель до головы»).
 * Каталог кэша — свой у каждого кандидата: rsp отдаёт вход из кэша, если файл уже есть, а на
 * той же высоте бывают разные кандидаты.
 */
export async function blockInput(
    tools: ProgramTools,
    options: { rpcUrl: string; genesisPath: string; chainId: bigint; number: number; workDir: string },
) {
    const cache = path.join(options.workDir, 'rsp-cache');
    rmSync(cache, { recursive: true, force: true });
    mkdirSync(cache, { recursive: true });
    const result = await runNiced(
        tools.rsp,
        [
            '--block-number',
            String(options.number),
            '--rpc-url',
            options.rpcUrl,
            '--genesis-path',
            options.genesisPath,
            '--cache-dir',
            cache,
            '--report-path',
            path.join(options.workDir, 'rsp-report.csv'),
            '--state-backend',
            'execution-witness',
        ],
        path.join(options.workDir, 'rsp.log'),
    );
    const file = path.join(cache, 'input', options.chainId.toString(), `${options.number}.bin`);
    if (result.code !== 0 || !existsSync(file))
        throw new Error(`rsp не подготовил вход блока ${options.number}: ${refusalReason(result)}`);
    return file;
}

/** Свидетель rollup'а для хоста (WitnessFile в zkvm-evm/host/src/main.rs). */
export type RollupWitness = {
    prevDepositHash: string;
    queueProcessedFrom: number;
    queue: ({ deposit: { l2Recipient: string; amount: string } } | { forcedTransaction: string })[];
    withdrawalsFrontier: string[];
    withdrawalsCount: string;
    accountProofs: { address: string; accountProof: string[]; code?: string }[];
};

export type HostVerdict =
    { accepted: true; report: EvmBatchReport & Record<string, unknown> } | { accepted: false; reason: string };

/**
 * Нативный расчёт программы над входом блока и свидетелем (с zkVM — по флагу). Принят —
 * отчёт и вход батча записаны (хост пишет их после всех проверок через временный файл).
 */
export async function runProgram(
    tools: ProgramTools,
    options: {
        blockInput: string;
        chainId: bigint;
        witness: RollupWitness;
        previousReport: string | null;
        workDir: string;
        batchInput: string;
        report: string;
    },
): Promise<HostVerdict> {
    const witnessFile = path.join(options.workDir, 'witness.json');
    writeFileSync(witnessFile, JSON.stringify(options.witness));
    rmSync(options.report, { force: true });
    const args = [
        '--block-input',
        options.blockInput,
        '--chain-id',
        options.chainId.toString(),
        '--witness',
        witnessFile,
        ...(options.previousReport ? ['--previous-report', options.previousReport] : []),
        ...(tools.executeInZkvm ? ['--execute'] : []),
        '--write-input',
        options.batchInput,
        '--report',
        options.report,
    ];
    const result = await runNiced(tools.host, args, path.join(options.workDir, 'host.log'));
    if (result.code !== 0) return { accepted: false, reason: refusalReason(result) };
    return { accepted: true, report: JSON.parse(readFileSync(options.report, 'utf8')) };
}
