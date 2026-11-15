import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { EvmBatchReport } from '../wrappers/evmProofs';
import { track } from './children';

// Вызовы программы батча: хост zkvm-evm (нативный расчёт той же библиотекой, что в zkVM) и
// штатный rsp (вход блока: блок, заголовки предков и свидетель состояния от узла одним
// запросом debug_executionWitness). Тяжёлое — под nice, по одному, с пределом времени; процессы
// на учёте (children.ts) и гасятся при выходе.

export type ProgramTools = {
    /** zkvm-evm/target/release/rollup-evm-host */
    host: string;
    /** .tools/rsp/target/release/rsp */
    rsp: string;
    /** Исполнять ли программу ещё и в zkVM (без пруфа): минуты на блок. */
    executeInZkvm: boolean;
    /** Предел времени одного запуска, мс; по умолчанию — 30 минут (с zkVM) или 10 минут. */
    timeoutMs?: number;
};

/** Ответ программы о форме принудительной транзакции (`--classify-forced`). */
export type FormVerdict =
    { index: number; form: 'valid'; signer: string; hash: string } | { index: number; form: 'skipped'; reason: string };

/** `signal` — если процесс убит (предел времени, OOM, сигнал извне). */
export type ProcessResult = { code: number | null; signal?: string | null; stdout: string; stderr: string };

/**
 * Сбой инструмента — не ответ программы о батче: хост или rsp не довели работу до конца (убит,
 * упал вне проверок программы, не нашёл файла, свидетель не согласован). Сервис повторяет вызов,
 * а не записывает кандидата в отвергнутые.
 */
export class ToolFailure extends Error {}

const ENVIRONMENT = { ...process.env, SP1_PROVER: 'mock', RAYON_NUM_THREADS: '4' };
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const timeoutOf = (tools: ProgramTools) => tools.timeoutMs ?? (tools.executeInZkvm ? 30 : 10) * 60_000;

/**
 * Запуск под `nice -n 15`; код выхода, сигнал и вывод — всегда, без исключения на ненулевом
 * коде. Превышение `timeoutMs` — SIGKILL (код null, сигнал SIGKILL).
 */
export function runNiced(
    binary: string,
    args: string[],
    logFile?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const child = track(spawn('nice', ['-n', '15', binary, ...args], { env: ENVIRONMENT }));
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            const result = {
                code,
                signal,
                stdout: Buffer.concat(stdout).toString(),
                stderr: Buffer.concat(stderr).toString(),
            };
            if (logFile)
                writeFileSync(
                    logFile,
                    `$ ${path.basename(binary)} ${args.join(' ')}\n# код ${code}${signal ? `, сигнал ${signal}` : ''}\n` +
                        `${result.stdout}\n--- stderr ---\n${result.stderr}`,
                );
            resolve(result);
        });
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
        (result.signal ? `убит сигналом ${result.signal}` : `код выхода ${result.code}`)
    );
}

/** Строка, которой хост отвечает на отказ программы (`process_evm_batch(...).expect(...)` в main.rs). */
export const PROGRAM_REFUSAL = 'нативный расчёт отверг батч';
/** Код выхода паники Rust: им хост завершается на отказе программы. */
export const PANIC_EXIT_CODE = 101;

/**
 * Ответ программы о батче или сбой инструмента. Отказ программы — ровно паника хоста на
 * `process_evm_batch` (код 101 и строка PROGRAM_REFUSAL). Всё прочее — код 2 (несогласованный
 * свидетель: ошибка самого сервиса), другая паника, сигнал (предел времени, OOM) — сбой.
 */
export function isProgramRefusal(result: ProcessResult): boolean {
    return result.code === PANIC_EXIT_CODE && !result.signal && result.stderr.includes(PROGRAM_REFUSAL);
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
        timeoutOf(tools),
    );
    if (result.code !== 0)
        throw new ToolFailure(`хост не проверил форму принудительных транзакций: ${refusalReason(result)}`);
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
        timeoutOf(tools),
    );
    const file = path.join(cache, 'input', options.chainId.toString(), `${options.number}.bin`);
    if (result.code !== 0 || !existsSync(file))
        throw new ToolFailure(`rsp не подготовил вход блока ${options.number}: ${refusalReason(result)}`);
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

export type HostReport = EvmBatchReport & { sourcesSha256?: string } & Record<string, unknown>;
export type HostVerdict = { accepted: true; report: HostReport } | { accepted: false; reason: string };

