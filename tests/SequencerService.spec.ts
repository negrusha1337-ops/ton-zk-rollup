import { existsSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import '@ton/test-utils';
import { liveChildren } from '../sequencer/children';
import { MockProver, Prover } from '../sequencer/prover';
import { Interrupted, Sequencer, SequencerConfig, SequencerDeps, SequencerStop } from '../sequencer/service';
import { StateDirBusy } from '../sequencer/state';
import { BatchSubmitter } from '../sequencer/submitter';
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
    const accepted: BatchSubmitter = { submit: async () => ({ accepted: true, alreadyAccepted: false }) };

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

    it('M5: часы машины против L1 при старте; не успеть до конца срока — до пруфа и до отправки остановка', async () => {
        clock.l1 = clock.machine - 61;
        await expect(sequencer().start()).rejects.toThrow(
            'часы машины расходятся со временем L1 на 61 с (предел 60): время блоков и срок приёма считались бы неверно',
        );
        clock.l1 = clock.machine;
        let proofs = 0;
        const prover: Prover = {
            prove: async (job) => {
                proofs++;
                clock.l1 = BLOCK.timestamp + MAX_BLOCK_AGE - 299;
                return new MockProver().prove(job);
            },
        };
        const service = sequencer({}, { prover });
        await service.start();
        await service.step();
        clock.l1 = BLOCK.timestamp + MAX_BLOCK_AGE - 299;
        await expect(service.step()).rejects.toThrow(
            `батч 1 не успеть принять до пруфа: время блока ${BLOCK.timestamp} + maxBlockAge ${MAX_BLOCK_AGE} = ${BLOCK.timestamp + MAX_BLOCK_AGE}, ` +
                `а время L1 ${BLOCK.timestamp + MAX_BLOCK_AGE - 299} + запас 300 = ${BLOCK.timestamp + MAX_BLOCK_AGE + 1}; блок нужно пересобрать (пересборки ещё нет)`,
        );
        expect(proofs).toBe(0);
        // Пруф строился долго: перед отправкой срок проверяется снова.
        clock.l1 = BLOCK.timestamp + MAX_BLOCK_AGE - 300;
        await expect(service.step()).rejects.toThrow(/^батч 1 не успеть принять до отправки: /);
        expect(proofs).toBe(1);
        expect(node.tags.finalized).toBe(rethExpected.genesisHash);
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
