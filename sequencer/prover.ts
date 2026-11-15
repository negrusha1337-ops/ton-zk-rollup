import { ChildProcess, spawn } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';
import { assertNotShuttingDown, childEnv, signalChild, track } from './children';
import { jobKeyOf } from './jobKey';
import { DEFAULT_CIRCUITS_DIR, importBatchProof, ImportOptions, ProofRejected } from './proofImport';
import { deserialize, serialize, writeAtomically } from './state';

// Прувер батча. Договор (круг 20, пункт 6): задание ключуется хешем блока и sha256 его публичных
// значений (`jobKeyOf`); пруф несёт ключ своего задания, и сервис отказывает пруфу с чужим ключом
// до отправки. Реализации:
//   MockProver   — заглушка для двойника контракта (contracts/rollup_mock.tolk), пруф не строит;
//   LocalProver  — SP1 Groth16 на этой машине: zkvm-evm/host/prove-guarded.sh, очередь на диске;
//   RemoteProver — сервер с GPU по ssh (sequencer/remoteProver.ts) с тем же договором.
// И локальный, и удалённый отдают пруф только после импорта и проверки (sequencer/proofImport.ts):
// очередь на диске и импорт — общие (ProofQueue).

export { jobKeyOf } from './jobKey';
export { ProofRejected } from './proofImport';

/** Задание пруверу: всё, что нужно для пруфа батча, лежит в каталоге блока. */
export type ProverJob = {
    number: number;
    blockHash: string;
    /** Вход батча для программы (bincode, --write-input хоста). */
    batchInput: string;
    /** Отчёт хоста: 11 слов, данные батча, отметки очереди. */
    report: string;
    /** 352 байта публичных значений — пруф обязан доказать ровно их. */
    publicValuesBytes: string;
    programElfSha256: string;
};

/** Пруф батча в виде, который принимает SubmitBatch: точки и подсказки проверки (ячейка), ключ задания. */
export type BatchProof = { kind: 'mock' | 'groth16'; proof: Bn254Proof; hintsBoc: string | null; jobKey: string };

export interface Prover {
    /** Пруф задания; повторный вызов с тем же заданием не строит пруф заново, если он уже проверен. */
    prove(job: ProverJob): Promise<BatchProof>;
    /**
     * Отменить задание: блок пересобирается, его батч контракт уже не примет. Прувер, у которого
     * заданий в фоне нет, может не реализовывать.
     */
    cancel?(job: ProverJob): Promise<void>;
}

/** Задание отменено (`cancel`): блок пересобирается, пруф не нужен. */
export class ProverCancelled extends Error {}
/** Прувер не построил пруф: повторы кончились либо сбой, который повтор не исправит. */
export class ProverFailure extends Error {}

/** Заглушка пруфа, которую принимает двойник: «первое число пруфа равно 1». */
export const MOCK_PROOF: Bn254Proof = {
    a: [1n, 0n],
    b: [
        [0n, 0n],
        [0n, 0n],
    ],
    c: [0n, 0n],
};

/** Прувер для двойника: пруф не строится. Проверяет только, что задание полное. */
export class MockProver implements Prover {
    async prove(job: ProverJob): Promise<BatchProof> {
        const report = JSON.parse(readFileSync(job.report, 'utf8')) as {
            publicValuesBytes: string;
            publicValues: { newStateRoot: string };
        };
        if (report.publicValuesBytes !== job.publicValuesBytes || report.publicValues.newStateRoot !== job.blockHash) {
            throw new Error(`задание пруверу для блока ${job.number} не совпадает с отчётом хоста`);
        }
        readFileSync(job.batchInput); // вход батча обязан существовать
        return { kind: 'mock', proof: MOCK_PROOF, hintsBoc: null, jobKey: jobKeyOf(job) };
    }
}

// --- LocalProver ---

const ROOT = path.join(__dirname, '..');
/** Сторож прувера: диск, память, время, второй прувер (коды — в шапке скрипта). */
export const DEFAULT_PROVE_SCRIPT = path.join(ROOT, 'zkvm-evm', 'host', 'prove-guarded.sh');
/** Переменные шардов SP1 для 16 ГБ — общий файл с PROVING.md и remote/measure.sh. */
export const DEFAULT_PROVER_ENV = path.join(ROOT, 'zkvm-evm', 'host', 'prover-shards.env');