/**
 * Нативный расчёт программы над входом блока и свидетелем (с zkVM — по флагу). Принят —
 * отчёт и вход батча записаны (хост пишет их после всех проверок через временный файл).
 * Отвергнут — `accepted: false` с причиной; сбой инструмента — исключение ToolFailure.
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
    const result = await runNiced(tools.host, args, path.join(options.workDir, 'host.log'), timeoutOf(tools));
    if (isProgramRefusal(result)) return { accepted: false, reason: refusalReason(result) };
    if (result.code !== 0 || !existsSync(options.report))
        throw new ToolFailure(`хост не довёл расчёт до конца: ${refusalReason(result)}`);
    return { accepted: true, report: JSON.parse(readFileSync(options.report, 'utf8')) };
}

/** Чем собран хост (`--identity`). */
export type HostIdentity = {
    programElfSha256: string;
    sourcesSha256: string;
    sourcesSha256OnDisk: string;
    hostSha256: string;
    hostSha256OnDisk: string;
};

export async function hostIdentity(tools: ProgramTools): Promise<HostIdentity> {
    const result = await runNiced(tools.host, ['--identity'], undefined, 60_000);
    if (result.code !== 0) throw new ToolFailure(`хост не ответил на --identity: ${refusalReason(result)}`);
    return JSON.parse(result.stdout) as HostIdentity;
}

/** Что записано о сборке программы в fixtures/evm_batches/program.json (пишет только --vkeys). */
export type ProgramKeys = { sourcesSha256: string; programVKey: string; programElfSha256: string };

export const loadProgramKeys = (file: string): ProgramKeys => JSON.parse(readFileSync(file, 'utf8')) as ProgramKeys;

const bare = (hash: string) => hash.toLowerCase().replace(/^0x/, '');

/**
 * Расхождения сборки хоста с program.json: ELF и исходники программы, на момент сборки и на
 * диске сейчас, исходники хоста. Пусто — хост тот, под который выведен ключ контракта.
 */
export function identityMismatches(identity: HostIdentity, keys: ProgramKeys): string[] {
    const out: string[] = [];
    if (bare(identity.programElfSha256) !== bare(keys.programElfSha256))
        out.push(`ELF программы в хосте ${bare(identity.programElfSha256)}, в program.json ${bare(keys.programElfSha256)}`);
    if (bare(identity.sourcesSha256) !== bare(keys.sourcesSha256))
        out.push(`хост собран из исходников программы ${identity.sourcesSha256}, в program.json ${keys.sourcesSha256}`);
    if (identity.sourcesSha256 !== identity.sourcesSha256OnDisk)
        out.push(`исходники программы изменились после сборки хоста (на диске ${identity.sourcesSha256OnDisk})`);
    if (identity.hostSha256 !== identity.hostSha256OnDisk)
        out.push(`исходники хоста изменились после его сборки (на диске ${identity.hostSha256OnDisk})`);
    return out;
}

/** Отчёт хоста — от той же программы, что в program.json (ELF и, если хост их пишет, исходники). */
export function reportIdentityMismatches(report: HostReport, keys: ProgramKeys): string[] {
    const out: string[] = [];
    if (bare(report.programElfSha256 ?? '') !== bare(keys.programElfSha256))
        out.push(`отчёт хоста — от ELF ${bare(report.programElfSha256 ?? '')}, а в program.json ${bare(keys.programElfSha256)}`);
    if (report.sourcesSha256 !== undefined && bare(report.sourcesSha256) !== bare(keys.sourcesSha256))
        out.push(`отчёт хоста — от исходников ${report.sourcesSha256}, а в program.json ${keys.sourcesSha256}`);
    return out;
}

/**
 * Запуск хоста или rsp с повтором: сбой инструмента (ToolFailure — убит, упал вне проверок
 * программы, нет файла) — не отказ программы. Повторы кончились — исключение `stop(текст)`;
 * кандидат остаётся в работе и после перезапуска продолжается с той же фазы.
 */
export async function withToolRetries<T>(
    retries: number,
    what: string,
    call: () => Promise<T>,
    log: (line: string) => void,
    stop: (text: string) => Error,
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await call();
        } catch (error) {
            if (!(error instanceof ToolFailure)) throw error;
            if (attempt >= retries) throw stop(`${what}: сбой инструмента после ${attempt + 1} попыток — ${error.message}`);
            log(`${what}: сбой инструмента (${error.message}) — повтор`);
        }
    }
}
