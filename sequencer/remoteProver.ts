import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { assertNotShuttingDown, childEnv, signalChild, track } from './children';
import { jobKeyOf } from './jobKey';
import { ImportOptions } from './proofImport';
import { BatchProof, JobStatus, ProofQueue, Prover, ProverCancelled, ProverFailure, ProverJob } from './prover';

// Прувер на арендованном сервере с GPU (zkvm-evm/host/remote/: push.sh выкладывает набор, setup.sh
// собирает хост с cuda). Договор тот же, что у LocalProver: очередь на диске (ProofQueue: каталог
// на задание по ключу jobKeyOf), строго одно задание за раз, отмена, повторы, и пруф отдаётся
// только после того же импорта и проверки на этой машине (proofImport.ts: спаривание эталонной
// библиотекой, публичные значения против отчёта блока, ключ программы и ELF) — сервер не доверенный.
//
// Сервер. Доступ — ssh-хост из ~/.ssh/config пользователя (`--prover=remote:<хост>`, по умолчанию
// zk-gpu): ключи только у пользователя, здесь их нет. На сервер едет ТОЛЬКО вход блока (batch.bin);
// всё остальное (хост, ELF с мака, program.json, prove-job.sh) там уже есть после push.sh и
// setup.sh. При старте (`ready`, и в `check`) — сверка: ssh доступен, prove-job.sh на сервере —
// тот же, что здесь (sha256), хост собран, setup.sh пройден, ELF на сервере — тот, что в
// program.json (sha256), nvidia-smi есть. Иначе — ProverFailure с текстом, ничего не запускается.
//
// Задание (zkvm-evm/host/remote/prove-job.sh): prepare → scp batch.bin.part → start (sha256 входа
// сверяется на сервере; пруф идёт отдельной сессией setsid nohup — обрыв ssh его не гасит) →
// опрос status → scp proof.json → импорт и проверка здесь. Обрыв связи (ssh — код 255, scp —
// любой сбой) — ожидание того же задания, не новый запуск; связи нет дольше connectionLossLimitMs
// — ProverFailure (сервис останавливается; `run` снова продолжит то же задание, если сервер жив,
// а блок, не успевший к сроку, сервис пересоберёт сам). Сбой пруфа на сервере — повтор (`retries`,
// по умолчанию 1), кроме кода 2 (неверный вход или ELF — повтор даст то же). Отмена — cancel на
// сервере (группа процессов); общий предел времени (timeoutMs) — отмена и ProverFailure.

export type Shell = (command: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; output: string }>;

export type RemoteProverOptions = {
    /** Запись в ~/.ssh/config (как у push.sh). */
    host: string;
    /** Локальная очередь: каталог на задание, как у LocalProver. */
    dir: string;
    /** Каталог набора на сервере (относительно домашнего), как у push.sh. */
    remoteDir?: string;
    /** Команды ssh и scp (тесты подставляют свои). */
    ssh?: string;
    scp?: string;
    /** Путь пруфа на сервере: auto (по умолчанию), onestep или twostep — как у measure.sh. */
    mode?: 'auto' | 'onestep' | 'twostep';
    /** Пауза опроса, мс (30 с). */
    pollMs?: number;
    /** Предел времени задания от запуска, мс (3 ч). */
    timeoutMs?: number;
    /** Сколько терпеть отсутствие связи подряд, мс (15 мин). */
    connectionLossLimitMs?: number;
    /** Повторов после сбоя пруфа на сервере (1). */
    retries?: number;
    /** Сколько ждать, пока сервер занят другим заданием, мс (2 ч). */
    busyWaitLimitMs?: number;
    /** program.json: ELF на сервере сверяется с ним. */
    programKeysPath?: string;
    /** prove-job.sh этой машины: на сервере обязан быть тот же. */
    jobScript?: string;
    shell?: Shell;
    import?: Partial<ImportOptions>;
    log?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
};

const ROOT = path.join(__dirname, '..');
export const DEFAULT_REMOTE_HOST = 'zk-gpu';
export const DEFAULT_JOB_SCRIPT = path.join(ROOT, 'zkvm-evm', 'host', 'remote', 'prove-job.sh');
const DEFAULT_PROGRAM_KEYS = path.join(ROOT, 'fixtures', 'evm_batches', 'program.json');
/** Опции ssh и scp: без вопросов (ключи — агент или ~/.ssh/config), с пределом соединения. */
export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
/** Код ssh при сбое соединения (а не команды на сервере). */
const SSH_CONNECTION_FAILURE = 255;

