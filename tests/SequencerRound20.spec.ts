import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import '@ton/test-utils';
import { randomBytes } from 'crypto';
import { ExecutionPayload } from '../sequencer/block/payload';
import { beforeProof, beforeSubmit } from '../sequencer/deadline';
import { GENESIS_HASH } from '../sequencer/protocol';
import { jobKeyOf, MockProver, Prover } from '../sequencer/prover';
import { QueuedItem, QueueSource } from '../sequencer/queue/types';
import { staleDirOf } from '../sequencer/rebuild';
import { Interrupted, Phase, Sequencer, SequencerConfig, SequencerDeps, SequencerStop } from '../sequencer/service';
import { deserialize, SequencerState, serialize, StateDirBusy } from '../sequencer/state';
import { BatchSubmitter, ContractBatchState } from '../sequencer/submitter';
import { FAKE_CHAIN_ID, fakeNode, FakeNode, fakeQueue, fakeTools } from './helpers/fakeSequencerNode';
import { blockOf, reportOf, rethExpected } from './helpers/rethChain';

// Правки круга 20 в сервисе сборщика (sequencer/service.ts, deadline.ts, rebuild.ts, lock.ts) на
// заглушках узла и хоста: время снимка контракта против времени L1 (1), maxBlockAge у контракта
// (2), запас перед пересборкой (3), сбой внутри пересборки (4), контракт дальше сервиса (5), ключ
// задания пруфа (6), блокировка перед записью и отправкой (9), пересборка: обрезка, принудительные,
// пустой блок после перезапуска (10). Каждый тест падает без своей правки (мутации — в отчёте шага).

const BLOCK = blockOf(1);
const MAX_BLOCK_AGE = 3600;
const DEADLINE = BLOCK.timestamp + MAX_BLOCK_AGE;
/** Отчёт заглушки хоста о блоке 1 со временем пересобранного блока (последнее из 11 слов). */
const reportAt = (time: number) => {
    const report = reportOf(1);
    const bytes = Buffer.from(report.publicValuesBytes.replace(/^0x/, ''), 'hex');
    Buffer.from(BigInt(time).toString(16).padStart(64, '0'), 'hex').copy(bytes, 10 * 32);
    return { ...report, publicValues: { ...report.publicValues, blockTimestamp: String(time) }, publicValuesBytes: '0x' + bytes.toString('hex') };
};
const WORK = path.join(__dirname, '..', '.tools', 'sequencer-test', 'round20');

