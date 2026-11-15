import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import path from 'path';
import { assertNotShuttingDown, childEnv, track } from './children';
import { jobKeyOf } from './jobKey';
import { DEFAULT_CIRCUITS_DIR, importBatchProof, ImportOptions } from './proofImport';
import { BatchProof, Prover, ProverFailure, ProverJob } from './prover';

// ЗАГОТОВКА прувера на арендованном сервере с GPU (zkvm-evm/host/remote/: setup.sh собирает хост с
// cuda, push.sh выкладывает ELF мака). Договор тот же, что у LocalProver: задание — по ключу
// jobKeyOf, пруф отдаётся только после тех же импорта и сверки (proofImport.ts). С настоящим
// сервером НЕ запускалась: проверены только порядок команд и путь пруфа через импорт (тест на
// подставной оболочке). Что сделать до запуска: проверить, что push.sh уже выложил ELF и хост
// собран (`remote-out/env.sh`), выбрать путь пруфа (onestep/twostep, как measure.sh) и предел
// времени; секреты ssh — только в ~/.ssh/config пользователя.
//
// Команды на задание:
//   ssh <host> mkdir -p <dir>/remote-input/jobs <dir>/remote-out/jobs
//   scp <batch.bin> <host>:<dir>/remote-input/jobs/<ключ>.bin
//   ssh <host> 'cd <dir> && . remote-out/env.sh && SP1_PROVER=cuda <хост> --elf remote-input/rollup-evm-program.elf
//              --batch-input remote-input/jobs/<ключ>.bin --prove --proof-out remote-out/jobs/<ключ>.json'
//   scp <host>:<dir>/remote-out/jobs/<ключ>.json <каталог задания>/proof-raw.json

export type Shell = (command: string, args: string[]) => Promise<{ code: number | null; output: string }>;

export type RemoteProverOptions = {
    /** Запись в ~/.ssh/config (как у push.sh). */
    host: string;
    /** Локальная очередь: каталог на задание, как у LocalProver. */
    dir: string;
    /** Каталог набора на сервере (относительно домашнего). */
    remoteDir?: string;
    shell?: Shell;
    import?: Partial<ImportOptions>;
};

/** ssh и scp — без оболочки на этой стороне; вывод — для текста отказа. */
const spawnShell: Shell = (command, args) => {
    assertNotShuttingDown(command);
    return new Promise((resolve, reject) => {
        const child = track(spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() }));
        const chunks: Buffer[] = [];
        child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.stderr!.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, output: Buffer.concat(chunks).toString() }));
    });
};

export class RemoteProver implements Prover {
    private readonly shell: Shell;
    private readonly remoteDir: string;

    constructor(private readonly options: RemoteProverOptions) {
        if (!/^[A-Za-z0-9._@-]+$/.test(options.host))
            throw new Error(`имя ssh-хоста «${options.host}»: только буквы, цифры, . _ @ -`);
        this.remoteDir = options.remoteDir ?? 'ton-zk-rollup';
        if (!/^[A-Za-z0-9._/-]+$/.test(this.remoteDir)) throw new Error(`каталог на сервере «${this.remoteDir}»: только буквы, цифры, . _ / -`);
        this.shell = options.shell ?? spawnShell;
    }

    jobDir(job: ProverJob): string {
        return path.join(this.options.dir, jobKeyOf(job));
    }

    private async run(what: string, command: string, args: string[]): Promise<void> {
        const result = await this.shell(command, args);
        if (result.code !== 0)
            throw new ProverFailure(`удалённый прувер: ${what} — код ${result.code}: ${result.output.trim().split('\n').pop() ?? ''}`);
    }

    async prove(job: ProverJob): Promise<BatchProof> {
        const key = jobKeyOf(job);
        const dir = this.jobDir(job);
        mkdirSync(dir, { recursive: true });
        const { host } = this.options;
        const input = `${this.remoteDir}/remote-input/jobs/${key}.bin`;
        const output = `${this.remoteDir}/remote-out/jobs/${key}.json`;
        await this.run('каталоги заданий', 'ssh', [host, `mkdir -p ${this.remoteDir}/remote-input/jobs ${this.remoteDir}/remote-out/jobs`]);
        await this.run('вход батча на сервер', 'scp', [job.batchInput, `${host}:${input}`]);
        await this.run('пруф на сервере', 'ssh', [
            host,
            `cd ${this.remoteDir} && . remote-out/env.sh && SP1_PROVER=cuda zkvm-evm/target/release/rollup-evm-host ` +
                `--elf remote-input/rollup-evm-program.elf --batch-input remote-input/jobs/${key}.bin --prove --proof-out remote-out/jobs/${key}.json`,
        ]);
        const raw = path.join(dir, 'proof-raw.json');
        await this.run('пруф с сервера', 'scp', [`${host}:${output}`, raw]);
        return importBatchProof(job, raw, path.join(dir, 'fixture'), { circuitsDir: DEFAULT_CIRCUITS_DIR, ...this.options.import });
    }

    async cancel(job: ProverJob): Promise<void> {
        await this.run('отмена', 'ssh', [this.options.host, `pkill -f 'remote-input/jobs/${jobKeyOf(job)}.bin' || true`]);
    }
}
