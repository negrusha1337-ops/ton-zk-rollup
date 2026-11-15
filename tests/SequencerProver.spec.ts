import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { loadProvenRethBatch } from '../wrappers/evmProofs';
import { liveChildren } from '../sequencer/children';
import { DEFAULT_CIRCUITS_DIR } from '../sequencer/proofImport';
import { jobKeyOf, LocalProver, LocalProverOptions, ProofRejected, ProverCancelled, ProverFailure } from '../sequencer/prover';
import { fakeProveScript, rethJob } from './helpers/fakeProver';

// Прувер сервиса (sequencer/prover.ts, LocalProver) на заглушке сторожа: вместо пруфа — готовые
// пруфы SP1 блоков 1–2 цепочки Reth. Импорт и проверка — настоящие (zk/import-sp1-fixture.mjs
// спариванием под закреплённым ключом схемы, подсказки — zk/gen-bn254-groth16-fixture.mjs), в
// каталог задания, fixtures/ не трогаются. Очередь, отмена, коды сторожа, чужие публичные значения.

const WORK = path.join(__dirname, '..', '.tools', 'sequencer-test', 'prover');
const circuits = ['Groth16Verifier.sol', 'SP1VerifierGroth16.sol'].every((file) => existsSync(path.join(DEFAULT_CIRCUITS_DIR, file)));
const SUITE = 'LocalProver: очередь на диске, коды сторожа, отмена, импорт и проверка пруфа';

