import { spawn } from 'child_process';
import { childrenLog, killAll, liveChildren, track } from '../sequencer/children';
import { ProofRejected } from '../sequencer/proofImport';
import { StaleSnapshot } from '../sequencer/submitter';
import { DEFAULT_STALE_LIMIT_SECONDS, serve } from '../sequencer/testnet';
import { ToncenterChain } from '../sequencer/ton';
import { Address } from '@ton/core';

// Правки круга 22 в процессах сервиса: обработчик exit дочернего не бросает (3), сигнал во время
// шага — «прервано», а не «ОСТАНОВКА» (4), отстающие снимки — отдельный предел по времени (4).
// Отправщик testnet (1, 2) — в tests/SequencerTestnet.spec.ts. Каждый тест падает без своей правки
// (мутации — в REVIEW.md, круг 22).

describe('круг 22: обработчик exit дочернего, сигнал во время шага, отстающие снимки', () => {
    describe('1: снимок toncenter несёт lt последней транзакции счёта', () => {
        afterEach(() => jest.restoreAllMocks());
        const address = Address.parseRaw('0:' + '11'.repeat(32));
        const info = (lastTransaction: { lt: string; hash: string } | null) =>
            ({ balance: 5n, extra_currencies: undefined, state: 'uninitialized', code: null, data: null, lastTransaction, blockId: { workchain: -1, shard: '0', seqno: 1 }, timestampt: 1000 }) as never;

        it('lt — из last_transaction_id; без транзакций — 0; не число — отказ', async () => {
            const chain = new ToncenterChain({ limit: async () => {} });
            const state = jest.spyOn(chain.client, 'getContractState');
            state.mockResolvedValueOnce(info({ lt: '48000000000003', hash: 'aGFzaA==' }));
            expect(await chain.account(address)).toMatchObject({ utime: 1000, lt: 48000000000003n, balance: 5n, state: 'uninit' });
            state.mockResolvedValueOnce(info(null));
            expect((await chain.account(address)).lt).toBe(0n);
            state.mockResolvedValueOnce(info({ lt: '-1', hash: '' }));
            await expect(chain.account(address)).rejects.toThrow(/lt последней транзакции счёта .* не числом: «-1»/);
        });
    });

    describe('3: сбой kill группы после выхода её главы — в журнал, не исключением', () => {
        const write = childrenLog.write;
        afterEach(() => {
            childrenLog.write = write;
            jest.restoreAllMocks();
        });

        it('EPERM на SIGKILL группе — строка журнала, процесс жив, дочерний снят с учёта', async () => {
            const lines: string[] = [];
            childrenLog.write = (line) => void lines.push(line);
            const kill = process.kill.bind(process);
            jest.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
                if (pid < 0) throw Object.assign(new Error(`kill EPERM`), { code: 'EPERM' });
                return kill(pid, signal);
            });
            const uncaught: unknown[] = [];
            const onUncaught = (error: unknown) => void uncaught.push(error);
            const listeners = process.listeners('uncaughtException');
            process.removeAllListeners('uncaughtException');
            process.on('uncaughtException', onUncaught);
            try {
                const child = track(spawn('sleep', ['0.1'], { detached: true, stdio: 'ignore' }), { group: true });
                await new Promise<void>((resolve) => child.once('exit', () => setImmediate(resolve)));
            } finally {
                process.removeListener('uncaughtException', onUncaught);
                for (const listener of listeners) process.on('uncaughtException', listener);
            }
            expect(uncaught).toEqual([]);
            expect(lines).toEqual([expect.stringMatching(/^дочерние процессы: SIGKILL оставшимся в группе \d+ \(pgrep -g \d+\) не удался \(EPERM\)/)]);
            expect(liveChildren()).toBe(0);
        }, 30_000);
    });

    describe('3: обработчик exit процесса (SIGKILL всем) не бросает', () => {
        const write = childrenLog.write;
        afterEach(() => {
            childrenLog.write = write;
            jest.restoreAllMocks();
        });

        it('EPERM у одной группы — строка журнала, остальные дочерние гасятся', async () => {
            const lines: string[] = [];
            childrenLog.write = (line) => void lines.push(line);
            const grouped = track(spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }), { group: true });
            const plain = track(spawn('sleep', ['30'], { stdio: 'ignore' }));
            const exited = [grouped, plain].map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())));
            const kill = process.kill.bind(process);
            const spy = jest.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
                if (pid === -grouped.pid!) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
                return kill(pid, signal);
            });
            expect(() => killAll()).not.toThrow();
            await exited[1];
            expect(plain.signalCode).toBe('SIGKILL');
            expect(lines).toEqual([expect.stringMatching(/^дочерние процессы: SIGKILL процессу \d+ \(sleep\) не удался \(EPERM\)/)]);
            spy.mockRestore();
            kill(grouped.pid!, 'SIGKILL');
            await exited[0];
            expect(liveChildren()).toBe(0);
        }, 30_000);
    });

    describe('4: цикл run', () => {
        type Stub = { start?: () => Promise<void>; step: (index: number) => Promise<{ kind: 'waiting' }> };
        const loop = async (stub: Stub, options: Partial<Parameters<typeof serve>[1]> = {}) => {
            const lines: string[] = [];
            let steps = 0;
            let closed = 0;
            const code = await serve(
                { start: stub.start ?? (async () => {}), step: async () => stub.step(++steps) as never, close: () => void closed++ },
                { pollSeconds: 0, maxFailures: 3, stopping: () => null, ...options },
                (line) => lines.push(line),
            );
            return { code, lines, steps, closed };
        };

        it('сигнал во время импорта пруфа (ProofRejected от погашенного скрипта) — код 1 «прервано», не «ОСТАНОВКА»', async () => {
            const error = new ProofRejected('import-sp1-fixture.mjs отказал: код null, сигнал SIGTERM');
            const result = await loop({ step: () => Promise.reject(error) }, { stopping: () => 'SIGTERM' });
            expect(result).toEqual({ code: 1, lines: [`прервано по сигналу SIGTERM: ${error.message}`], steps: 1, closed: 1 });
            // И при старте.
            const atStart = await loop({ start: () => Promise.reject(error), step: () => Promise.reject(new Error('не должен')) }, { stopping: () => 'SIGINT' });
            expect(atStart).toMatchObject({ code: 1, steps: 0, lines: [`прервано по сигналу SIGINT: ${error.message}`] });
            // Без сигнала тот же отказ — остановка, где нужен человек.
            expect(await loop({ step: () => Promise.reject(error) })).toMatchObject({ code: 2, lines: [`ОСТАНОВКА: ${error.message}`] });
        });

        it('StaleSnapshot — не сбой сети: свой предел по времени (по умолчанию 30 мин), а не maxFailures', async () => {
            expect(DEFAULT_STALE_LIMIT_SECONDS).toBe(1800);
            let clock = 0;
            const stale = new StaleSnapshot('снимок счёта старее виденного');
            // Шаг — минута; 25 отстающих подряд (25 мин < 30) не останавливают, хотя maxFailures — 3.
            const result = await loop(
                {
                    step: (index) => {
                        clock += 60_000;
                        return Promise.reject(index <= 25 ? stale : new ProofRejected('конец теста'));
                    },
                },
                { now: () => clock },
            );
            expect(result).toMatchObject({ code: 2, steps: 26 });
            expect(result.lines[result.lines.length - 1]).toBe('ОСТАНОВКА: конец теста');
            expect(result.lines.filter((line) => line.startsWith('снимки toncenter отстают'))).toHaveLength(25);

            // Предел — параметр: 10 мин → остановка на 11-м шаге (10 мин подряд).
            clock = 0;
            const limited = await loop({ step: () => ((clock += 60_000), Promise.reject(stale)) }, { now: () => clock, staleLimitSeconds: 600 });
            expect(limited).toMatchObject({ code: 2, steps: 11 });
            expect(limited.lines[limited.lines.length - 1]).toBe('ОСТАНОВКА: снимки toncenter отстают 600 с подряд (предел 600 с) — нужен человек');

            // Успешный шаг сбрасывает отсчёт.
            clock = 0;
            const reset = await loop(
                {
                    step: (index) => {
                        clock += 60_000;
                        if (index === 8) return Promise.resolve({ kind: 'waiting' as const });
                        return Promise.reject(index <= 16 ? stale : new ProofRejected('конец'));
                    },
                },
                { now: () => clock, staleLimitSeconds: 600 },
            );
            expect(reset).toMatchObject({ code: 2, steps: 17, lines: expect.arrayContaining(['ОСТАНОВКА: конец']) });
        });
    });
});