describe('сервис сборщика: правки круга 20', () => {
    let dir: string;
    let node: FakeNode;
    let tools: ReturnType<typeof fakeTools>;
    let clock: { machine: number; l1: number; snapshot: number | null };
    let lines: string[];
    let open: Sequencer[];
    let contract: Omit<ContractBatchState, 'utime'>;
    let submits: number;
    let failing: boolean;
    let deployment: { chainId: bigint; maxBlockAge: number };
    const submitter: BatchSubmitter = {
        submit: async (batch) => {
            if (failing) throw new Error('сеть не ответила');
            submits++;
            contract = { batchIndex: batch.number, stateRoot: BigInt(batch.blockHash) };
            return { accepted: true, alreadyAccepted: false };
        },
        // Снимок контракта — на своё время (по умолчанию — время L1 теста).
        contractState: async () => ({ ...contract, utime: clock.snapshot ?? clock.l1 }),
        deployment: async () => deployment,
    };
    const stateDir = () => path.join(dir, 'state');
    const config = (overrides: Partial<SequencerConfig> = {}): SequencerConfig => ({
        chainId: FAKE_CHAIN_ID,
        feeRecipient: '0x' + '5e'.repeat(20),
        stateDir: stateDir(),
        rpcUrl: 'http://127.0.0.1:1',
        genesisPath: path.join(dir, 'genesis.json'),
        includePool: false,
        tools: tools.tools,
        maxBatchQueueItems: 32,
        maxBlockAge: MAX_BLOCK_AGE,
        expectedProofTime: 600,
        now: () => clock.machine,
        ...overrides,
    });
    const sequencer = (overrides: Partial<SequencerConfig> = {}, deps: Partial<SequencerDeps> = {}) => {
        open.forEach((instance) => instance.close());
        const instance = new Sequencer(config(overrides), {
            node: node.rpc,
            queue: fakeQueue(),
            prover: new MockProver(),
            submitter,
            l1Now: async () => clock.l1,
            log: (line) => lines.push(line),
            ...deps,
        });
        open = [instance];
        return instance;
    };
    const editState = (change: (state: SequencerState) => void) => {
        const file = path.join(stateDir(), 'state.json');
        const state = deserialize<SequencerState>(readFileSync(file, 'utf8'));
        change(state);
        writeFileSync(file, serialize(state));
    };
    const at = (time: number) => (clock.l1 = clock.machine = time);
    /** Блок 1 проверен, первая отправка упала: батч мог уйти (submitting), пруф есть. */
    const mayHaveBeenSent = async () => {
        const first = sequencer();
        await first.start();
        await first.step();
        failing = true;
        await expect(first.step()).rejects.toThrow('сеть не ответила');
        failing = false;
        expect(first.snapshot.blocks[0]).toMatchObject({ status: 'proven', submitting: true });
    };

    beforeEach(() => {
        dir = path.join(WORK, randomBytes(4).toString('hex'));
        mkdirSync(dir, { recursive: true });
        node = fakeNode();
        tools = fakeTools(path.join(dir, 'tools'));
        clock = { machine: BLOCK.timestamp, l1: BLOCK.timestamp, snapshot: null };
        lines = [];
        open = [];
        contract = { batchIndex: 0, stateRoot: BigInt(GENESIS_HASH) };
        submits = 0;
        failing = false;
        deployment = { chainId: FAKE_CHAIN_ID, maxBlockAge: MAX_BLOCK_AGE };
    });
    afterEach(() => {
        open.forEach((instance) => instance.close());
        rmSync(dir, { recursive: true, force: true });
    });

    it('А1: снимок контракта отстаёт от времени L1 — waiting, не пересборка; снимок догнал — пересборка', async () => {
        await mayHaveBeenSent();
        // Свежий сервер: L1 далеко за сроком. Отстающий: «не принят» — на время до срока.
        at(DEADLINE + 500);
        clock.snapshot = DEADLINE - 10;
        const service = sequencer();
        await service.start();
        const result = await service.step();
        expect(result).toMatchObject({ kind: 'waiting', number: 1 });
        expect(service.snapshot.rebuild ?? null).toBeNull();
        expect(service.snapshot.blocks).toHaveLength(1);
        expect(submits).toBe(0);
        // Снимок позже срока + запаса, батча в нём нет — пересборка.
        clock.snapshot = DEADLINE + 61;
        const later = sequencer({}, { faults: { stopAfter: 'built' } });
        await later.start();
        await expect(later.step()).rejects.toThrow(Interrupted);
        expect(later.snapshot.rebuild).toMatchObject({ number: 1, replaces: BLOCK.hash });
    });

    it('А2: maxBlockAge и chainId — у контракта; расхождение с конфигурацией — отказ при старте', async () => {
        deployment = { chainId: FAKE_CHAIN_ID, maxBlockAge: 7200 };
        await expect(sequencer().start()).rejects.toThrow(
            'maxBlockAge контракта 7200 с, а в конфигурации сервиса 3600 с: срок приёма считался бы неверно; ' +
                'возьмите значение у контракта (get-метод deployment)',
        );
        deployment = { chainId: FAKE_CHAIN_ID + 1n, maxBlockAge: MAX_BLOCK_AGE };
        await expect(sequencer().start()).rejects.toThrow(`chainId контракта ${FAKE_CHAIN_ID + 1n}, а сервис запущен для ${FAKE_CHAIN_ID}`);
    });

    it('А3: батч мог уйти — на сроке и на сроке + запас ждать; за запасом — пересборка', async () => {
        await mayHaveBeenSent();
        for (const time of [DEADLINE, DEADLINE + 60]) {
            at(time);
            const service = sequencer();
            await service.start();
            expect(await service.step()).toMatchObject({ kind: 'waiting', number: 1 });
            expect(service.snapshot.blocks).toHaveLength(1);
        }
        at(DEADLINE + 61);
        const service = sequencer({ rebuildMargin: 60 }, { faults: { stopAfter: 'built' } });
        await service.start();
        await expect(service.step()).rejects.toThrow(Interrupted);
        expect(service.snapshot.rebuild).toMatchObject({ number: 1 });
        // Чистая функция на тех же границах; батч, который никуда не уходил, — пересборка заранее.
        const base = { timestamp: BLOCK.timestamp, maxBlockAge: MAX_BLOCK_AGE, submitMargin: 300, rebuildMargin: 60 };
        expect(beforeSubmit({ ...base, seen: DEADLINE, fresh: DEADLINE, submitting: true }).action).toBe('wait');
        expect(beforeSubmit({ ...base, seen: DEADLINE + 60, fresh: DEADLINE + 60, submitting: true }).action).toBe('wait');
        expect(beforeSubmit({ ...base, seen: DEADLINE + 61, fresh: DEADLINE + 61, submitting: true }).action).toBe('rebuild');
        expect(beforeSubmit({ ...base, seen: DEADLINE, fresh: DEADLINE, submitting: false }).action).toBe('rebuild');
        expect(beforeProof({ ...base, seen: DEADLINE - 900, fresh: DEADLINE - 900, proofTime: 600 }).action).toBe('go');
        expect(beforeProof({ ...base, seen: DEADLINE - 900, fresh: DEADLINE - 899, proofTime: 600 }).action).toBe('rebuild');
    });

    it.each(['rebuild-cancelled', 'rebuild-saved', 'rebuild-renamed', 'rebuild-safe'] as Phase[])(
        'А4: сбой внутри пересборки после %s — старт доводит её: каталог прежнего блока в сторону, safe назад, блок собран заново',
        async (point) => {
            const first = sequencer();
            await first.start();
            await first.step();
            const blockDir = first.snapshot.blocks[0].dir;
            const stale = staleDirOf(blockDir, BLOCK.hash);
            at(DEADLINE); // до пруфа не успеть: пересборка
            tools.behave({ report: reportAt(DEADLINE) });
            const broken = sequencer({}, { faults: { stopAfter: point } });
            await broken.start();
            await expect(broken.step()).rejects.toThrow(new Interrupted(point).message);
            const resumed = sequencer();
            await resumed.start();
            if (point !== 'rebuild-cancelled') {
                // Старт: прежнего каталога на месте нового нет, safe узла — на вершине (родителе).
                expect(existsSync(blockDir)).toBe(false);
                expect(node.tags.safe).toBe(rethExpected.genesisHash);
            }
            expect(await resumed.step()).toMatchObject({ kind: 'checked', number: 1 });
            const payload = (file: string) => deserialize<ExecutionPayload>(readFileSync(path.join(file, 'payload.json'), 'utf8'));
            expect(Number(BigInt(payload(blockDir).timestamp))).toBe(DEADLINE);
            expect(Number(BigInt(payload(stale).timestamp))).toBe(BLOCK.timestamp);
            expect(existsSync(path.join(blockDir, 'proof.json'))).toBe(false);
            expect(resumed.snapshot.rebuild).toBeNull();
        },
    );

    it('А5: контракт принял батч дальше непринятого блока сервиса — остановка, а не «принят»', async () => {
        const service = sequencer();
        await service.start();
        await service.step();
        contract = { batchIndex: 2, stateRoot: 5n };
        const stop = service.step();
        await expect(stop).rejects.toThrow(SequencerStop);
        await expect(stop).rejects.toThrow(
            `контракт принял уже батч 2, а у сервиса непринятый блок 1 (${BLOCK.hash}): контракт ушёл дальше сервиса — ` +
                'батчи шлёт кто-то ещё, или состояние сервиса не от этого контракта',
        );
        expect(service.snapshot.blocks[0].status).toBe('checked');
        expect(service.snapshot.accepted.number).toBe(0);
    });

    it('А6: пруф с ключом чужого задания — отказ до отправки; так же — пруф на диске', async () => {
        const foreign: Prover = { prove: async (job) => ({ ...(await new MockProver().prove(job)), jobKey: 'ab-cd' }) };
        const service = sequencer({}, { prover: foreign });
        await service.start();
        await service.step();
        const key = jobKeyOf({ blockHash: BLOCK.hash, publicValuesBytes: JSON.parse(readFileSync(path.join(service.snapshot.blocks[0].dir, 'job.json'), 'utf8')).publicValuesBytes });
        await expect(service.step()).rejects.toThrow(
            `пруф блока 1 — от задания ab-cd, а задание блока — ${key}: пруф чужого задания не отправляется`,
        );
        expect(submits).toBe(0);
        expect(service.snapshot.blocks[0].status).toBe('checked');
        // Пруф на диске (проверенный блок, батч уже пробовали) — с чужим ключом.
        await mayHaveBeenSentAgain();
        async function mayHaveBeenSentAgain() {
            rmSync(stateDir(), { recursive: true, force: true });
            node = fakeNode();
            await mayHaveBeenSent();
            const proofFile = path.join(stateDir(), 'blocks', '1', 'proof.json');
            const proof = deserialize<{ jobKey: string }>(readFileSync(proofFile, 'utf8'));
            writeFileSync(proofFile, serialize({ ...proof, jobKey: 'ab-cd' }));
            const resumed = sequencer();
            await resumed.start();
            await expect(resumed.step()).rejects.toThrow(/^пруф блока 1 — от задания ab-cd/);
            expect(submits).toBe(0);
        }
    });

    it('А9: чужая блокировка — ни записи состояния, ни отправки', async () => {
        const lockFile = path.join(stateDir(), 'sequencer.lock');
        const stolen = JSON.stringify({ pid: process.pid, host: 'другая', token: 'чужой' }) + '\n';
        const service = sequencer();
        await service.start();
        const stateFile = path.join(stateDir(), 'state.json');
        const before = readFileSync(stateFile, 'utf8');
        writeFileSync(lockFile, stolen);
        await expect(service.step()).rejects.toThrow(StateDirBusy);
        await expect(service.step()).rejects.toThrow(`блокировка ${lockFile} больше не наша (в файле другой владелец)`);
        expect(readFileSync(stateFile, 'utf8')).toBe(before);
        service.close();
        expect(readFileSync(lockFile, 'utf8')).toBe(stolen);

        // Перед отправкой: батч уже записан как «мог уйти», запись не нужна — проверка всё равно есть.
        rmSync(stateDir(), { recursive: true, force: true });
        node = fakeNode();
        await mayHaveBeenSent();
        const resumed = sequencer();
        await resumed.start();
        writeFileSync(lockFile, stolen);
        await expect(resumed.step()).rejects.toThrow(/больше не наша/);
        expect(submits).toBe(0);
    });

    it('А10: пересборка обрезанного блока — обрезка сохраняется', async () => {
        const first = sequencer();
        await first.start();
        await first.step();
        first.close();
        editState((state) => {
            state.tip.cut = true;
        });
        at(DEADLINE);
        tools.behave({ report: reportAt(DEADLINE) });
        const rebuilt = sequencer();
        await rebuilt.start();
        expect(await rebuilt.step()).toMatchObject({ kind: 'checked', number: 1, replaced: BLOCK.hash });
        expect(rebuilt.snapshot.tip.cut).toBe(true);
    });

    it('А10: принудительные отрезка при пересборке — годные снова в блоке по порядку, мусор — нет', async () => {
        const honest = fakeQueue();
        const forced = (number: number, hex: string): QueuedItem => ({
            item: { kind: 'forced', number, bytes: Buffer.from(hex, 'hex') },
            message: { lt: String(100 + number), hash: String(number).repeat(64), number },
        });
        let segment: QueuedItem[] | null = null;
        const queue: QueueSource = {
            read: async (from, cursor, max) => {
                const window = await honest.read(from, cursor, max);
                return segment && from.count === 0 ? { ...window, head: { count: 3, hash: 9n }, items: segment.slice(0, max) } : window;
            },
        };
        const first = sequencer({}, { queue });
        await first.start();
        await first.step();
        first.close();
        editState((state) => {
            segment = [state.blocks[0].segment![0], forced(2, '02aa'), forced(3, 'ff00'), forced(4, '02bb')];
            state.blocks[0].segment = segment;
        });
        at(DEADLINE);
        const rebuilt = sequencer({}, { queue, faults: { stopAfter: 'built' } });
        await rebuilt.start();
        await expect(rebuilt.step()).rejects.toThrow(Interrupted);
        const pending = rebuilt.snapshot.pending!;
        expect(pending.segment.map(({ item }) => item.number)).toEqual([1, 2, 3, 4]);
        expect(pending.request.transactions).toEqual(['0x02aa', '0x02bb']);
        expect(pending.forcedCount).toBe(2);
        expect(pending.request.payloadAttributes.withdrawals).toHaveLength(1);
    });

    it('А10: пустой пересобираемый блок после перезапуска всё равно собирается', async () => {
        const empty: QueueSource = { read: async (from) => ({ head: from, processed: { count: 0, hash: 0n }, from, items: [] }) };
        const first = sequencer();
        await first.start();
        expect(await first.step()).toMatchObject({ kind: 'checked', number: 1 });
        first.close();
        // Отрезок прежнего блока — пустой (заглушка хоста знает только блок 1 с депозитом).
        editState((state) => {
            state.blocks[0].segment = [];
        });
        at(DEADLINE);
        const broken = sequencer({}, { queue: empty, faults: { stopAfter: 'rebuild-saved' } });
        await broken.start();
        await expect(broken.step()).rejects.toThrow(Interrupted);
        // Перезапуск: шаг без allowEmpty — пересобираемый блок обязан вытеснить прежний.
        const resumed = sequencer({}, { queue: empty, faults: { stopAfter: 'built' } });
        await resumed.start();
        await expect(resumed.step()).rejects.toThrow(new Interrupted('built').message);
        expect(resumed.snapshot.pending).toMatchObject({ number: 1, segment: [] });
        expect(Number(BigInt(resumed.snapshot.pending!.payload.timestamp))).toBe(DEADLINE);
    });
});
