import { spawnSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { loadProvenRethBatch } from '../wrappers/evmProofs';
import { liveChildren } from '../sequencer/children';
import { DEFAULT_CIRCUITS_DIR } from '../sequencer/proofImport';
import { jobKeyOf, ProofRejected, ProverCancelled, ProverFailure } from '../sequencer/prover';
import { LocalProver } from '../sequencer/prover';
import { RemoteProver, RemoteProverOptions } from '../sequencer/remoteProver';
import { makeProver, proverChoice } from '../sequencer/testnet';
import { fakeGpuServer, MAC_ELF } from './helpers/fakeSsh';
import { rethJob } from './helpers/fakeProver';

// RemoteProver (sequencer/remoteProver.ts) без сервера: ssh и scp — обёртки, исполняющие команды
// локально в каталоге-«сервере» (tests/helpers/fakeSsh.ts), на «сервере» — настоящий
// zkvm-evm/host/remote/prove-job.sh и подставной хост с готовым пруфом SP1 блока цепочки Reth.
// Импорт и проверка пруфа — настоящие (как у LocalProver). Случаи: успех, обрыв связи посреди
// (ожидание того же задания, без второго запуска), перезапуск сервиса во время пруфа, отмена,
// предел времени, сбой пруфа на сервере (повтор), неверный ELF и неготовый сервер, пруф с чужими
// публичными значениями. Что проверится только на настоящем сервере — sequencer/README.md.

const WORK = path.join(__dirname, '..', '.tools', 'sequencer-test', 'remote-prover');
const circuits = ['Groth16Verifier.sol', 'SP1VerifierGroth16.sol'].every((file) => existsSync(path.join(DEFAULT_CIRCUITS_DIR, file)));
const SUITE = 'RemoteProver: задание на сервере по ssh, импорт и проверка на этой машине';

const waitUntil = async (what: string, condition: () => boolean, ms = 20_000) => {
    for (const started = Date.now(); !condition(); await new Promise((resolve) => setTimeout(resolve, 50)))
        if (Date.now() - started > ms) throw new Error(`не дождался: ${what}`);
};
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

describe('--prover в check и run', () => {
    it('local (по умолчанию), remote — ssh-хост zk-gpu, remote:<хост>; прочее — отказ', () => {
        expect(proverChoice(undefined)).toEqual({ kind: 'local' });
        expect(proverChoice('local')).toEqual({ kind: 'local' });
        expect(proverChoice('remote')).toEqual({ kind: 'remote', host: 'zk-gpu' });
        expect(proverChoice('remote:gpu-2')).toEqual({ kind: 'remote', host: 'gpu-2' });
        expect(() => proverChoice('remote:a b')).toThrow('--prover=remote:a b: ожидается local, remote или remote:<ssh-хост из ~/.ssh/config>');
        expect(() => proverChoice('gpu')).toThrow(/ожидается local, remote/);
        const stateDir = path.join(WORK, 'choice');
        expect(makeProver({ prover: { kind: 'local' }, stateDir }, () => undefined)).toBeInstanceOf(LocalProver);
        const remote = makeProver({ prover: { kind: 'remote', host: 'gpu-2' }, stateDir }, () => undefined);
        expect(remote).toBeInstanceOf(RemoteProver);
        // Очередь на диске — та же, что у локального: <state-dir>/proofs/<ключ задания>.
        expect(remote.jobDir(rethJob(1))).toBe(path.join(stateDir, 'proofs', jobKeyOf(rethJob(1))));
    });
});

if (!circuits || !existsSync(MAC_ELF)) {
    describe(SUITE, () => {
        it.todo(`ждёт артефактов схемы Groth16 в ${DEFAULT_CIRCUITS_DIR} и ELF программы ${MAC_ELF} (PROVING.md)`);
    });
} else {
    describe(SUITE, () => {
        let dir: string;
        let server: ReturnType<typeof fakeGpuServer>;
        let lines: string[];
        const prover = (options: Partial<RemoteProverOptions> = {}) =>
            new RemoteProver({ host: 'zk-gpu', dir: path.join(dir, 'proofs'), ssh: server.ssh, scp: server.scp, pollMs: 100, log: (line) => lines.push(line), ...options });
        /** Команды prove-job.sh и scp, дошедшие до «сервера» (оборванные — нет). */
        const commands = () => server.calls().filter((call) => !call.dropped).map((call) => (call.tool === 'ssh' ? call.args[1].split(' ').slice(2, 3)[0] : 'scp'));

        beforeEach(() => {
            dir = path.join(WORK, randomBytes(4).toString('hex'));
            mkdirSync(dir, { recursive: true });
            server = fakeGpuServer(path.join(dir, 'server'));
            lines = [];
        });
        afterEach(() => {
            // Ничего не оставлять в фоне: процессы «сервера» — по журналу хоста.
            for (const run of server.hostRuns()) if (alive(run.pid)) process.kill(run.pid, 'SIGKILL');
            rmSync(dir, { recursive: true, force: true });
        });

        it('успех: на сервер — только вход блока; пруф с сервера проходит импорт и сверку; повтор — с диска, без ssh', async () => {
            const job = rethJob(1);
            const remote = prover();
            const proof = await remote.prove(job);
            const fixture = loadProvenRethBatch(1);
            expect(proof).toEqual({ kind: 'groth16', proof: fixture.proof, hintsBoc: fixture.hinted.hintsBoc, jobKey: jobKeyOf(job) });
            expect(remote.status(job)).toMatchObject({ state: 'verified', attempts: 0, host: 'zk-gpu' });
            // Копирований ровно два: вход блока туда, пруф обратно.
            const copies = server.calls().filter((call) => call.tool === 'scp');
            expect(copies.map((call) => call.args)).toEqual([
                [job.batchInput, `zk-gpu:ton-zk-rollup/remote-jobs/${jobKeyOf(job)}/batch.bin.part`],
                [`zk-gpu:ton-zk-rollup/remote-jobs/${jobKeyOf(job)}/proof.json`, path.join(remote.jobDir(job), 'proof-raw.json')],
            ]);
            expect(new Set(commands())).toEqual(new Set(['check', 'status', 'prepare', 'scp', 'start']));
            // Хост на сервере: ELF с мака, вход задания, Groth16 одним шагом на GPU.
            const [run] = server.hostRuns();
            expect(server.hostRuns()).toHaveLength(1);
            expect(run.args).toEqual([
                '--elf', path.join(server.home, 'ton-zk-rollup', 'remote-input', 'rollup-evm-program.elf'),
                '--batch-input', path.join(server.jobsDir, jobKeyOf(job), 'batch.bin'),
                '--prove', '--proof-out', path.join(server.jobsDir, jobKeyOf(job), 'proof.part'),
            ]);
            const before = server.calls().length;
            expect(await prover().prove(job)).toEqual(proof);
            expect(server.calls()).toHaveLength(before);
            expect(liveChildren()).toBe(0);
        }, 120_000);

        it('обрыв связи посреди пруфа: ожидание того же задания, второго запуска нет; связи нет дольше предела — отказ', async () => {
            server.host({ delayMs: 1500 });
            // Ответ на start потерян (команда исполнена), затем четыре обрыва опроса.
            server.net({ dropAfterStart: 4, dropStartReply: true });
            const job = rethJob(1);
            expect((await prover().prove(job)).jobKey).toBe(jobKeyOf(job));
            expect(server.hostRuns()).toHaveLength(1);
            expect(server.calls().filter((call) => call.dropped)).toHaveLength(4);
            // start повторён после потерянного ответа — и сервер ответил «уже идёт», второго пруфа нет.
            expect(commands().filter((command) => command === 'start')).toHaveLength(2);
            expect(lines.some((line) => /связи нет \d+ с \(опрос задания\): ssh zk-gpu: нет связи — .*Connection refused.* — жду; задание на сервере продолжается/.test(line))).toBe(true);
            expect(lines).toContain('прувер zk-gpu: связь восстановлена (опрос задания)');

            // Сервер пропал совсем: после предела — ProverFailure (сервис остановится; run снова продолжит).
            const job2 = rethJob(2);
            server.host({ hang: true });
            server.net({ dropAfterStart: 1000 });
            const failed = prover({ connectionLossLimitMs: 400 }).prove(job2);
            await expect(failed).rejects.toThrow(ProverFailure);
            await expect(failed).rejects.toThrow(/^удалённый прувер zk-gpu: связи нет \d+ с \(опрос задания\)/);
        }, 120_000);

        it('перезапуск сервиса во время пруфа: новый экземпляр ждёт идущее задание, не запуская его заново', async () => {
            server.host({ delayMs: 2500 });
            const job = rethJob(2);
            const first = prover().prove(job);
            await waitUntil('пруф на сервере запущен', () => server.hostRuns().length === 1);
            const startsBefore = commands().filter((command) => command === 'start').length;
            const second = await prover().prove(job);
            expect(commands().filter((command) => command === 'start')).toHaveLength(startsBefore);
            expect(second.jobKey).toBe(jobKeyOf(job));
            expect((await first).jobKey).toBe(jobKeyOf(job));
            expect(server.hostRuns()).toHaveLength(1);
        }, 120_000);

        it('отмена: процесс пруфа на сервере погашен, задание отменено и здесь, и там; повтор — отказ', async () => {
            server.host({ hang: true });
            const job = rethJob(1);
            const remote = prover();
            // Отказ приходит, пока отмена на сервере ещё идёт: ловить сразу.
            const proving = remote.prove(job).then(() => null, (error: Error) => error);
            await waitUntil('пруф на сервере запущен', () => server.hostRuns().length === 1);
            const [run] = server.hostRuns();
            await remote.cancel(job);
            expect(await proving).toBeInstanceOf(ProverCancelled);
            await waitUntil('процесс на сервере погашен', () => !alive(run.pid), 10_000);
            expect(remote.status(job)).toMatchObject({ state: 'cancelled' });
            expect(readFileSync(path.join(server.jobsDir, jobKeyOf(job), 'state'), 'utf8').trim()).toBe('cancelled');
            expect(lines).toContain('прувер zk-gpu: блок 1: задание отменено, пруф на сервере погашен');
            await expect(prover().prove(job)).rejects.toThrow(ProverCancelled);
        }, 120_000);

        it('предел времени: задание на сервере погашено, отказ ProverFailure', async () => {
            server.host({ hang: true });
            const job = rethJob(1);
            // Предел — с запасом на сверку сервера и запуск под нагрузкой полного прогона тестов.
            const failed = prover({ timeoutMs: 6000 }).prove(job);
            await waitUntil('пруф на сервере запущен', () => server.hostRuns().length === 1);
            await expect(failed).rejects.toThrow(/^блок 1: пруф на сервере zk-gpu не готов за 6 с — задание погашено$/);
            await waitUntil('процесс на сервере погашен', () => server.hostRuns().every((run) => !alive(run.pid)), 10_000);
            expect(readFileSync(path.join(server.jobsDir, jobKeyOf(job), 'state'), 'utf8').trim()).toBe('cancelled');
        }, 60_000);

        it('сбой пруфа на сервере: один шаг, затем два (как measure.sh), затем повтор задания; повторы кончились — отказ', async () => {
            // Первая попытка: onestep и обёртка двух шагов падают; вторая — onestep проходит.
            server.host({ failRuns: 2 });
            const job = rethJob(1);
            expect((await prover().prove(job)).jobKey).toBe(jobKeyOf(job));
            const modes = server.hostRuns().map((run) => run.args.find((arg) => ['--prove', '--prove-compressed', '--wrap-groth16'].includes(arg)));
            expect(modes).toEqual(['--prove', '--prove-compressed', '--wrap-groth16', '--prove']);
            expect(lines.some((line) => /блок 1: пруф на сервере завершился с кодом 1: .* — повтор 1 из 1/.test(line))).toBe(true);

            server.host({ failRuns: 100 });
            const job2 = rethJob(2);
            await expect(prover().prove(job2)).rejects.toThrow(/^блок 2: пруф на сервере завершился с кодом 1: .*; повторов было 1$/);
            expect(prover().status(job2)).toMatchObject({ state: 'failed', attempts: 1 });
        }, 120_000);

        it('процесс пруфа на сервере исчез (перезагрузка): задание потеряно — повтор с тем же входом', async () => {
            server.host({ hang: true });
            const job = rethJob(1);
            const proving = prover().prove(job);
            await waitUntil('пруф на сервере запущен', () => server.hostRuns().length === 1);
            server.host({});
            const runner = Number(readFileSync(path.join(server.jobsDir, jobKeyOf(job), 'pid'), 'utf8'));
            process.kill(server.hostRuns()[0].pid, 'SIGKILL');
            process.kill(runner, 'SIGKILL');
            expect((await proving).jobKey).toBe(jobKeyOf(job));
            expect(server.hostRuns()).toHaveLength(2);
            expect(lines.some((line) => /процесс пруфа на сервере исчез .* — повтор 1 из 1/.test(line))).toBe(true);
        }, 120_000);

        it('отказ хоста по входу (код 2) — без повтора', async () => {
            server.host({ failRuns: 100, failCode: 2 });
            const job = rethJob(1);
            await expect(prover().prove(job)).rejects.toThrow(/^блок 1: пруф на сервере завершился с кодом 2: [^;]*$/);
            // auto: один шаг, затем два — и всё: повтора задания нет.
            expect(server.hostRuns()).toHaveLength(3);
        }, 60_000);

        it('одно задание на сервере: второе ждёт, пока сервер занят первым', async () => {
            server.host({ delayMs: 1500 });
            const [one, two] = await Promise.all([prover().prove(rethJob(1)), new Promise((resolve) => setTimeout(resolve, 300)).then(() => prover().prove(rethJob(2)))]);
            expect([one.jobKey, two.jobKey]).toEqual([jobKeyOf(rethJob(1)), jobKeyOf(rethJob(2))]);
            const [first, second] = server.hostRuns();
            expect(second.start).toBeGreaterThanOrEqual(first.end!);
            // Кто первым дошёл до сервера — не важно: второй ждёт первого.
            const waited = [`блок 2: сервер занят заданием ${jobKeyOf(rethJob(1))} — жду`, `блок 1: сервер занят заданием ${jobKeyOf(rethJob(2))} — жду`];
            expect(lines.some((line) => waited.some((text) => line.includes(text)))).toBe(true);
        }, 120_000);

        it('prove-job.sh сам: испорченный при копировании вход и неверный ELF — отказ на сервере', async () => {
            const job = rethJob(1);
            const key = jobKeyOf(job);
            const script = 'bash ton-zk-rollup/zkvm-evm/host/remote/prove-job.sh';
            const remote = (command: string) => spawnSync(server.ssh, ['zk-gpu', `${script} ${command}`], { encoding: 'utf8' });
            expect(remote(`prepare ${key}`).stdout).toContain(`prepared=${key}`);
            copyFileSync(job.batchInput, path.join(server.jobsDir, key, 'batch.bin.part'));
            const wrong = remote(`start ${key} ${'0'.repeat(64)}`);
            expect([wrong.status, wrong.stdout.trim()]).toEqual([2, 'error=sha256 присланного входа не тот, что у сервиса: scp испорчен']);
            expect(remote('start nope 00').stdout.trim()).toBe('error=ключ задания «nope» — не 64hex-64hex');
            // ELF подменён после проверки RemoteProver: сам пруф откажет (код 2), хост не запустится.
            writeFileSync(path.join(server.home, 'ton-zk-rollup', 'remote-input', 'rollup-evm-program.elf'), 'другой ELF');
            const sha = createHash('sha256').update(readFileSync(job.batchInput)).digest('hex');
            expect(remote(`start ${key} ${sha}`).status).toBe(0);
            await waitUntil('пруф завершён', () => /state=failed/.test(remote(`status ${key}`).stdout));
            expect(remote(`status ${key}`).stdout).toMatch(/code=2/);
            expect(server.hostRuns()).toHaveLength(0);
        }, 60_000);

        it('неверный ELF на сервере — отказ до копирования входа; check показывает причину', async () => {
            server = fakeGpuServer(path.join(dir, 'server-bad-elf'), { elf: 'не тот ELF' });
            const remote = prover();
            const problems = await remote.serverProblems();
            expect(problems).toEqual([expect.stringMatching(/^ELF на сервере \([0-9a-f]{64}\) не совпадает с program\.json \(6828d42b/)]);
            const failed = remote.prove(rethJob(1));
            await expect(failed).rejects.toThrow(ProverFailure);
            await expect(failed).rejects.toThrow(/^блок 1: удалённый прувер zk-gpu не готов: ELF на сервере/);
            expect(server.calls().filter((call) => call.tool === 'scp')).toHaveLength(0);
            expect(server.hostRuns()).toHaveLength(0);
        }, 60_000);

        it('сервер не готов: нет хоста, нет nvidia-smi, другой prove-job.sh, нет связи — каждая причина своей строкой', async () => {
            server = fakeGpuServer(path.join(dir, 'server-bare'), { gpu: false, host: false });
            expect(await prover({ jobScript: path.join(__dirname, '..', 'zkvm-evm', 'host', 'remote', 'lib.sh') }).serverProblems()).toEqual([
                expect.stringMatching(/^prove-job\.sh на сервере \([0-9a-f]{12}…\) не тот, что здесь/),
                'на сервере не собран хост (zkvm-evm/target/release/rollup-evm-host): setup.sh',
                'на сервере нет nvidia-smi: это не сервер с NVIDIA или GPU не проброшен в контейнер',
            ]);
            server.net({ down: true });
            expect(await prover().serverProblems()).toEqual([expect.stringMatching(/^ssh до zk-gpu недоступен: ssh zk-gpu: нет связи/)]);
            expect(() => prover({ host: 'zk gpu; rm' })).toThrow('имя ssh-хоста «zk gpu; rm»: только буквы, цифры, . _ @ -');
            expect(() => prover({ remoteDir: '../etc' })).toThrow(/каталог на сервере «\.\.\/etc»/);
        }, 60_000);

        it('пруф с чужими публичными значениями с сервера — отказ ProofRejected, до отправщика не доходит', async () => {
            server.host({ proofOf: 1 });
            const job = rethJob(2);
            const rejected = prover().prove(job);
            await expect(rejected).rejects.toThrow(ProofRejected);
            await expect(rejected).rejects.toThrow(/^пруф блока 2 отвергнут до импорта: пруф доказывает публичные значения 0x[0-9a-f]{16}…, а у блока 2 — .*: пруф чужого батча$/);
            expect(prover().status(job)).toMatchObject({ state: 'failed' });
            expect(existsSync(path.join(prover().jobDir(job), 'proof.json'))).toBe(false);
        }, 120_000);
    });
}
