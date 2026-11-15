import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { mnemonicNew } from '@ton/crypto';
import { childEnv, liveChildren, SECRET_ENV, terminateChildren } from '../sequencer/children';
import { ProofRejected } from '../sequencer/proofImport';
import { LocalProver, LocalProverOptions, ProverFailure } from '../sequencer/prover';
import { SequencerStop } from '../sequencer/service';
import { StateDirBusy } from '../sequencer/state';
import { serve } from '../sequencer/testnet';
import { SequencerWallet } from '../sequencer/ton';
import { fakeProveScript, rethJob } from './helpers/fakeProver';

// Правки круга 21 в процессах сервиса: секреты не уходят дочерним (3), сторож прувера и всё, что
// он запустил, гасятся группой (4), цикл run останавливается без повторов там, где нужен человек
// (2, 5в). Отправщик testnet (1, 5б, 5е, 6) — в tests/SequencerTestnet.spec.ts. Каждый тест падает
// без своей правки (мутации — в REVIEW.md, круг 21).

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, '.tools', 'sequencer-test', 'round21');

/** Процессы, в командной строке которых есть метка (pgrep -f). */
const processesWith = (tag: string): string[] => {
    try {
        return execFileSync('pgrep', ['-f', tag], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch {
        return []; // pgrep: код 1 — ни одного
    }
};

/** Дождаться условия (процессы гасятся не мгновенно), не дольше `ms`. */
async function eventually(check: () => boolean, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
}

describe('круг 21: окружение дочерних, группы процессов прувера, остановка цикла run', () => {
    let dir: string;
    let fake: ReturnType<typeof fakeProveScript>;
    const tags: string[] = [];
    const prover = (options: Partial<LocalProverOptions> = {}) =>
        new LocalProver({ dir: path.join(dir, 'proofs'), script: fake.script, sleep: async () => {}, cancelGraceMs: 2000, ...options });
    const newTag = () => {
        const tag = `round21-orphan-${randomBytes(6).toString('hex')}`;
        tags.push(tag);
        return tag;
    };

    beforeEach(() => {
        dir = path.join(WORK, randomBytes(4).toString('hex'));
        mkdirSync(dir, { recursive: true });
        fake = fakeProveScript(path.join(dir, 'fake'));
    });
    afterEach(() => {
        // Ничего не оставлять в фоне, даже если тест упал.
        for (const tag of tags.splice(0)) for (const pid of processesWith(tag)) process.kill(Number(pid), 'SIGKILL');
        rmSync(dir, { recursive: true, force: true });
    });

    describe('3: мнемоника не уходит дочерним', () => {
        const saved = { ...process.env };
        afterEach(() => {
            for (const name of ['WALLET_MNEMONIC', 'WALLET_VERSION', 'TONCENTER_API_KEY']) {
                if (saved[name] === undefined) delete process.env[name];
                else process.env[name] = saved[name];
            }
        });

        it('после разбора кошелька WALLET_MNEMONIC в окружении процесса нет', async () => {
            process.env.WALLET_MNEMONIC = (await mnemonicNew()).join(' ');
            process.env.WALLET_VERSION = 'v5r1';
            const wallet = await SequencerWallet.fromProcessEnv();
            expect(wallet.version).toBe('v5r1');
            expect(process.env.WALLET_MNEMONIC).toBeUndefined();
            expect(process.env.WALLET_VERSION).toBe('v5r1');
            // И при негодной мнемонике — тоже удаляется.
            process.env.WALLET_MNEMONIC = 'тайное слово';
            await expect(SequencerWallet.fromProcessEnv()).rejects.toThrow('WALLET_MNEMONIC не разбирается');
            expect(process.env.WALLET_MNEMONIC).toBeUndefined();
        });

        it('сторож прувера не видит WALLET_MNEMONIC и TONCENTER_API_KEY, даже если они в окружении сервиса', async () => {
            process.env.WALLET_MNEMONIC = 'слова мнемоники для теста';
            process.env.TONCENTER_API_KEY = 'ключ для теста';
            fake.behave({ codes: [7] });
            await expect(prover().prove(rethJob(1))).rejects.toThrow(ProverFailure);
            const [run] = fake.runs();
            expect(run.code).toBe(7);
            expect(run.walletMnemonic).toBeUndefined();
            // Переменные шардов при этом доходят.
            expect(run.elementThreshold).toBe('67108864');
            const env = childEnv({ EXTRA: '1', WALLET_MNEMONIC: 'через extra' });
            for (const name of SECRET_ENV) expect(env[name]).toBeUndefined();
            expect(env.EXTRA).toBe('1');
        }, 60_000);

        it('ни один запуск процесса в sequencer/ не наследует окружение целиком: у каждого env — childEnv(…)', () => {
            const sources: string[] = [];
            const walk = (folder: string) => {
                for (const name of readdirSync(folder)) {
                    const file = path.join(folder, name);
                    if (statSync(file).isDirectory()) walk(file);
                    else if (/\.(ts|mjs|js)$/.test(name)) sources.push(file);
                }
            };
            walk(path.join(ROOT, 'sequencer'));
            const calls: { file: string; text: string }[] = [];
            for (const file of sources) {
                const source = readFileSync(file, 'utf8');
                // Окружение целиком копирует только сам фильтр (children.ts, childEnv).
                if (path.basename(file) !== 'children.ts') expect(source).not.toMatch(/\.\.\.process\.env\b/);
                const call = /(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/g;
                for (let match = call.exec(source); match; match = call.exec(source)) {
                    // Аргументы вызова — до парной скобки.
                    let depth = 0;
                    let end = match.index + match[0].length - 1;
                    for (; end < source.length; end++) {
                        if (source[end] === '(') depth++;
                        else if (source[end] === ')' && --depth === 0) break;
                    }
                    calls.push({ file: path.relative(ROOT, file), text: source.slice(match.index, end + 1) });
                }
            }
            // Все известные запуски найдены: reth, хост и rsp, прувер, импорт, ssh/scp, проверка ключа
            // (check и deploy).
            expect(new Set(calls.map((call) => call.file))).toEqual(
                new Set([
                    'sequencer/node.ts', 'sequencer/program.ts', 'sequencer/prover.ts', 'sequencer/proofImport.ts', 'sequencer/remoteProver.ts', 'sequencer/testnet.ts',
                    'sequencer/deploy.ts',
                ]),
            );
            const unfiltered = calls.filter((call) => !/\benv(:\s*(childEnv\(|environment\(\))|\s*,)/.test(call.text));
            expect(unfiltered.map((call) => `${call.file}: ${call.text.slice(0, 60)}`)).toEqual([]);
            // Окружение хоста (environment()) и прувера (env) — тоже из childEnv.
            expect(readFileSync(path.join(ROOT, 'sequencer', 'program.ts'), 'utf8')).toMatch(/const environment = \(\) => childEnv\(/);
            expect(readFileSync(path.join(ROOT, 'sequencer', 'prover.ts'), 'utf8')).toMatch(/const env = childEnv\(/);
        });
    });

    describe('4: сторож прувера и его дочерние гасятся группой', () => {
        it('отмена задания: SIGTERM всей группе — дочернего сторожа не остаётся', async () => {
            const tag = newTag();
            fake.behave({ hang: true, spawnChild: tag });
            const local = prover();
            const job = rethJob(1);
            const proving = local.prove(job).catch((error) => error);
            expect(await eventually(() => processesWith(tag).length === 1)).toBe(true);
            await local.cancel(job);
            expect(await proving).toBeInstanceOf(Error);
            expect(await eventually(() => processesWith(tag).length === 0)).toBe(true);
            // SIGTERM дошёл и до дочернего: сторож дождался его и вышел сам (130), а не по SIGKILL.
            expect(fake.runs()[0].code).toBe(130);
            expect(liveChildren()).toBe(0);
        }, 60_000);

        it('остановка сервиса (сигнал → terminateChildren): дочернего сторожа не остаётся', async () => {
            const tag = newTag();
            fake.behave({ hang: true, spawnChild: tag });
            const proving = prover().prove(rethJob(1)).catch((error) => error);
            expect(await eventually(() => processesWith(tag).length === 1)).toBe(true);
            await terminateChildren(2000);
            expect(await proving).toBeInstanceOf(ProverFailure);
            expect(await eventually(() => processesWith(tag).length === 0)).toBe(true);
        }, 60_000);

        it('сторож вышел сам, а его дочерний остался — SIGKILL оставшимся в группе', async () => {
            const tag = newTag();
            fake.behave({ codes: [7], spawnChild: tag });
            await expect(prover().prove(rethJob(1))).rejects.toThrow(ProverFailure);
            expect(await eventually(() => processesWith(tag).length === 0)).toBe(true);
        }, 60_000);
    });

    describe('5г: каталог вывода фикстуры — вне fixtures/ по настоящему пути (симлинк, регистр)', () => {
        const node = (args: string[]) => {
            try {
                execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'pipe', env: childEnv() });
                return { code: 0, stderr: '' };
            } catch (error) {
                const failed = error as { status: number; stderr: Buffer };
                return { code: failed.status, stderr: failed.stderr.toString() };
            }
        };
        const importInto = (out: string) =>
            node([path.join(ROOT, 'zk', 'import-sp1-fixture.mjs'), 'a.sol', 'b.sol', 'proof.json', 'sp1_evm_sequencer', '--out-dir', out, '--report', 'report.json']);
        const hintsInto = (out: string) => node([path.join(ROOT, 'zk', 'gen-bn254-groth16-fixture.mjs'), '--dir', out]);

        it('симлинк вне fixtures/, указывающий внутрь, и FIXTURES/ в другом регистре — отказ обоих скриптов', () => {
            const link = path.join(dir, 'link');
            symlinkSync(path.join(ROOT, 'fixtures'), link);
            const caseVariant = path.join(ROOT, 'FIXTURES', 'sequencer-round21');
            const caseless = existsSync(path.join(ROOT, 'FIXTURES'));
            for (const out of [path.join(link, 'sequencer-round21'), ...(caseless ? [caseVariant] : [])]) {
                expect(importInto(out)).toEqual({ code: 1, stderr: expect.stringContaining('Пруф батча сервиса пишется вне fixtures/') });
                expect(hintsInto(out)).toEqual({ code: 1, stderr: expect.stringContaining('--dir пишет фикстуру вне fixtures/') });
            }
            expect(existsSync(path.join(ROOT, 'fixtures', 'sequencer-round21'))).toBe(false);
            // Каталог действительно вне fixtures/ — сверка пропускает (дальше скрипт падает на входе).
            expect(importInto(path.join(dir, 'out')).stderr).not.toContain('вне fixtures/');
            expect(hintsInto(path.join(dir, 'out')).stderr).toContain('Нет фикстуры');
        }, 60_000);
    });

    describe('2 и 5в: цикл run — где нужен человек, код 2 и «ОСТАНОВКА» без повторов', () => {
        type Stub = { start: () => Promise<void>; step: () => Promise<never> };
        const loop = async (stub: Stub, maxFailures = 3) => {
            const lines: string[] = [];
            let steps = 0;
            let closed = 0;
            const code = await serve(
                {
                    start: stub.start,
                    step: async () => (steps++, stub.step()),
                    close: () => void closed++,
                },
                { pollSeconds: 0, maxFailures },
                (line) => lines.push(line),
            );
            return { code, lines, steps, closed };
        };
        const failing = (error: Error): Stub => ({ start: async () => {}, step: () => Promise.reject(error) });

        it.each([
            ['ProofRejected', new ProofRejected('пруф не прошёл сверку')],
            ['StateDirBusy', new StateDirBusy('блокировку взял другой экземпляр')],
            ['SequencerStop', new SequencerStop('батч не принят')],
            ['ProverFailure', new ProverFailure('прувер не построил пруф')],
        ])('%s в шаге — код 2, одна попытка', async (_name, error) => {
            const result = await loop(failing(error));
            expect(result).toEqual({ code: 2, lines: [`ОСТАНОВКА: ${error.message}`], steps: 1, closed: 1 });
        });

        it.each([
            ['SequencerStop', new SequencerStop('maxBlockAge контракта другой')],
            ['StateDirBusy', new StateDirBusy('каталог состояния занят')],
        ])('%s при старте — код 2 и «ОСТАНОВКА», шагов нет', async (_name, error) => {
            const result = await loop({ start: () => Promise.reject(error), step: () => Promise.reject(new Error('не должен')) });
            expect(result).toEqual({ code: 2, lines: [`ОСТАНОВКА: ${error.message}`], steps: 0, closed: 1 });
        });

        it('сбой сети повторяется до предела, затем остановка', async () => {
            const result = await loop(failing(new Error('toncenter не ответил')), 3);
            expect(result.code).toBe(2);
            expect(result.steps).toBe(3);
            expect(result.lines[result.lines.length - 1]).toBe('ОСТАНОВКА: 3 сбоев подряд — нужен человек');
        });
    });
});