/** Коды сторожа prove-guarded.sh. */
export const GUARD = { busy: 95, lowDiskAtStart: 98, diskRanOut: 99, timedOut: 94 } as const;

export type JobStatus = {
    state: 'queued' | 'running' | 'verified' | 'cancelled' | 'failed';
    /** Попыток после сбоев (LocalProver: 99/94; RemoteProver: сбой на сервере). */
    attempts: number;
    reason?: string;
    /** RemoteProver: ssh-хост, на котором идёт задание. */
    host?: string;
    updatedAt: string;
};

/**
 * Очередь заданий на диске — общая у LocalProver и RemoteProver: каталог на задание (имя — ключ
 * задания), `job.json`, `status.json`, `proof-raw.json`, `fixture/`, `proof.json`. Пруф отдаётся
 * только после импорта и проверки (`importVerified`), проверенный переживает перезапуск.
 */
export class ProofQueue {
    constructor(readonly dir: string) {}

    jobDir(job: ProverJob): string {
        return path.join(this.dir, jobKeyOf(job));
    }

    status(job: ProverJob): JobStatus | null {
        const file = path.join(this.jobDir(job), 'status.json');
        return existsSync(file) ? deserialize<JobStatus>(readFileSync(file, 'utf8')) : null;
    }

    setStatus(job: ProverJob, status: Omit<JobStatus, 'updatedAt'>): JobStatus {
        const full = { ...status, updatedAt: new Date().toISOString() };
        writeAtomically(path.join(this.jobDir(job), 'status.json'), serialize(full));
        return full;
    }

    /**
     * Начало prove: отменённое — ProverCancelled, проверенное — пруф с диска; иначе задание
     * записывается (новое и упавшее — queued с нуля попыток) и ответ null — строить.
     */
    begin(job: ProverJob): BatchProof | null {
        const status = this.status(job);
        if (status?.state === 'cancelled') throw new ProverCancelled(`задание блока ${job.number} (${jobKeyOf(job)}) отменено`);
        if (status?.state === 'verified') return this.verified(job);
        mkdirSync(this.jobDir(job), { recursive: true });
        writeAtomically(path.join(this.jobDir(job), 'job.json'), JSON.stringify(job, null, 1) + '\n');
        // Сбой прежней попытки (failed) — новое задание с нуля: решает сервис, запросивший пруф снова.
        if (!status || status.state === 'failed') this.setStatus(job, { state: 'queued', attempts: 0, host: status?.host });
        return null;
    }

    /** Пруф проверенного задания с диска (импорт уже был): ключ — тот же, что у задания. */
    verified(job: ProverJob): BatchProof {
        const proof = deserialize<BatchProof>(readFileSync(path.join(this.jobDir(job), 'proof.json'), 'utf8'));
        if (proof.jobKey !== jobKeyOf(job)) throw new ProofRejected(`на диске пруф с ключом ${proof.jobKey}, а задание — ${jobKeyOf(job)}`);
        return proof;
    }

    /** Импорт и проверка `proof-raw.json` задания (proofImport.ts); не прошёл — failed и ProofRejected. */
    async importVerified(job: ProverJob, attempts: number, options: Partial<ImportOptions> | undefined, extra: Partial<JobStatus> = {}): Promise<BatchProof> {
        const dir = this.jobDir(job);
        try {
            const proof = await importBatchProof(job, path.join(dir, 'proof-raw.json'), path.join(dir, 'fixture'), {
                circuitsDir: DEFAULT_CIRCUITS_DIR,
                ...options,
            });
            writeAtomically(path.join(dir, 'proof.json'), serialize(proof));
            this.setStatus(job, { ...extra, state: 'verified', attempts });
            return proof;
        } catch (error) {
            this.setStatus(job, { ...extra, state: 'failed', attempts, reason: (error as Error).message });
            throw error;
        }
    }
}