const sha256File = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** ssh и scp — без оболочки на этой стороне, с пределом времени; вывод — для текста отказа. */
const spawnShell: Shell = (command, args, timeoutMs) => {
    assertNotShuttingDown(command);
    return new Promise((resolve, reject) => {
        const child = track(spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() }));
        const chunks: Buffer[] = [];
        child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stderr!.on('data', (chunk: Buffer) => chunks.push(chunk));
        const timer = setTimeout(() => signalChild(child, 'SIGKILL'), timeoutMs);
        child.once('error', (error) => (clearTimeout(timer), reject(error)));
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code: signal ? null : code, output: Buffer.concat(chunks).toString() });
        });
    });
};

/** Строки «ключ=значение» ответа prove-job.sh. */
export function parseAnswer(output: string): Record<string, string> {
    const answer: Record<string, string> = {};
    for (const line of output.split('\n')) {
        const match = /^([a-z]+)=(.*)$/.exec(line.trim());
        if (match) answer[match[1]] = match[2];
    }
    return answer;
}

/** Связи нет (ssh 255, scp не прошёл, процесс убит пределом времени): ждать, а не сдаваться. */
class ConnectionLost extends Error {}

export class RemoteProver implements Prover {
    private readonly shell: Shell;
    private readonly remoteDir: string;
    private readonly queue: ProofQueue;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly now: () => number;
    private chain: Promise<unknown> = Promise.resolve();
    private readonly cancelled = new Set<string>();
    private checked: Promise<void> | null = null;
    private lostSince: number | null = null;

    constructor(private readonly options: RemoteProverOptions) {
        if (!/^[A-Za-z0-9._@-]+$/.test(options.host)) throw new Error(`имя ssh-хоста «${options.host}»: только буквы, цифры, . _ @ -`);
        this.remoteDir = options.remoteDir ?? 'ton-zk-rollup';
        if (!/^[A-Za-z0-9._/-]+$/.test(this.remoteDir) || this.remoteDir.includes('..') || this.remoteDir.startsWith('/'))
            throw new Error(`каталог на сервере «${this.remoteDir}»: относительный путь из букв, цифр, . _ / -`);
        this.shell = options.shell ?? spawnShell;
        this.queue = new ProofQueue(options.dir);
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = options.now ?? Date.now;
    }

    private log(line: string) {
        this.options.log?.(`прувер ${this.options.host}: ${line}`);
    }

    jobDir(job: ProverJob): string {
        return this.queue.jobDir(job);
    }

    status(job: ProverJob): JobStatus | null {
        return this.queue.status(job);
    }

    private get script(): string {
        return `${this.remoteDir}/zkvm-evm/host/remote/prove-job.sh`;
    }

    /**
     * prove-job.sh на сервере: ответ разобран; код ≠ 0 — `refused` (кроме кодов 3 и 4 — их разбирает
     * вызывающий). Нет связи — ConnectionLost.
     */
    private async job(args: string[], timeoutMs = 120_000): Promise<{ code: number; answer: Record<string, string>; output: string }> {
        let result: { code: number | null; output: string };
        try {
            result = await this.shell(this.options.ssh ?? 'ssh', [...SSH_OPTIONS, '--', this.options.host, ['bash', this.script, ...args].join(' ')], timeoutMs);
        } catch (error) {
            throw new ConnectionLost(`ssh не запустился: ${(error as Error).message}`);
        }
        if (result.code === null || result.code === SSH_CONNECTION_FAILURE)
            throw new ConnectionLost(`ssh ${this.options.host}: ${result.code === null ? 'предел времени' : 'нет связи'} — ${lastLine(result.output)}`);
        return { code: result.code, answer: parseAnswer(result.output), output: result.output };
    }

    private async copy(from: string, to: string, timeoutMs = 30 * 60_000): Promise<void> {
        let result: { code: number | null; output: string };
        try {
            result = await this.shell(this.options.scp ?? 'scp', ['-q', ...SSH_OPTIONS, '--', from, to], timeoutMs);
        } catch (error) {
            throw new ConnectionLost(`scp не запустился: ${(error as Error).message}`);
        }
        if (result.code !== 0) throw new ConnectionLost(`scp ${from} → ${to}: код ${result.code} — ${lastLine(result.output)}`);
    }

    /**
     * Шаг с ожиданием связи: ConnectionLost — пауза и снова, пока связи нет не дольше
     * connectionLossLimitMs подряд; затем ProverFailure. Удачный шаг сбрасывает отсчёт.
     */
    private async connected<T>(what: string, job: ProverJob | null, step: () => Promise<T>): Promise<T> {
        const limit = this.options.connectionLossLimitMs ?? 15 * 60_000;
        for (;;) {
            if (job && this.cancelled.has(jobKeyOf(job))) throw new ProverCancelled(`задание блока ${job.number} (${jobKeyOf(job)}) отменено`);
            try {
                const value = await step();
                if (this.lostSince !== null) this.log(`связь восстановлена (${what})`);
                this.lostSince = null;
                return value;
            } catch (error) {
                if (!(error instanceof ConnectionLost)) throw error;
                this.lostSince ??= this.now();
                const seconds = Math.floor((this.now() - this.lostSince) / 1000);
                if (this.now() - this.lostSince >= limit)
                    throw new ProverFailure(`удалённый прувер ${this.options.host}: связи нет ${seconds} с (${what}): ${error.message}`);
                this.log(`связи нет ${seconds} с (${what}): ${error.message} — жду; задание на сервере продолжается`);
                await this.sleep(this.options.pollMs ?? 30_000);
            }
        }
    }

