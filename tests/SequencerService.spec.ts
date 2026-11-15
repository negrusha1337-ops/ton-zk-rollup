import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import '@ton/test-utils';
import { liveChildren } from '../sequencer/children';
import { MockProver, Prover, ProverJob } from '../sequencer/prover';
import { QueueLagError, QueueSource } from '../sequencer/queue/types';
import { GENESIS_HASH } from '../sequencer/protocol';
import { Interrupted, Sequencer, SequencerConfig, SequencerDeps, SequencerStop } from '../sequencer/service';
import { StateDirBusy } from '../sequencer/state';
import { BatchSubmitter, ContractBatchState } from '../sequencer/submitter';
import { FAKE_CHAIN_ID, fakeNode, FakeNode, fakeQueue, fakeTools } from './helpers/fakeSequencerNode';
import { blockOf, reportOf, rethExpected } from './helpers/rethChain';

// Ветки сервиса сборщика (sequencer/service.ts), которые на настоящем узле не воспроизвести: узел —
// в памяти (блок 1 цепочки Reth), хост и rsp — скрипты-заглушки. Отчёт о другом блоке (M3), отчёт
// чужой сборки и хост не той сборки (M2), сбой инструмента против отказа программы (M6), срок
// приёма и часы (M5), устаревший возобновлённый кандидат и узел, потерявший кандидата (M1), второй
// экземпляр на том же каталоге (M4). Сквозной прогон с узлом — tests/SequencerReth.spec.ts.

const BLOCK = blockOf(1);
const MAX_BLOCK_AGE = 3600;

