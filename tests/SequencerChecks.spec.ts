import { spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import '@ton/test-utils';
import { emptyWithdrawalFrontier } from '../wrappers/rollupMath';
import { EvmBatchReport } from '../wrappers/evmProofs';
import {
    anchorMismatches,
    bridgeLeaves,
    expectedPublicValues,
    forcedFateMismatches,
    reportMismatches,
} from '../sequencer/block/expected';
import { buildRequest, checkPayload, ExecutionPayload, filterPool, PoolTransaction } from '../sequencer/block/payload';
import { chooseSegment, creditsOf } from '../sequencer/block/segment';
import {
    HostIdentity,
    identityMismatches,
    isProgramRefusal,
    refusalReason,
    reportIdentityMismatches,
} from '../sequencer/program';
import { GAS_LIMIT, GENESIS_HASH, ZERO_HASH } from '../sequencer/protocol';
import { QueuedItem } from '../sequencer/queue/types';
import { lockStateDir, StateDirBusy } from '../sequencer/state';
import { blockOf, hexBytes, reportOf, rethExpected } from './helpers/rethChain';

// Сверки сборщика блоков (круг 18): судьба принудительных по порядку, отрезок без рычага на
// пропускную способность, несущие слова отдельно, ветки reportMismatches с точным текстом,
// сверка ответа узла по полям, фильтр пула, отказ программы против сбоя инструмента, сборка
// хоста против program.json, блокировка каталога состояния. Чистые функции; узел не нужен.

const deposit = (number: number, l2Recipient: string, amount: bigint): QueuedItem => ({
    item: { kind: 'deposit', number, l2Recipient, amount },
    message: { lt: String(number), hash: `h${number}`, number },
});
const forced = (number: number, bytes: Buffer): QueuedItem => ({
    item: { kind: 'forced', number, bytes },
    message: { lt: String(number), hash: `h${number}`, number },
});
const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const F = Buffer.from('02f8' + 'ab'.repeat(40), 'hex');
const G = Buffer.from('02f8' + 'cd'.repeat(40), 'hex');
const raw = (bytes: Buffer) => '0x' + bytes.toString('hex');

/** Отрезок блока цепочки Reth из её очереди. */
const segmentOf = (number: number): QueuedItem[] => {
    const block = blockOf(number);
    return rethExpected.queue
        .filter((item) => item.number > block.queueProcessedFrom && item.number <= block.queueProcessedUpTo)
        .map((item) =>
            item.kind === 'deposit'
                ? deposit(item.number, item.l2Recipient, BigInt(item.amount))
                : forced(item.number, hexBytes(item.bytes)),
        );
};

describe('сборщик блоков: судьба принудительных по порядку (H1)', () => {
    it('две одинаковые принудительные в отрезке: первая включена, вторая пропущена — не расхождение', () => {
        const segment = [forced(1, F), forced(2, F)];
        const report: EvmBatchReport['forced'] = [
            { queueIndex: 0, outcome: 'included' },
            { queueIndex: 1, outcome: 'skipped', reason: 'Invalid(NonceTooLow)' },
        ];
        expect(forcedFateMismatches(segment, report, [raw(F)])).toEqual([]);
        // Та же пара, но в блоке её нет вовсе, либо стоит дважды, — расхождение.
        expect(forcedFateMismatches(segment, report, [])).toEqual([
            'принудительная №1: программа включила её, а транзакция блока №0 — нет такой',
            'в блоке принудительных 0, а программа включила 1',
        ]);
        expect(forcedFateMismatches(segment, report, [raw(F), raw(F)])).toEqual([
            'в блоке принудительных 2, а программа включила 1',
        ]);
    });

    it('блок 2 цепочки Reth (с дублем включённой) сходится; включённая не на своём месте — расхождение', () => {
        const segment = segmentOf(2);
        const included = segment.find(({ item }) => item.number === 3)!.item as { bytes: Buffer };
        expect(forcedFateMismatches(segment, reportOf(2).forced, [raw(included.bytes)])).toEqual([]);
        // Включена «вторая», пропущена «первая»: по множеству байтов не отличить, по порядку — видно.
        const segmentFG = [forced(1, G), forced(2, F)];
        expect(
            forcedFateMismatches(
                segmentFG,
                [
                    { queueIndex: 0, outcome: 'skipped', reason: 'Signature' },
                    { queueIndex: 1, outcome: 'included' },
                ],
                [raw(G)],
            ),
        ).toEqual(['принудительная №2: программа включила её, а транзакция блока №0 — другая']);
        // Обе включены, но в блоке — в другом порядке: множество то же, порядок — нет.
        expect(
            forcedFateMismatches(
                segmentFG,
                [
                    { queueIndex: 0, outcome: 'included' },
                    { queueIndex: 1, outcome: 'included' },
                ],
                [raw(F), raw(G)],
            ),
        ).toEqual([
            'принудительная №1: программа включила её, а транзакция блока №0 — другая',
            'принудительная №2: программа включила её, а транзакция блока №1 — другая',
        ]);
    });

    it('место в отрезке (queueIndex) и число записей отчёта сверяются', () => {
        const segment = [deposit(1, A, 1n), forced(2, F), forced(3, G)];
        expect(
            forcedFateMismatches(
                segment,
                [
                    { queueIndex: 1, outcome: 'included' },
                    { queueIndex: 2, outcome: 'skipped', reason: 'Signature' },
                ],
                [raw(F)],
            ),
        ).toEqual([]);
        expect(
            forcedFateMismatches(
                segment,
                [
                    { queueIndex: 0, outcome: 'included' },
                    { queueIndex: 2, outcome: 'skipped', reason: 'Signature' },
                ],
                [raw(F)],
            ),
        ).toEqual(['принудительная №2: у программы место в отрезке 0, у сервиса 1']);
        expect(forcedFateMismatches(segment, [{ queueIndex: 1, outcome: 'included' }], [raw(F)])).toEqual([
            'в отчёте программы принудительных 1, в отрезке 2',
        ]);
    });
});

describe('сборщик блоков: отрезок без рычага на пропускную способность (H2)', () => {
    const max = 32;
    // D(Xi) F(Xi) D(Xi+1) F(Xi+1)…: каждая принудительная тратит депозит того же отрезка.
    const attack = Array.from({ length: 80 }, (_, index) =>
        index % 2 === 0 ? deposit(index + 1, `0x${(index + 16).toString(16).padStart(40, '0')}`, 1n) : forced(index + 1, F),
    );
    const signers = new Map(
        attack.flatMap(({ item }, index) =>
            item.kind === 'forced' ? [[item.number, (attack[index - 1].item as { l2Recipient: string }).l2Recipient]] : [],
        ),
    ) as Map<number, string>;

    it('на окне D F D F… с очередью сверх предела блок берёт полный отрезок', () => {
        const choice = chooseSegment(attack.slice(0, max), max, signers, { pending: attack.length, previousCut: false });
        expect(choice).toEqual({ items: attack.slice(0, max), cut: `предел ${max} элементов на батч`, depositCut: false });
    });

    it('после обрезанного блока следующий не режется; без очереди сверх предела обрезка — не чаще блока через блок', () => {
        const window = attack.slice(0, 10);
        expect(chooseSegment(window, max, signers, { pending: 10, previousCut: true })).toEqual({
            items: window,
            cut: null,
            depositCut: false,
        });
        const cut = chooseSegment(window, max, signers, { pending: 10, previousCut: false });
        expect(cut).toEqual({
            items: window.slice(0, 1),
            cut: 'элемент №2: отправителю зачисляется депозит в этом же отрезке',
            depositCut: true,
        });
        // Две пары подряд: блоки по очереди — обрезанный (1 элемент) и полный; в среднем не меньше половины предела.
        let from = 0;
        let previousCut = false;
        let blocks = 0;
        while (from < attack.length) {
            const window = attack.slice(from, from + max);
            const choice = chooseSegment(window, max, signers, { pending: attack.length - from, previousCut });
            from += choice.items.length;
            previousCut = choice.depositCut;
            blocks++;
        }
        expect(blocks).toBeLessThanOrEqual(Math.ceil(attack.length / max) + 1);
    });
});

describe('сборщик блоков: несущие слова и ветки reportMismatches с точным текстом (M3, T2)', () => {
    const report = reportOf(1);
    const block = blockOf(1);
    const from = { count: 0, hash: 0n };
    const tree = { frontier: emptyWithdrawalFrontier(), count: 0n };
    const expected = expectedPublicValues({
        chainId: BigInt(rethExpected.chainId),
        parentHash: rethExpected.genesisHash,
        candidateHash: block.hash,
        timestamp: block.timestamp,
        queueFrom: from,
        segment: segmentOf(1),
        treeBefore: tree,
        leaves: bridgeLeaves([]),
        dataChunks: report.dataChunksHex.map((chunk) => Buffer.from(chunk, 'hex')),
    });

    it('честный отчёт блока 1 сходится', () => {
        expect(anchorMismatches(report, GENESIS_HASH, block.hash)).toEqual([]);
        expect(reportMismatches(report, expected, from)).toEqual([]);
    });

    it('отчёт о другом блоке и от другой вершины — свои тексты', () => {
        expect(anchorMismatches(report, GENESIS_HASH, blockOf(2).hash)).toEqual([
            `newStateRoot программы ${block.hash} — не хеш кандидата ${blockOf(2).hash}: отчёт о другом блоке`,
        ]);
        expect(anchorMismatches(report, blockOf(2).hash, block.hash)).toEqual([
            `prevStateRoot программы ${GENESIS_HASH} — не хеш проверенной вершины ${blockOf(2).hash}`,
        ]);
    });

    it('отметки очереди, фронтир и байты публичных значений — каждая ветка отдельно', () => {
        expect(reportMismatches({ ...report, queueProcessedUpTo: report.queueProcessedUpTo + 1 }, expected, from)).toEqual([
            `отметки очереди у программы 0..${report.queueProcessedUpTo + 1}, у сервиса 0..${report.queueProcessedUpTo}`,
        ]);
        expect(reportMismatches({ ...report, queueProcessedFrom: 1 }, expected, from)).toEqual([
            `отметки очереди у программы 1..${report.queueProcessedUpTo}, у сервиса 0..${report.queueProcessedUpTo}`,
        ]);
        const frontier = [...report.withdrawalsFrontierAfter];
        frontier[3] = '0x' + '01'.repeat(32);
        expect(reportMismatches({ ...report, withdrawalsFrontierAfter: frontier }, expected, from)).toEqual([
            'фронтир дерева выводов после блока не тот',
        ]);
        const bytes = report.publicValuesBytes.replace(/^0x/, '');
        const tampered = '0x' + bytes.slice(0, 64 * 3) + 'ff'.repeat(32) + bytes.slice(64 * 4);
        expect(reportMismatches({ ...report, publicValuesBytes: tampered }, expected, from)).toEqual([
            'байты публичных значений не те',
        ]);
        expect(reportMismatches({ ...report, publicValuesBytes: report.publicValuesBytes.slice(0, -2) }, expected, from)).toEqual([
            'байты публичных значений не те',
        ]);
        expect(
            reportMismatches({ ...report, publicValues: { ...report.publicValues, withdrawalsCount: '1' } }, expected, from),
        ).toEqual(['withdrawalsCount: у программы 0x1, у сервиса 0x0']);
    });
});

describe('сборщик блоков: сверка ответа узла по полям (T4)', () => {
    const request = buildRequest({
        parentHash: GENESIS_HASH,
        timestamp: 1000,
        feeRecipient: B,
        credits: creditsOf([deposit(1, A, 5n)]),
        forced: [],
        pool: [],
    });
    const payload = (overrides: Partial<ExecutionPayload> = {}): ExecutionPayload => ({
        parentHash: GENESIS_HASH,
        feeRecipient: B,
        stateRoot: ZERO_HASH,
        prevRandao: ZERO_HASH,
        blockNumber: '0x1',
        gasLimit: '0x' + GAS_LIMIT.toString(16),
        gasUsed: '0x0',
        timestamp: '0x3e8',
        extraData: '0x',
        blockHash: '0x' + '77'.repeat(32),
        transactions: [],
        withdrawals: [{ index: '0x0', validatorIndex: '0x0', address: A, amount: '0x5' }],
        blobGasUsed: '0x0',
        excessBlobGas: '0x0',
        ...overrides,
    });

    it('адрес и сумма зачисления, расход blob-газа — каждое отдельно', () => {
        expect(checkPayload(request, 0, payload()).problems).toEqual([]);
        expect(
            checkPayload(request, 0, payload({ withdrawals: [{ index: '0x0', validatorIndex: '0x0', address: B, amount: '0x5' }] }))
                .problems,
        ).toEqual(['зачисления не те, что запрошены']);
        expect(
            checkPayload(request, 0, payload({ withdrawals: [{ index: '0x0', validatorIndex: '0x0', address: A, amount: '0x6' }] }))
                .problems,
        ).toEqual(['зачисления не те, что запрошены']);
        expect(checkPayload(request, 0, payload({ blobGasUsed: '0x20000' })).problems).toEqual([
            'расход или избыток blob-газа не ноль',
        ]);
        // Поля нет в ответе — не ноль (узел обязан его отдать).
        const { blobGasUsed: _dropped, ...withoutBlob } = payload();
        expect(checkPayload(request, 0, withoutBlob as ExecutionPayload).problems).toEqual([
            'расход или избыток blob-газа не ноль',
        ]);
    });
});

describe('сборщик блоков: фильтр и бюджет пула (T6, M7)', () => {
    const tx = (hash: string, fields: Partial<PoolTransaction>): PoolTransaction => ({
        hash,
        from: A,
        nonce: '0x0',
        type: '0x2',
        chainId: '0x7',
        gas: '0x5208',
        ...fields,
    });

    it('нет chainId или типа — фильтр, а не падение', () => {
        const pool = [tx('ok', {}), tx('noChain', { chainId: undefined }), tx('noType', { type: undefined, nonce: '0x1' })];
        expect(filterPool(pool, 7n, 10n ** 9n).map((t) => t.hash)).toEqual(['ok']);
    });

    it('общий газ — не больше бюджета: очередь отправителя обрывается на первой, что не влезла', () => {
        const pool = [0, 1, 2].map((nonce) => tx(`n${nonce}`, { nonce: '0x' + nonce.toString(16), gas: '0x' + (2_000_000).toString(16) }));
        expect(filterPool(pool, 7n, 5_000_000n).map((t) => t.hash)).toEqual(['n0', 'n1']);
        expect(filterPool(pool, 7n, 1_999_999n)).toEqual([]);
    });
});

describe('сборщик блоков: отказ программы против сбоя инструмента (M6)', () => {
    const refusal = "thread 'main' panicked at host/src/main.rs:609:43:\nнативный расчёт отверг батч: DepositMismatch(0)\n";

    it('отказ программы — только паника хоста на process_evm_batch (код 101 и её строка)', () => {
        expect(isProgramRefusal({ code: 101, stdout: '', stderr: refusal })).toBe(true);
        // Несогласованный свидетель (код 2), другая паника, сигнал (предел времени, OOM) — сбой инструмента.
        expect(
            isProgramRefusal({ code: 2, stdout: '', stderr: 'Свидетель не продолжает предыдущий батч: не совпал хеш очереди.' }),
        ).toBe(false);
        expect(
            isProgramRefusal({ code: 101, stdout: '', stderr: "thread 'main' panicked:\nфайл входа блока не читается" }),
        ).toBe(false);
        expect(isProgramRefusal({ code: null, signal: 'SIGKILL', stdout: '', stderr: refusal })).toBe(false);
        expect(isProgramRefusal({ code: 137, stdout: '', stderr: '' })).toBe(false);
        expect(refusalReason({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' })).toBe('убит сигналом SIGKILL');
    });
});

describe('сборщик блоков: хост против program.json (M2)', () => {
    const keys = { sourcesSha256: 'aa'.repeat(32), programVKey: '0x01', programElfSha256: 'bb'.repeat(32) };
    const identity: HostIdentity = {
        programElfSha256: '0x' + 'bb'.repeat(32),
        sourcesSha256: 'aa'.repeat(32),
        sourcesSha256OnDisk: 'aa'.repeat(32),
        hostSha256: 'cc'.repeat(32),
        hostSha256OnDisk: 'cc'.repeat(32),
    };

    it('та же сборка — пусто; чужой ELF, чужие или изменённые исходники — по причине', () => {
        expect(identityMismatches(identity, keys)).toEqual([]);
        expect(identityMismatches({ ...identity, programElfSha256: '0x' + 'dd'.repeat(32) }, keys)).toEqual([
            `ELF программы в хосте ${'dd'.repeat(32)}, в program.json ${'bb'.repeat(32)}`,
        ]);
        expect(identityMismatches({ ...identity, sourcesSha256OnDisk: 'ee'.repeat(32) }, keys)).toEqual([
            `исходники программы изменились после сборки хоста (на диске ${'ee'.repeat(32)})`,
        ]);
        expect(identityMismatches({ ...identity, hostSha256OnDisk: 'ee'.repeat(32) }, keys)).toEqual([
            `исходники хоста изменились после его сборки (на диске ${'ee'.repeat(32)})`,
        ]);
    });

    it('отчёт с чужим хешем ELF или исходников — расхождение', () => {
        const report = { ...reportOf(1), programElfSha256: '0x' + 'bb'.repeat(32) };
        expect(reportIdentityMismatches(report, keys)).toEqual([]);
        expect(reportIdentityMismatches({ ...report, programElfSha256: '0x' + '00'.repeat(32) }, keys)).toEqual([
            `отчёт хоста — от ELF ${'00'.repeat(32)}, а в program.json ${'bb'.repeat(32)}`,
        ]);
        expect(reportIdentityMismatches({ ...report, sourcesSha256: '11'.repeat(32) }, keys)).toEqual([
            `отчёт хоста — от исходников ${'11'.repeat(32)}, а в program.json ${'aa'.repeat(32)}`,
        ]);
    });
});

describe('сборщик блоков: блокировка каталога состояния (M4)', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'sequencer-lock-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('второй экземпляр в этом же процессе — отказ; после снятия — берётся', () => {
        const release = lockStateDir(dir);
        expect(() => lockStateDir(dir)).toThrow(StateDirBusy);
        expect(() => lockStateDir(dir)).toThrow(`каталог состояния ${dir} занят другим экземпляром сервиса в этом же процессе`);
        release();
        lockStateDir(dir)();
    });

    it('хозяин — живой чужой процесс: отказ с его pid; мёртвый — блокировка снимается', async () => {
        const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
        try {
            writeFileSync(path.join(dir, 'sequencer.lock'), JSON.stringify({ pid: holder.pid, token: 'x' }));
            expect(() => lockStateDir(dir)).toThrow(
                `каталог состояния ${dir} занят сервисом с pid ${holder.pid} (${path.join(dir, 'sequencer.lock')}): второй экземпляр не запускается`,
            );
        } finally {
            holder.kill('SIGKILL');
            await new Promise((resolve) => holder.once('exit', resolve));
        }
        lockStateDir(dir)();
        // Пустой файл — блокировку пишут (круг 19): занят, пока молод; старый — снимается (SequencerProcess.spec.ts).
        writeFileSync(path.join(dir, 'sequencer.lock'), '');
        expect(() => lockStateDir(dir)).toThrow(/без содержимого моложе/);
    });
});