    /** Чем сервер не готов: пусто — готов. Ничего не запускает и не копирует. */
    async serverProblems(): Promise<string[]> {
        let reply: Awaited<ReturnType<RemoteProver['job']>>;
        try {
            reply = await this.job(['check'], 60_000);
        } catch (error) {
            return [`ssh до ${this.options.host} недоступен: ${(error as Error).message} (запись в ~/.ssh/config, ключ в агенте)`];
        }
        const { answer } = reply;
        if (reply.code !== 0 || answer.script === undefined)
            return [`на сервере нет ${this.script} или он не отвечает (код ${reply.code}: ${lastLine(reply.output)}): выложите набор push.sh и пройдите setup.sh`];
        const problems: string[] = [];
        const keys = JSON.parse(readFileSync(this.options.programKeysPath ?? DEFAULT_PROGRAM_KEYS, 'utf8')) as { programElfSha256: string };
        const local = sha256File(this.options.jobScript ?? DEFAULT_JOB_SCRIPT);
        if (answer.script !== local) problems.push(`prove-job.sh на сервере (${answer.script.slice(0, 12)}…) не тот, что здесь (${local.slice(0, 12)}…): выложите набор push.sh заново`);
        if (answer.host !== 'present') problems.push('на сервере не собран хост (zkvm-evm/target/release/rollup-evm-host): setup.sh');
        if (answer.setup !== 'present') problems.push('на сервере нет remote-out/env.sh: setup.sh не пройден');
        if (answer.elf !== keys.programElfSha256.replace(/^0x/, ''))
            problems.push(`ELF на сервере (${answer.elf}) не совпадает с program.json (${keys.programElfSha256}): выложите набор push.sh заново`);
        if (!answer.gpu || answer.gpu === 'missing') problems.push('на сервере нет nvidia-smi: это не сервер с NVIDIA или GPU не проброшен в контейнер');
        return problems;
    }

    /** Сверка сервера один раз на экземпляр; не готов — ProverFailure с причинами. */
    ready(): Promise<void> {
        this.checked ??= this.serverProblems().then((problems) => {
            if (problems.length > 0) {
                this.checked = null;
                throw new ProverFailure(`удалённый прувер ${this.options.host} не готов: ${problems.join('; ')}`);
            }
        });
        return this.checked;
    }

    async prove(job: ProverJob): Promise<BatchProof> {
        const ready = this.queue.begin(job);
        if (ready) return ready;
        const turn = this.chain.then(() => this.run(job));
        this.chain = turn.catch(() => undefined);
        return turn;
    }