describe('сервис сборщика на заглушках узла и хоста', () => {
    let dir: string;
    let node: FakeNode;
    let tools: ReturnType<typeof fakeTools>;
    let clock: { machine: number; l1: number };
    let lines: string[];
    let open: Sequencer[];
    /** Двойник контракта для сервиса: что принято, и сколько раз слали. */
    let contract: ContractBatchState;
    let submits: number;
    const accepted: BatchSubmitter = {
        submit: async (batch) => {
            submits++;
            contract = { batchIndex: batch.number, stateRoot: BigInt(batch.blockHash) };
            return { accepted: true, alreadyAccepted: false };
        },
        contractState: async () => contract,
    };

    const config = (overrides: Partial<SequencerConfig> = {}): SequencerConfig => ({
        chainId: FAKE_CHAIN_ID,
        feeRecipient: '0x' + '5e'.repeat(20),
        stateDir: path.join(dir, 'state'),
        rpcUrl: 'http://127.0.0.1:1',
        genesisPath: path.join(dir, 'genesis.json'),
        includePool: false,
        tools: tools.tools,
        maxBatchQueueItems: 32,
        maxBlockAge: MAX_BLOCK_AGE,
        now: () => clock.machine,
        ...overrides,
    });
    const sequencer = (overrides: Partial<SequencerConfig> = {}, deps: Partial<SequencerDeps> = {}) => {
        open.forEach((instance) => instance.close());
        const instance = new Sequencer(config(overrides), {
            node: node.rpc,
            queue: fakeQueue(),
            prover: new MockProver(),
            submitter: accepted,
            l1Now: async () => clock.l1,
            log: (line) => lines.push(line),
            ...deps,
        });
        open = [instance];
        return instance;
    };

    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'sequencer-service-'));
        node = fakeNode();
        tools = fakeTools(path.join(dir, 'tools'));
        clock = { machine: BLOCK.timestamp, l1: BLOCK.timestamp };
        lines = [];
        open = [];
        contract = { batchIndex: 0, stateRoot: BigInt(GENESIS_HASH) };
        submits = 0;
    });
    afterEach(() => {
        open.forEach((instance) => instance.close());
        rmSync(dir, { recursive: true, force: true });
    });

    it('честный блок 1: проверен, батч принят; finalized сдвигается только после приёма; процессов не осталось', async () => {
        const service = sequencer();
        await service.start();
        expect(await service.step()).toMatchObject({ kind: 'checked', number: 1, hash: BLOCK.hash });
        expect(node.tags).toEqual({ head: BLOCK.hash, safe: BLOCK.hash, finalized: rethExpected.genesisHash });
        expect(await service.step()).toEqual({ kind: 'accepted', number: 1, hash: BLOCK.hash, alreadyAccepted: false });
        expect(node.tags.finalized).toBe(BLOCK.hash);
        expect(liveChildren()).toBe(0);
    });

    it('M3: хост отдал отчёт о другом блоке — остановка с точным текстом, вершина и safe прежние', async () => {
        tools.behave({ report: reportOf(2) });
        const service = sequencer();
        await service.start();
        const stop = service.step();
        await expect(stop).rejects.toThrow(SequencerStop);
        await expect(stop).rejects.toThrow(
            `newStateRoot программы ${blockOf(2).hash} — не хеш кандидата ${BLOCK.hash}: отчёт о другом блоке`,
        );
        await expect(stop).rejects.toThrow(
            `prevStateRoot программы ${BLOCK.hash} — не хеш проверенной вершины ${rethExpected.genesisHash}`,
        );
        expect(service.snapshot.tip.number).toBe(0);
        expect(node.tags.safe).toBe(rethExpected.genesisHash);
        expect(existsSync(path.join(config().stateDir, 'blocks', '1'))).toBe(false);
    });

    it('M2: хост не той сборки — отказ при старте; отчёт чужого ELF — остановка, кандидат остаётся в работе', async () => {
        tools.behave({ identity: { ...tools.honestIdentity, programElfSha256: '0x' + '00'.repeat(32) } });
        await expect(sequencer().start()).rejects.toThrow(
            /^хост программы не тот, под который выведен ключ контракта: ELF программы в хосте 0{64}, в program\.json [0-9a-f]{64}; пересоберите хост$/,
        );
        tools.behave({ report: { ...reportOf(1), programElfSha256: '0x' + '00'.repeat(32) } });
        const service = sequencer();
        await service.start();
        await expect(service.step()).rejects.toThrow(/^хост устарел: отчёт хоста — от ELF 0{64}, а в program\.json [0-9a-f]{64}; пересоберите хост/);
        expect(service.snapshot.pending).toMatchObject({ number: 1, phase: 'tentative' });
        expect(service.snapshot.rejections).toEqual([]);
    });

    it('M6: сбой инструмента — повтор, а не отвергнутый кандидат; повторы кончились — остановка с фазой', async () => {
        tools.behave({ failTimes: 1 });
        const service = sequencer();
        await service.start();
        expect(await service.step()).toMatchObject({ kind: 'checked', number: 1 });
        expect(lines.some((line) => line.includes('блок 1: программа (хост): сбой инструмента (хост не довёл расчёт до конца'))).toBe(true);
        expect(service.snapshot.rejections).toEqual([]);

        rmSync(config().stateDir, { recursive: true, force: true });
        node = fakeNode();
        tools.behave({ failTimes: 5, failExitCode: 3 });
        const failing = sequencer({ toolRetries: 2 });
        await failing.start();
        await expect(failing.step()).rejects.toThrow('блок 1: программа (хост): сбой инструмента после 3 попыток — хост не довёл расчёт до конца');
        expect(failing.snapshot.rejections).toEqual([]);
        expect(failing.snapshot.pending).toMatchObject({ phase: 'tentative' });
    });

    it('M6, T7: отказ программы (паника на process_evm_batch) — отвергнутый кандидат; отвергнут и второй — остановка', async () => {
        tools.behave({
            exitCode: 101,
            stderr: "thread 'main' panicked at host/src/main.rs:609:43:\nнативный расчёт отверг батч: DepositMismatch(0)\n",
        });
        const service = sequencer();
        await service.start();
        await expect(service.step()).rejects.toThrow(
            /^блок 1: программа отвергла и исправленного кандидата \(без транзакций пула\)$/,
        );
        expect(service.snapshot.rejections.map((rejection) => [rejection.attempt, rejection.reason])).toEqual([
            [1, 'нативный расчёт отверг батч: DepositMismatch(0)'],
            [2, 'нативный расчёт отверг батч: DepositMismatch(0)'],
        ]);
    });

    it('M5: часы машины против L1 при старте; время пруфа и запас — меньше maxBlockAge; на границе срока пруф строится', async () => {
        clock.l1 = clock.machine - 61;
        await expect(sequencer().start()).rejects.toThrow(
            'часы машины расходятся со временем L1 на 61 с (предел 60): время блоков и срок приёма считались бы неверно',
        );
        clock.l1 = clock.machine;
        // По умолчанию 1800 + 300: с наименьшим maxBlockAge контракта (1800) сервис не стартует.
        await expect(sequencer({ maxBlockAge: 1800 }).start()).rejects.toThrow(
            'время пруфа 1800 с + запас 300 с не меньше maxBlockAge 1800 с: каждый блок пересобирался бы до пруфа; ' +
                'уменьшите expectedProofTime либо разверните контракт с большим maxBlockAge',
        );
        await expect(sequencer({ expectedProofTime: 3300 }).start()).rejects.toThrow(/^время пруфа 3300 с \+ запас 300 с/);
        const service = sequencer({ expectedProofTime: 600 });
        await service.start();
        await service.step();
        // Ровно на границе (срок = L1 + пруф + запас) — пруф и отправка, без пересборки.
        clock.l1 = BLOCK.timestamp + MAX_BLOCK_AGE - 900;
        expect(await service.step()).toEqual({ kind: 'accepted', number: 1, hash: BLOCK.hash, alreadyAccepted: false });
        expect(submits).toBe(1);
    });

    it('19-1: контракт принял батч, а сервис упал до записи — после перезапуска позже срока батч признан принятым, не пересобран', async () => {
        const first = sequencer({}, { faults: { stopAfter: 'submitted' } });
        await first.start();
        expect(await first.step()).toMatchObject({ kind: 'checked', number: 1 });
        await expect(first.step()).rejects.toThrow(new Interrupted('submitted').message);
        expect(first.snapshot.blocks[0]).toMatchObject({ status: 'proven', submitting: true });
        expect(contract.batchIndex).toBe(1);
        // Перезапуск позже конца срока: принятому батчу срок не нужен.
        clock.l1 = clock.machine = BLOCK.timestamp + MAX_BLOCK_AGE + 1;
        const second = sequencer();
        await second.start();
        expect(await second.step()).toEqual({ kind: 'accepted', number: 1, hash: BLOCK.hash, alreadyAccepted: true });
        expect(node.tags.finalized).toBe(BLOCK.hash);
        expect(submits).toBe(1);
        expect(second.snapshot.blocks[0]).toEqual({ number: 1, hash: BLOCK.hash, status: 'accepted', dir: first.snapshot.blocks[0].dir });
        expect(node.calls.filter((method) => method === 'testing_buildBlockV1')).toHaveLength(1);
        // Принят с другим блоком — остановка, а не пересборка.
        rmSync(config().stateDir, { recursive: true, force: true });
        node = fakeNode();
        clock.l1 = clock.machine = BLOCK.timestamp;
        const other = sequencer();
        await other.start();
        await other.step();
        contract = { batchIndex: 1, stateRoot: 7n };
        await expect(other.step()).rejects.toThrow(
            `контракт принял батч 1 с другим блоком 0x${'0'.repeat(63)}7, а у сервиса ${BLOCK.hash}`,
        );
    });

    it('19-2: батч не успеть до пруфа — пересборка: тот же отрезок, свежее время, задание пруверу отменено, safe назад на родителя', async () => {
        // Очередь растёт после блока: новый отрезок был бы длиннее — пересборка берёт прежний.
        const honest = fakeQueue();
        let grown = false;
        const queue: QueueSource = {
            read: async (from, cursor, max) => {
                const window = await honest.read(from, cursor, max);
                if (!grown || window.items.length === 0) return window;
                const [first] = window.items;
                const extra = { ...first, item: { ...first.item, number: 2 }, message: { ...first.message, number: 2 } };
                return { ...window, head: { count: 2, hash: 1n }, items: [first, extra].slice(0, max) };
            },
        };
        const first = sequencer({ expectedProofTime: 600 }, { queue });
        await first.start();
        await first.step();
        const before = first.snapshot.blocks[0];
        expect(node.tags.safe).toBe(BLOCK.hash);
        let proofs = 0;
        const cancelled: ProverJob[] = [];
        const prover: Prover = {
            prove: async (job) => (proofs++, new MockProver().prove(job)),
            cancel: async (job) => void cancelled.push(job),
        };
        // На секунду позже границы: срок < L1 + время пруфа 600 + запас 300.
        clock.l1 = clock.machine = BLOCK.timestamp + MAX_BLOCK_AGE - 899;
        grown = true;
        const second = sequencer({ expectedProofTime: 600 }, { prover, queue, faults: { stopAfter: 'built' } });
        await second.start();
        await expect(second.step()).rejects.toThrow(new Interrupted('built').message);
        expect(proofs).toBe(0);
        expect(cancelled.map((job) => [job.number, job.blockHash])).toEqual([[1, BLOCK.hash]]);
        const state = second.snapshot;
        expect(state.blocks).toEqual([]);
        expect(state.tip.number).toBe(0);
        expect(state.rebuild).toMatchObject({ number: 1, replaces: BLOCK.hash, segment: before.segment });
        expect(state.pending!.segment).toEqual(before.segment);
        expect(state.pending!.segment).toHaveLength(1);
        expect(Number(BigInt(state.pending!.payload.timestamp))).toBe(clock.machine);
        expect(existsSync(before.dir)).toBe(false);
        expect(existsSync(path.join(`${before.dir}.stale-${BLOCK.hash.slice(2, 10)}`, 'job.json'))).toBe(true);
        expect(node.tags.safe).toBe(rethExpected.genesisHash);
        expect(lines).toContain(
            `блок 1 (${BLOCK.hash}) пересобирается: батч не успеть принять до пруфа: время блока ${BLOCK.timestamp} + maxBlockAge ${MAX_BLOCK_AGE} = ` +
                `${BLOCK.timestamp + MAX_BLOCK_AGE}, а время L1 ${clock.l1} + время пруфа 600 + запас 300 = ${clock.l1 + 900}`,
        );
    });

    it('19-2: пересборка сверяет прежний отрезок с контрактом — обработанное и элементы', async () => {
        const honest = fakeQueue();
        let change: 'none' | 'processed' | 'items' = 'none';
        const queue: QueueSource = {
            read: async (...args) => {
                const window = await honest.read(...args);
                if (change === 'processed') return { ...window, processed: window.head };
                if (change === 'items')
                    return {
                        ...window,
                        items: window.items.map((entry) => ({ ...entry, item: { ...entry.item, amount: 1n } as typeof entry.item })),
                    };
                return window;
            },
        };
        const first = sequencer({ expectedProofTime: 600 }, { queue });
        await first.start();
        await first.step();
        clock.l1 = clock.machine = BLOCK.timestamp + MAX_BLOCK_AGE;
        change = 'processed';
        await expect(first.step()).rejects.toThrow('блок 1: пересборка — контракт обработал очередь до 1, а родитель блока — до 0');
        change = 'items';
        await expect(first.step()).rejects.toThrow('блок 1: пересборка — элементы очереди у контракта не те, что в прежнем отрезке');
    });

    it('19-2: батч мог уйти — в запасе ждать, пересборка только после конца срока; свежий пруф в запасе — пересборка сразу', async () => {
        let failing = true;
        const flaky: BatchSubmitter = {
            submit: async (batch) => {
                if (failing) throw new Error('сеть не ответила');
                return accepted.submit(batch);
            },
            contractState: async () => contract,
        };
        const first = sequencer({}, { submitter: flaky });
        await first.start();
        await first.step();
        await expect(first.step()).rejects.toThrow('сеть не ответила');
        expect(first.snapshot.blocks[0]).toMatchObject({ status: 'proven', submitting: true });
        // В запасе (срок ещё не истёк): не слать, не пересобирать — ждать.
        clock.l1 = clock.machine = BLOCK.timestamp + MAX_BLOCK_AGE - 100;
        failing = false;
        const waiting = sequencer({}, { submitter: flaky });
        await waiting.start();
        expect(await waiting.step()).toMatchObject({ kind: 'waiting', number: 1 });
        expect(submits).toBe(0);
        expect(waiting.snapshot.blocks[0].status).toBe('proven');
        // Срок истёк, контракт не принял — пересборка.
        clock.l1 = clock.machine = BLOCK.timestamp + MAX_BLOCK_AGE + 1;
        const expired = sequencer({}, { submitter: flaky, faults: { stopAfter: 'built' } });
        await expired.start();
        await expect(expired.step()).rejects.toThrow(Interrupted);
        expect(expired.snapshot.rebuild).toMatchObject({ number: 1, replaces: BLOCK.hash });
        expect(lines.some((line) => line.startsWith(`блок 1 (${BLOCK.hash}) пересобирается: батч не успеть принять до отправки:`))).toBe(true);

        // Пруф построен в этом шаге и попал в запас: батч не уходил — пересборка сразу.
        rmSync(config().stateDir, { recursive: true, force: true });
        node = fakeNode();
        clock.l1 = clock.machine = BLOCK.timestamp;
        const slow: Prover = {
            prove: async (job) => {
                clock.l1 = BLOCK.timestamp + MAX_BLOCK_AGE - 100;
                return new MockProver().prove(job);
            },
        };
        const checker = sequencer();
        await checker.start();
        await checker.step();
        const fresh = sequencer({}, { prover: slow, faults: { stopAfter: 'built' } });
        await fresh.start();
        await expect(fresh.step()).rejects.toThrow(Interrupted);
        expect(fresh.snapshot.rebuild).toMatchObject({ number: 1, replaces: BLOCK.hash });
        expect(submits).toBe(0);
    });

    it('19-2: блок из будущего L1 (7329) — ждать, а не останавливаться; L1 догнал — батч принят', async () => {
        clock.l1 = BLOCK.timestamp - 10;
        const service = sequencer();
        await service.start();
        expect(await service.step()).toMatchObject({ kind: 'checked', number: 1 });
        expect(await service.step()).toEqual({
            kind: 'waiting',
            number: 1,
            reason: `время блока ${BLOCK.timestamp} позже времени L1 ${BLOCK.timestamp - 10}: ждём L1`,
        });
        expect(submits).toBe(0);
        clock.l1 = BLOCK.timestamp;
        expect(await service.step()).toMatchObject({ kind: 'accepted', number: 1, alreadyAccepted: false });
    });

    it('19-6: источник сообщений очереди отстаёт — повтор, после queueLagLimit (и через перезапуск) — остановка; догнал — счёт сброшен', async () => {
        const honest = fakeQueue();
        let lagging = true;
        const queue: QueueSource = {
            read: async (...args) => {
                if (lagging) throw new QueueLagError('сообщений найдено 0 из 1');
                return honest.read(...args);
            },
        };
        const first = sequencer({ queueLagLimit: 100 }, { queue });
        await first.start();
        await expect(first.step()).rejects.toThrow(QueueLagError);
        expect(first.snapshot.queueLagSince).toBe(BLOCK.timestamp);
        clock.l1 = clock.machine = BLOCK.timestamp + 60;
        await expect(first.step()).rejects.toThrow(QueueLagError);
        // Перезапуск счёт не сбрасывает.
        clock.l1 = clock.machine = BLOCK.timestamp + 101;
        const second = sequencer({ queueLagLimit: 100 }, { queue });
        await second.start();
        const stop = second.step();
        await expect(stop).rejects.toThrow(SequencerStop);
        await expect(stop).rejects.toThrow(
            'источник сообщений очереди L1 отстаёт 101 с (предел 100): сообщений найдено 0 из 1; индексатор стоит или потерял сообщение — нужен человек',
        );
        lagging = false;
        // Время блока — как у блока 1 фикстуры (заглушка хоста отдаёт его отчёт).
        clock.l1 = clock.machine = BLOCK.timestamp;
        expect(await second.step()).toMatchObject({ kind: 'checked', number: 1 });
        expect(second.snapshot.queueLagSince).toBeUndefined();
    });

    it('19-7: отвергнут кандидат, а собирать больше нечего — голова узла на непроверенном; узел её не возвращает, шаг это называет', async () => {
        tools.behave({
            exitCode: 101,
            stderr: "thread 'main' panicked at host/src/main.rs:609:43:\nнативный расчёт отверг батч: DepositMismatch(0)\n",
        });
        const empty: QueueSource = {
            read: async (from) => ({ head: from, processed: { count: 0, hash: 0n }, from, items: [] }),
        };
        const service = sequencer({ includePool: true }, { queue: empty });
        await service.start();
        expect(await service.step()).toEqual({ kind: 'idle', unverifiedHead: BLOCK.hash });
        expect(service.snapshot.rejections).toHaveLength(1);
        expect(node.tags).toEqual({ head: BLOCK.hash, safe: rethExpected.genesisHash, finalized: rethExpected.genesisHash });
        // Попытка вернуть голову на вершину была (узел ответил VALID, ничего не сменив).
        expect(node.calls.slice(-3)).toEqual(['eth_getBlockByNumber', 'engine_forkchoiceUpdatedV3', 'eth_getBlockByNumber']);
        expect(lines).toContain(
            `голова узла — непроверенный блок 1 (${BLOCK.hash}): к вершине 0 узел её не возвращает; вытеснит следующий кандидат той же высоты; наружу — только safe`,
        );
    });

    it('19-4: отчёт и вход батча в каталоге блока пишутся атомарно (временный файл, fsync, переименование)', async () => {
        const renames = jest.spyOn(fs, 'renameSync');
        const copies = jest.spyOn(fs, 'copyFileSync');
        try {
            const service = sequencer();
            await service.start();
            await service.step();
            const blockDir = path.join(config().stateDir, 'blocks', '1');
            const renamed = renames.mock.calls.map(([from, to]) => [String(from), String(to)]);
            for (const name of ['report.json', 'batch.bin'])
                expect(renamed).toContainEqual([path.join(blockDir, `${name}.tmp`), path.join(blockDir, name)]);
            expect(copies).not.toHaveBeenCalled();
            expect(JSON.parse(readFileSync(path.join(blockDir, 'report.json'), 'utf8'))).toEqual(reportOf(1));
        } finally {
            renames.mockRestore();
            copies.mockRestore();
        }
    });

    it('M1: устаревший возобновлённый кандидат собирается заново; узел, потерявший кандидата, получает его снова', async () => {
        const first = sequencer({}, { faults: { stopAfter: 'inserted' } });
        await first.start();
        await expect(first.step()).rejects.toThrow(Interrupted);
        const stale = first.snapshot.pending!;
        // Узел перезапущен: кандидат (не канонический) потерян; сервис отдаёт его заново из сохранённого ответа.
        node.restart();
        const resumed = sequencer();
        await resumed.start();
        expect(await resumed.step()).toMatchObject({ kind: 'checked', hash: BLOCK.hash });
        expect(lines).toContain(`блок 1: узел не знает кандидата ${BLOCK.hash} (SYNCING) — newPayload из сохранённого ответа`);
        expect(node.calls.filter((method) => method === 'testing_buildBlockV1')).toHaveLength(1);

        // Тот же кандидат, но старше maxBlockAge / 4: не продолжается, а собирается заново.
        rmSync(config().stateDir, { recursive: true, force: true });
        node = fakeNode();
        const again = sequencer({}, { faults: { stopAfter: 'inserted' } });
        await again.start();
        await expect(again.step()).rejects.toThrow(Interrupted);
        clock.machine = BLOCK.timestamp + MAX_BLOCK_AGE / 4 + 1;
        clock.l1 = clock.machine;
        const rebuilt = sequencer({}, { faults: { stopAfter: 'built' } });
        await rebuilt.start();
        await expect(rebuilt.step()).rejects.toThrow(Interrupted);
        expect(lines).toContain(
            `блок 1: кандидат ${BLOCK.hash} (фаза inserted) старше ${MAX_BLOCK_AGE / 4} с — собирается заново`,
        );
        const fresh = rebuilt.snapshot.pending!;
        expect(fresh.dir).not.toBe(stale.dir);
        expect(Number(BigInt(fresh.payload.timestamp))).toBe(clock.machine);
        expect(node.calls.filter((method) => method === 'testing_buildBlockV1')).toHaveLength(2);
    });

    it('T4, T2: ответ узла не тот, что запрошен, и данные блока не те — остановка с точным текстом', async () => {
        node.override.testing_buildBlockV1 = ([request]: unknown[]) => {
            // Один раз: ответ честной заглушки, но время на секунду позже запрошенного.
            node.override.testing_buildBlockV1 = undefined;
            const honest = (fakeNode().rpc.eth as unknown as (m: string, p: unknown[]) => Promise<never>)(
                'testing_buildBlockV1',
                [request],
            );
            return honest.then((envelope: { executionPayload: { timestamp: string } }) => ({
                executionPayload: {
                    ...envelope.executionPayload,
                    timestamp: '0x' + (BigInt(envelope.executionPayload.timestamp) + 1n).toString(16),
                },
            }));
        };
        const service = sequencer();
        await service.start();
        await expect(service.step()).rejects.toThrow(`блок 1: узел собрал не то — время ${BLOCK.timestamp + 1}, а запрошено ${BLOCK.timestamp}`);
        expect(service.snapshot.pending).toBeNull();
        node.override.debug_getRawBlock = () => '0x00';
        await expect(service.step()).rejects.toThrow(
            /^блок 1: расчёт сервиса не сошёлся с программой — данные батча — не RLP блока со слов узла$/,
        );
        expect(service.snapshot.tip.number).toBe(0);
    });

    it('M7, T6: пул — в пределах бюджета газа (по умолчанию 5 млн); без флага пул не читается', async () => {
        const off = sequencer({}, { faults: { stopAfter: 'built' } });
        await off.start();
        await expect(off.step()).rejects.toThrow(Interrupted);
        expect(node.calls).not.toContain('txpool_content');
        expect(off.snapshot.pending!.request.transactions).toEqual([]);

        rmSync(config().stateDir, { recursive: true, force: true });
        node = fakeNode();
        const on = sequencer({ includePool: true }, { faults: { stopAfter: 'built' } });
        await on.start();
        await expect(on.step()).rejects.toThrow(Interrupted);
        // Три по 2 млн газа: в бюджет 5 млн входят две.
        expect(on.snapshot.pending!.request.transactions).toEqual(['0x0200000000', '0x0211111111']);
        rmSync(config().stateDir, { recursive: true, force: true });
        node = fakeNode();
        const wide = sequencer({ includePool: true, poolGasBudget: 6_000_000n }, { faults: { stopAfter: 'built' } });
        await wide.start();
        await expect(wide.step()).rejects.toThrow(Interrupted);
        expect(wide.snapshot.pending!.request.transactions).toHaveLength(3);
    });

    it('M4: второй экземпляр на том же каталоге состояния — отказ с понятным текстом', async () => {
        const first = new Sequencer(config(), {
            node: node.rpc,
            queue: fakeQueue(),
            prover: new MockProver(),
            submitter: accepted,
            l1Now: async () => clock.l1,
        });
        await first.start();
        const second = new Sequencer(config(), {
            node: node.rpc,
            queue: fakeQueue(),
            prover: new MockProver(),
            submitter: accepted,
            l1Now: async () => clock.l1,
        });
        await expect(second.start()).rejects.toThrow(StateDirBusy);
        await expect(second.start()).rejects.toThrow(`каталог состояния ${config().stateDir} занят другим экземпляром сервиса`);
        await expect(second.step()).rejects.toThrow('сервис не запущен (start) либо закрыт (close)');
        first.close();
        await second.start();
        second.close();
    });
});