if (!circuits) {
    describe(SUITE, () => {
        it.todo(`ждёт артефактов схемы Groth16 в ${DEFAULT_CIRCUITS_DIR} (PROVING.md → «Ресурсы»)`);
    });
} else {
    describe(SUITE, () => {
        let dir: string;
        let fake: ReturnType<typeof fakeProveScript>;
        let lines: string[];
        let pauses: number[];
        const prover = (options: Partial<LocalProverOptions> = {}) =>
            new LocalProver({
                dir: path.join(dir, 'proofs'),
                script: fake.script,
                log: (line) => lines.push(line),
                sleep: async (ms) => void pauses.push(ms),
                busyPauseMs: 1000,
                ...options,
            });

        beforeEach(() => {
            dir = path.join(WORK, randomBytes(4).toString('hex'));
            mkdirSync(dir, { recursive: true });
            fake = fakeProveScript(path.join(dir, 'fake'));
            lines = [];
            pauses = [];
        });
        afterEach(() => rmSync(dir, { recursive: true, force: true }));

        it('честный пруф: импорт и сверка, ключ задания, подсказки те же, что у фикстуры; повтор — с диска, без прувера', async () => {
            const job = rethJob(1);
            const local = prover();
            const proof = await local.prove(job);
            const fixture = loadProvenRethBatch(1);
            expect(proof).toEqual({ kind: 'groth16', proof: fixture.proof, hintsBoc: fixture.hinted.hintsBoc, jobKey: jobKeyOf(job) });
            expect(local.status(job)).toMatchObject({ state: 'verified', attempts: 0 });
            // Переменные шардов — из общего файла zkvm-evm/host/prover-shards.env.
            expect(fake.runs()).toEqual([expect.objectContaining({ input: 'block-1.bin', code: 0, elementThreshold: '67108864' })]);
            expect(existsSync(path.join(local.jobDir(job), 'fixture', 'onchain.json'))).toBe(true);
            // Перезапуск сервиса: новый экземпляр отдаёт проверенный пруф с диска.
            expect(await prover().prove(job)).toEqual(proof);
            expect(fake.runs()).toHaveLength(1);
            expect(liveChildren()).toBe(0);
        }, 120_000);

        it('строго одно задание за раз: второе ждёт конца первого', async () => {
            fake.behave({ delayMs: 400 });
            const local = prover();
            const [one, two] = await Promise.all([local.prove(rethJob(1)), local.prove(rethJob(2))]);
            expect(one.jobKey).toBe(jobKeyOf(rethJob(1)));
            expect(two.jobKey).toBe(jobKeyOf(rethJob(2)));
            const [first, second] = fake.runs();
            expect([first.input, second.input]).toEqual(['block-1.bin', 'block-2.bin']);
            expect(second.start).toBeGreaterThanOrEqual(first.end!);
        }, 120_000);

        it('коды сторожа: 95 и 98 — ждать (98 — с тревогой), 99 и 94 — повтор с пределом, прочие — отказ сразу', async () => {
            fake.behave({ codes: [95, 98, 99] });
            const job = rethJob(1);
            expect((await prover().prove(job)).jobKey).toBe(jobKeyOf(job));
            expect(fake.runs().map((run) => run.code)).toEqual([95, 98, 99, 0]);
            expect(pauses).toEqual([1000, 1000]);
            expect(lines).toContain('прувер: блок 1: другой прувер уже работает (код 95) — жду 1 с');
            expect(lines).toContain('прувер: блок 1: ТРЕВОГА: мало свободного места для старта прувера (код 98) — освободите диск; жду 1 с');
            expect(lines).toContain('прувер: блок 1: место на диске кончилось во время пруфа (код 99) — повтор 1 из 1');

            const job2 = rethJob(2);
            fake.behave({ codes: [99, 94] });
            await expect(prover().prove(job2)).rejects.toThrow(
                new ProverFailure('блок 2: пруф шёл дольше предела сторожа (код 94); повторов было 1'),
            );
            expect(prover().status(job2)).toMatchObject({ state: 'failed', attempts: 1 });

            rmSync(path.join(dir, 'proofs'), { recursive: true, force: true });
            fake.behave({ codes: [2] });
            const failed = prover().prove(job);
            await expect(failed).rejects.toThrow(ProverFailure);
            await expect(failed).rejects.toThrow(/^блок 1: прувер завершился с кодом 2 \(журнал .*prove\.log\)$/);
            fake.behave({ codes: [95] });
            await expect(prover({ busyWaitLimitMs: 0 }).prove(job)).rejects.toThrow(
                'блок 1: прувер не запустился за 0 с — другой прувер уже работает (код 95) — жду',
            );
        }, 120_000);

        it('отмена: прувер погашен, задание помечено отменённым, повтор задания — отказ', async () => {
            fake.behave({ hang: true });
            const job = rethJob(1);
            const local = prover();
            const proving = local.prove(job);
            for (let wait = 0; fake.runs().length === 0 && wait < 100; wait++) await new Promise((resolve) => setTimeout(resolve, 50));
            await local.cancel(job);
            await expect(proving).rejects.toThrow(new ProverCancelled(`задание блока 1 (${jobKeyOf(job)}) отменено: прувер погашен`));
            expect(fake.runs()[0].code).toBe(130);
            expect(local.status(job)).toMatchObject({ state: 'cancelled' });
            await expect(prover().prove(job)).rejects.toThrow(ProverCancelled);
            expect(liveChildren()).toBe(0);
        }, 60_000);

        it('пруф чужого батча и испорченный пруф — отказ с причиной, до отправщика не доходят', async () => {
            fake.behave({ proofOf: 1 });
            const job = rethJob(2);
            const rejected = prover().prove(job);
            await expect(rejected).rejects.toThrow(ProofRejected);
            await expect(rejected).rejects.toThrow(
                /^пруф блока 2 отвергнут до импорта: пруф доказывает публичные значения 0x[0-9a-f]{16}…, а у блока 2 — 0x[0-9a-f]{16}…: пруф чужого батча$/,
            );
            expect(prover().status(job)).toMatchObject({ state: 'failed' });
            expect(existsSync(path.join(prover().jobDir(job), 'proof.json'))).toBe(false);
            // Публичные значения свои, сам пруф испорчен: отвергает проверка спариванием в импорте.
            fake.behave({ corrupt: true });
            const one = rethJob(1);
            await expect(prover().prove(one)).rejects.toThrow(/^import-sp1-fixture\.mjs отказал: /);
            expect(existsSync(path.join(prover().jobDir(one), 'proof.json'))).toBe(false);
        }, 120_000);
    });
}