export type LocalProverOptions = {
    /** Очередь заданий: .tools/sequencer/proofs/ (каталог на задание, имя — ключ задания). */
    dir: string;
    script?: string;
    envFile?: string;
    /** Повторов после 99 (кончилось место) и 94 (вышло время); по умолчанию 1. */
    retries?: number;
    /** Пауза перед новой попыткой при 95 (другой прувер) и 98 (мало места), мс; по умолчанию 60 с. */
    busyPauseMs?: number;
    /** Сколько всего ждать при 95/98, мс; по умолчанию 2 ч. */
    busyWaitLimitMs?: number;
    /** Сколько ждать сторожа после SIGTERM при отмене, мс; затем SIGKILL. */
    cancelGraceMs?: number;
    /** Только для тестов и запуска не из корня: дополнительные переменные окружения сторожа. */
    extraEnv?: Record<string, string>;
    import?: Partial<ImportOptions>;
    log?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
};

/** Переменные окружения из файла ИМЯ=значение (комментарии — #). Непонятная строка — отказ. */
export function readEnvFile(file: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        const text = line.trim();
        if (text === '' || text.startsWith('#')) continue;
        const match = /^([A-Z_][A-Z0-9_]*)=([^\s'"]*)$/.exec(text);
        if (!match) throw new Error(`${file}:${index + 1}: не строка ИМЯ=значение — «${text}»`);
        out[match[1]] = match[2];
    }
    return out;
}

/**
 * SP1 Groth16 на этой машине. Очередь — на диске: у задания свой каталог (`job.json`,
 * `status.json`, `proof-raw.json`, `fixture/`, `prove.log`); строго одно задание за раз (внутри
 * процесса — очередь обещаний, между процессами — блокировка каталога сервиса и код 95 сторожа).
 * Проверенный пруф переживает перезапуск: повторный prove отдаёт его без нового пруфа.
 *
 * Реакция на коды сторожа: 95 (другой прувер работает) — ждать; 98 (мало места для старта) —
 * тревога в журнал и ждать; 99 (место кончилось) и 94 (вышло время) — повтор с пределом; прочие —
 * отказ. После пруфа — импорт и проверка (proofImport.ts); не прошёл — ProofRejected, повтора нет.
 */
export class LocalProver implements Prover {
    private chain: Promise<unknown> = Promise.resolve();
    private readonly running = new Map<string, ChildProcess>();
    private readonly cancelled = new Set<string>();
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly queue: ProofQueue;

    constructor(private readonly options: LocalProverOptions) {
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.queue = new ProofQueue(options.dir);
    }

    private log(line: string) {
        this.options.log?.(`прувер: ${line}`);
    }

    jobDir(job: ProverJob): string {
        return this.queue.jobDir(job);
    }

    status(job: ProverJob): JobStatus | null {
        return this.queue.status(job);
    }

    private setStatus(job: ProverJob, status: Omit<JobStatus, 'updatedAt'>): JobStatus {
        return this.queue.setStatus(job, status);
    }

    async prove(job: ProverJob): Promise<BatchProof> {
        const ready = this.queue.begin(job);
        if (ready) return ready;
        // Строго по одному: следующее задание ждёт конца предыдущего, каким бы он ни был.
        const turn = this.chain.then(() => this.run(job));
        this.chain = turn.catch(() => undefined);
        return turn;
    }

    private async run(job: ProverJob): Promise<BatchProof> {
        const key = jobKeyOf(job);
        const dir = this.jobDir(job);
        const retries = this.options.retries ?? 1;
        const pause = this.options.busyPauseMs ?? 60_000;
        const waitLimit = this.options.busyWaitLimitMs ?? 2 * 3600_000;
        let waited = 0;
        let attempts = this.status(job)?.attempts ?? 0;
        for (;;) {
            if (this.cancelled.has(key) || this.status(job)?.state === 'cancelled') {
                this.setStatus(job, { state: 'cancelled', attempts, reason: 'отменено до запуска' });
                throw new ProverCancelled(`задание блока ${job.number} (${key}) отменено`);
            }
            this.setStatus(job, { state: 'running', attempts });
            const raw = path.join(dir, 'proof-raw.json');
            const { code, signal } = await this.spawnGuard(job, raw);
            if (this.cancelled.has(key)) {
                this.setStatus(job, { state: 'cancelled', attempts, reason: 'прувер погашен отменой' });
                throw new ProverCancelled(`задание блока ${job.number} (${key}) отменено: прувер погашен`);
            }
            if (code === 0) break;
            if (code === GUARD.busy || code === GUARD.lowDiskAtStart) {
                const what =
                    code === GUARD.busy
                        ? 'другой прувер уже работает (код 95) — жду'
                        : 'ТРЕВОГА: мало свободного места для старта прувера (код 98) — освободите диск; жду';
                if (waited >= waitLimit) {
                    this.setStatus(job, { state: 'failed', attempts, reason: `ждал ${waited / 1000} с: ${what}` });
                    throw new ProverFailure(`блок ${job.number}: прувер не запустился за ${waited / 1000} с — ${what}`);
                }
                this.log(`блок ${job.number}: ${what} ${pause / 1000} с`);
                this.setStatus(job, { state: 'queued', attempts, reason: what });
                await this.sleep(pause);
                waited += pause;
                continue;
            }
            const retryable = code === GUARD.diskRanOut || code === GUARD.timedOut;
            const reason =
                code === GUARD.diskRanOut
                    ? 'место на диске кончилось во время пруфа (код 99)'
                    : code === GUARD.timedOut
                      ? 'пруф шёл дольше предела сторожа (код 94)'
                      : `прувер завершился с кодом ${code}${signal ? `, сигнал ${signal}` : ''} (журнал ${path.join(dir, 'prove.log')})`;
            if (!retryable || attempts >= retries) {
                this.setStatus(job, { state: 'failed', attempts, reason });
                throw new ProverFailure(`блок ${job.number}: ${reason}${retryable ? `; повторов было ${attempts}` : ''}`);
            }
            attempts++;
            this.log(`блок ${job.number}: ${reason} — повтор ${attempts} из ${retries}`);
        }
        const proof = await this.queue.importVerified(job, attempts, this.options.import);
        this.log(`блок ${job.number}: пруф построен, импортирован и сверен (${key})`);
        return proof;
    }

    private spawnGuard(job: ProverJob, rawProof: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
        assertNotShuttingDown('прувер');
        // Без секретов сервиса (круг 21, пункт 3).
        const env = childEnv({ ...readEnvFile(this.options.envFile ?? DEFAULT_PROVER_ENV), ...this.options.extraEnv });
        const log = createWriteStream(path.join(this.jobDir(job), 'prove.log'), { flags: 'a' });
        return new Promise((resolve, reject) => {
            const child = track(
                // Своя группа процессов (круг 21, пункт 4): отмена и остановка гасят и прувер, и всё,
                // что запустил сторож, а не одного сторожа.
                spawn(this.options.script ?? DEFAULT_PROVE_SCRIPT, ['--batch-input', job.batchInput, '--prove', '--proof-out', rawProof], {
                    env,
                    cwd: ROOT,
                    detached: true,
                }),
                { group: true },
            );
            this.running.set(jobKeyOf(job), child);
            child.stdout!.pipe(log, { end: false });
            child.stderr!.pipe(log, { end: false });
            child.once('error', (error) => {
                this.running.delete(jobKeyOf(job));
                log.end();
                reject(error);
            });
            child.once('close', (code, signal) => {
                this.running.delete(jobKeyOf(job));
                log.end(() => resolve({ code, signal }));
            });
        });
    }

    async cancel(job: ProverJob): Promise<void> {
        const key = jobKeyOf(job);
        this.cancelled.add(key);
        if (existsSync(this.jobDir(job)) && this.status(job)?.state !== 'verified')
            this.setStatus(job, { state: 'cancelled', attempts: this.status(job)?.attempts ?? 0, reason: 'блок пересобирается' });
        const child = this.running.get(key);
        if (!child) return;
        // SIGTERM — всей группе сторожа (и прувер, и его дочерние); не успели — SIGKILL группе.
        const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
        signalChild(child, 'SIGTERM');
        let timer: NodeJS.Timeout | undefined;
        const grace = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), this.options.cancelGraceMs ?? 15_000)));
        if ((await Promise.race([exited, grace])) === 'timeout') signalChild(child, 'SIGKILL');
        clearTimeout(timer);
        await exited;
        this.log(`блок ${job.number}: задание отменено, прувер погашен`);
    }
}