    private async run(job: ProverJob): Promise<BatchProof> {
        const key = jobKeyOf(job);
        const host = this.options.host;
        const retries = this.options.retries ?? 1;
        const deadline = this.now() + (this.options.timeoutMs ?? 3 * 3600_000);
        let attempts = this.status(job)?.attempts ?? 0;
        const fail = (reason: string): never => {
            this.queue.setStatus(job, { state: 'failed', attempts, reason, host });
            throw new ProverFailure(`блок ${job.number}: ${reason}`);
        };
        try {
            await this.ready();
        } catch (error) {
            fail((error as Error).message);
        }
        let announced = false;
        for (;;) {
            if (this.cancelled.has(key) || this.status(job)?.state === 'cancelled') {
                this.queue.setStatus(job, { state: 'cancelled', attempts, reason: 'отменено', host });
                throw new ProverCancelled(`задание блока ${job.number} (${key}) отменено`);
            }
            if (this.now() > deadline) {
                await this.cancelRemote(key);
                fail(`пруф на сервере ${host} не готов за ${Math.round((this.options.timeoutMs ?? 3 * 3600_000) / 1000)} с — задание погашено`);
            }
            const status = await this.connected('опрос задания', job, () => this.job(['status', key]));
            if (status.code !== 0) fail(`prove-job.sh status — ${status.answer.error ?? lastLine(status.output)}`);
            const state = status.answer.state ?? 'none';
            if (state === 'none') {
                await this.launch(job, false);
                continue;
            }
            if (state === 'queued' || state === 'running') {
                if (!announced) this.log(`блок ${job.number}: пруф идёт на сервере (${key}, попытка ${status.answer.attempt})`);
                announced = true;
                this.queue.setStatus(job, { state: 'running', attempts, host });
                await this.sleep(this.options.pollMs ?? 30_000);
                continue;
            }
            if (state === 'done') break;
            if (state === 'cancelled') {
                this.queue.setStatus(job, { state: 'cancelled', attempts, reason: 'отменено на сервере', host });
                throw new ProverCancelled(`задание блока ${job.number} (${key}) отменено на сервере`);
            }
            // failed или lost (процесс на сервере исчез): повтор, кроме отказа хоста по входу (код 2).
            const reason = state === 'lost' ? 'процесс пруфа на сервере исчез (перезагрузка, убит извне)' : `пруф на сервере завершился с кодом ${status.answer.code}: ${status.answer.tail ?? ''}`;
            if (status.answer.code === '2' || attempts >= retries) fail(`${reason}${status.answer.code === '2' ? '' : `; повторов было ${attempts}`}`);
            attempts++;
            this.log(`блок ${job.number}: ${reason} — повтор ${attempts} из ${retries}`);
            this.queue.setStatus(job, { state: 'queued', attempts, reason, host });
            await this.launch(job, true);
        }
        const raw = path.join(this.jobDir(job), 'proof-raw.json');
        await this.connected('пруф с сервера', job, () => this.copy(`${host}:${this.remoteDir}/remote-jobs/${key}/proof.json`, raw));
        // Пруф с сервера не доверенный: те же импорт и проверка, что у LocalProver.
        const proof = await this.queue.importVerified(job, attempts, this.options.import, { host });
        this.log(`блок ${job.number}: пруф с сервера импортирован и сверен (${key})`);
        return proof;
    }

    /**
     * Вход на сервер и запуск: prepare, scp batch.bin.part, start (sha256 входа сверяет сервер).
     * Сервер занят другим заданием — ждать (не дольше busyWaitLimitMs). Отменено на сервере — ответ
     * разберёт следующий опрос.
     */
    private async launch(job: ProverJob, retry: boolean): Promise<void> {
        const key = jobKeyOf(job);
        const busyUntil = this.now() + (this.options.busyWaitLimitMs ?? 2 * 3600_000);
        const prepared = await this.connected('каталог задания', job, () => this.job(['prepare', key]));
        if (prepared.code !== 0) throw new ProverFailure(`блок ${job.number}: prove-job.sh prepare — ${prepared.answer.error ?? lastLine(prepared.output)}`);
        await this.connected('вход на сервер', job, () => this.copy(job.batchInput, `${this.options.host}:${this.remoteDir}/remote-jobs/${key}/batch.bin.part`));
        const args = ['start', key, sha256File(job.batchInput), this.options.mode ?? 'auto', ...(retry ? ['retry'] : [])];
        for (;;) {
            const started = await this.connected('запуск пруфа', job, () => this.job(args));
            if (started.code === 3) return;
            if (started.code === 4) {
                if (this.now() > busyUntil) throw new ProverFailure(`блок ${job.number}: сервер ${this.options.host} занят заданием ${started.answer.busy} дольше предела ожидания`);
                this.log(`блок ${job.number}: сервер занят заданием ${started.answer.busy} — жду`);
                await this.sleep(this.options.pollMs ?? 30_000);
                continue;
            }
            if (started.code !== 0) throw new ProverFailure(`блок ${job.number}: prove-job.sh start — ${started.answer.error ?? lastLine(started.output)}`);
            this.queue.setStatus(job, { state: 'running', attempts: this.status(job)?.attempts ?? 0, host: this.options.host });
            this.log(`блок ${job.number}: вход на сервере, пруф запущен (${started.answer.started})`);
            return;
        }
    }

    private async cancelRemote(key: string): Promise<boolean> {
        try {
            const reply = await this.job(['cancel', key], 60_000);
            return reply.code === 0;
        } catch (error) {
            this.log(`отмена на сервере не дошла: ${(error as Error).message}; погасить руками: ssh ${this.options.host} bash ${this.script} cancel ${key}`);
            return false;
        }
    }

    async cancel(job: ProverJob): Promise<void> {
        const key = jobKeyOf(job);
        this.cancelled.add(key);
        const status = this.status(job);
        if (status && status.state !== 'verified')
            this.queue.setStatus(job, { state: 'cancelled', attempts: status.attempts, reason: 'блок пересобирается', host: this.options.host });
        if (status && status.state !== 'verified' && (await this.cancelRemote(key))) this.log(`блок ${job.number}: задание отменено, пруф на сервере погашен`);
    }
}

const lastLine = (output: string) => output.trim().split('\n').pop()?.slice(0, 300) ?? '';
