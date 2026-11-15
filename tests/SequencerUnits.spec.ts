import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Rollup, RollupOpcodes } from '../wrappers/Rollup';
import { byteSnake, emptyWithdrawalFrontier, forcedTransactionCell } from '../wrappers/rollupMath';
import { appendLeaves, bridgeLeaves, expectedPublicValues, reportMismatches } from '../sequencer/block/expected';
import {
    blockTimestamp,
    buildRequest,
    checkPayload,
    ExecutionPayload,
    filterPool,
    forcedToDrop,
    PoolTransaction,
} from '../sequencer/block/payload';
import { chooseSegment, creditsOf } from '../sequencer/block/segment';
import { refusalReason } from '../sequencer/program';
import { BRIDGE_ADDRESS, GAS_LIMIT, GENESIS_HASH, WITHDRAWAL_TOPIC, ZERO_HASH } from '../sequencer/protocol';
import { chainHashes, ContractQueueSource, matchQueueItems } from '../sequencer/queue/contractSource';
import { parseQueueMessage, queueStep, snakeBytes } from '../sequencer/queue/messages';
import { SandboxFeed, SandboxQueueSource } from '../sequencer/queue/sandbox';
import { v3Messages } from '../sequencer/queue/toncenter';
import { QueuedItem, QueueMismatchError } from '../sequencer/queue/types';
import { deserialize, genesisState, serialize, StateStore, writeAtomically } from '../sequencer/state';
import { finalizeDummyKeys, readProtocolConstants, testConfig } from './helpers/rollupSetup';
import { blockOf, hexBytes, rethExpected, rethReports } from './helpers/rethChain';

// Чистые функции сборщика блоков (sequencer/): выбор отрезка, нумерация зачислений, сверка ответа
// узла, разбор и сверка элементов очереди, собственный расчёт публичных значений, состояние на
// диске. Узел Reth здесь не нужен; сквозной прогон с узлом — tests/SequencerReth.spec.ts.

const LIMITS = { maxForcedTxCells: 3, maxForcedTxBytes: 256 };
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

describe('сборщик блоков: отрезок и зачисления', () => {
    it('зачисления — депозиты отрезка по порядку, номер — место в блоке С НУЛЯ, валидатор — ноль', () => {
        const segment = [deposit(5, A, 7n), forced(6, Buffer.from('01', 'hex')), deposit(7, B, 9n)];
        expect(creditsOf(segment)).toEqual([
            { index: '0x0', validatorIndex: '0x0', address: A, amount: '0x7' },
            { index: '0x1', validatorIndex: '0x0', address: B, amount: '0x9' },
        ]);
        expect(creditsOf([])).toEqual([]);
        // Адрес — строчными: узел вернёт так же, а сверка ответа сравнивает строки без регистра.
        expect(creditsOf([deposit(1, '0x' + 'AB'.repeat(20), 1n)])[0].address).toBe('0x' + 'ab'.repeat(20));
    });

    it('сумма зачисления — от 1 до 2^64 − 1 gwei: иное программа отвергнет весь батч', () => {
        expect(() => creditsOf([deposit(1, A, 0n)])).toThrow('не помещается в зачисление');
        expect(() => creditsOf([deposit(1, A, 1n << 64n)])).toThrow('не помещается в зачисление');
        expect(creditsOf([deposit(1, A, (1n << 64n) - 1n)])[0].amount).toBe('0xffffffffffffffff');
    });

    it('отрезок — префикс окна не длиннее предела контракта', () => {
        const window = Array.from({ length: 5 }, (_, index) => deposit(index + 1, A, 1n));
        expect(chooseSegment(window, 3, new Map())).toEqual({
            items: window.slice(0, 3),
            cut: 'предел 3 элементов на батч',
        });
        expect(chooseSegment(window, 5, new Map())).toEqual({ items: window, cut: null });
        expect(chooseSegment(window, 0, new Map()).items).toEqual([]);
        expect(() => chooseSegment([window[0], window[2]], 5, new Map())).toThrow('не по порядку');
    });

    it('принудительная от счёта, которому в этом же отрезке зачисляется депозит, уходит в следующий блок', () => {
        const window = [
            forced(1, Buffer.from('aa', 'hex')),
            deposit(2, A, 1n),
            forced(3, Buffer.from('bb', 'hex')),
            deposit(4, B, 1n),
        ];
        // Отправитель элемента 3 — A: депозит A зачислится только в конце блока, отрезок режется перед ним.
        expect(
            chooseSegment(
                window,
                32,
                new Map([
                    [1, A],
                    [3, A.toUpperCase().replace('0X', '0x')],
                ]),
            ),
        ).toEqual({
            items: window.slice(0, 2),
            cut: 'элемент №3: отправителю зачисляется депозит в этом же отрезке',
        });
        // Принудительная ДО депозита того же счёта — не повод резать; чужой отправитель — тоже.
        expect(
            chooseSegment(
                window,
                32,
                new Map([
                    [1, A],
                    [3, B],
                ]),
            ).items,
        ).toEqual(window);
    });

    it('время блока — не раньше секунды после родителя и не раньше «сейчас»', () => {
        expect(blockTimestamp(100, 50)).toBe(101);
        expect(blockTimestamp(100, 500)).toBe(500);
    });
});

describe('сборщик блоков: сверка ответа узла', () => {
    const raw = (tag: string) => '0x' + tag.repeat(20);
    const request = buildRequest({
        parentHash: GENESIS_HASH,
        timestamp: 1000,
        feeRecipient: B,
        credits: creditsOf([deposit(1, A, 5n)]),
        forced: [raw('01'), raw('02'), raw('03')],
        pool: [raw('0a'), raw('0b')],
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
        transactions: [...request.transactions],
        withdrawals: [{ index: '0x0', validatorIndex: '0x0', address: A, amount: '0x5' }],
        blobGasUsed: '0x0',
        excessBlobGas: '0x0',
        ...overrides,
    });

    it('запрос: закреплённые поля программы, принудительные первыми, затем пул', () => {
        expect(request.payloadAttributes.prevRandao).toBe(ZERO_HASH);
        expect(request.payloadAttributes.parentBeaconBlockRoot).toBe(ZERO_HASH);
        expect(request.payloadAttributes.timestamp).toBe('0x3e8');
        expect(request.transactions).toEqual([raw('01'), raw('02'), raw('03'), raw('0a'), raw('0b')]);
    });

    it('ответ, совпавший с запросом байт в байт, годен', () => {
        expect(checkPayload(request, 3, payload())).toEqual({ problems: [], droppedForced: [], poolIncluded: 2 });
        // Пул узел вправе урезать: подпоследовательность годна.
        expect(
            checkPayload(request, 3, payload({ transactions: [raw('01'), raw('02'), raw('03'), raw('0b')] })),
        ).toEqual({ problems: [], droppedForced: [], poolIncluded: 1 });
    });

    it('выброшенные узлом принудительные — видны; первая у каждого отправителя убирается перед пересборкой', () => {
        const check = checkPayload(request, 3, payload({ transactions: [raw('02'), raw('0a')] }));
        expect(check).toEqual({ problems: [], droppedForced: [0, 2], poolIncluded: 1 });
        // 0 и 2 — один отправитель: узел отказал первой, вторую выбросил без исполнения.
        expect(forcedToDrop(check.droppedForced, [A, B, A])).toEqual([0]);
        expect(forcedToDrop([2, 0], [A, B, B])).toEqual([0, 2]);
    });

    it('закреплённые поля, родитель, время, получатель чаевых и зачисления сверяются', () => {
        const cases: [Partial<ExecutionPayload>, string][] = [
            [{ gasLimit: '0x' + (36_000_000).toString(16) }, 'лимит газа'],
            [{ extraData: '0x01' }, 'extraData'],
            [{ prevRandao: '0x' + '01'.repeat(32) }, 'prevRandao'],
            [{ parentHash: '0x' + '01'.repeat(32) }, 'родитель'],
            [{ timestamp: '0x3e9' }, 'время'],
            [{ feeRecipient: A }, 'получатель чаевых'],
            [{ excessBlobGas: '0x1' }, 'blob-газа'],
            [{ withdrawals: [{ index: '0x1', validatorIndex: '0x0', address: A, amount: '0x5' }] }, 'зачисления'],
            [{ withdrawals: [{ index: '0x0', validatorIndex: '0x1', address: A, amount: '0x5' }] }, 'зачисления'],
            [{ withdrawals: [] }, 'зачисления'],
        ];
        for (const [overrides, word] of cases) {
            const problems = checkPayload(request, 3, payload(overrides)).problems;
            expect({ overrides, problems: problems.join('; ') }).toEqual({
                overrides,
                problems: expect.stringContaining(word),
            });
        }
    });

    it('транзакция не из запроса или не на своём месте — негодный кандидат', () => {
        expect(
            checkPayload(request, 3, payload({ transactions: [raw('01'), raw('02'), raw('03'), raw('0c')] }))
                .problems[0],
        ).toContain('не из запроса');
        expect(
            checkPayload(request, 3, payload({ transactions: [raw('01'), raw('02'), raw('03'), raw('0b'), raw('0a')] }))
                .problems[0],
        ).toContain('не на своём месте');
        // Принудительная после пула — тоже.
        expect(checkPayload(request, 3, payload({ transactions: [raw('0a'), raw('01')] })).problems[0]).toContain(
            'не из запроса',
        );
    });

    it('фильтр пула: только типы 0/1/2 со своим chainId, без блобов и делегирования, в пределах газа', () => {
        const tx = (hash: string, fields: Partial<PoolTransaction>): PoolTransaction => ({
            hash,
            from: A,
            nonce: '0x0',
            type: '0x2',
            chainId: '0x7',
            gas: '0x5208',
            ...fields,
        });
        const pool = [
            tx('ok2', { nonce: '0x1' }),
            tx('ok0', { type: '0x0', from: B }),
            tx('ok1', { type: '0x1', nonce: '0x0' }),
            tx('blobType', { type: '0x3' }),
            tx('delegation', { type: '0x4' }),
            tx('noChain', { type: '0x0', chainId: null }),
            tx('foreign', { chainId: '0x8' }),
            tx('blobs', { blobVersionedHashes: ['0x01'] }),
            tx('authorizations', { authorizationList: [{}] }),
        ];
        expect(filterPool(pool, 7n, 10n ** 9n).map((t) => t.hash)).toEqual(['ok1', 'ok2', 'ok0']);
        expect(filterPool(pool, 7n, 21_000n * 2n).map((t) => t.hash)).toEqual(['ok1', 'ok2']);
    });
});

describe('сборщик блоков: элементы очереди из сообщений', () => {
    const transaction = Buffer.from('02f86b85' + 'ab'.repeat(100), 'hex');

    it('«змейка» читается как в контракте: целые байты, одна ссылка, пределы ячеек и байтов', () => {
        expect(snakeBytes(forcedTransactionCell(transaction, [50, 50, transaction.length - 100]), LIMITS)).toEqual(
            transaction,
        );
        expect(snakeBytes(beginCell().endCell(), LIMITS)).toEqual(Buffer.alloc(0));
        expect(() => snakeBytes(beginCell().storeUint(1, 4).endCell(), LIMITS)).toThrow('не целое число байт');
        expect(() => snakeBytes(beginCell().storeRef(Cell.EMPTY).storeRef(Cell.EMPTY).endCell(), LIMITS)).toThrow(
            'больше одной ссылки',
        );
        expect(() => snakeBytes(byteSnake(Buffer.alloc(40), [10, 10, 10, 10]), LIMITS)).toThrow('в ячейках');
        expect(() => snakeBytes(byteSnake(Buffer.alloc(257)), LIMITS)).toThrow('в байтах');
    });

    it('тело DepositTon даёт получателя, ForceTransaction — байты, прочее — не элемент очереди', () => {
        const depositBody = beginCell()
            .storeUint(RollupOpcodes.depositTon, 32)
            .storeUint(0, 64)
            .storeUint(BigInt(A), 160)
            .storeCoins(1n)
            .endCell();
        expect(parseQueueMessage(depositBody, LIMITS)).toEqual({ kind: 'deposit', l2Recipient: A });
        const forcedBody = beginCell()
            .storeUint(RollupOpcodes.forceTransaction, 32)
            .storeUint(0, 64)
            .storeRef(forcedTransactionCell(transaction))
            .endCell();
        expect(parseQueueMessage(forcedBody, LIMITS)).toEqual({ kind: 'forced', bytes: transaction });
        expect(parseQueueMessage(beginCell().storeUint(RollupOpcodes.publishData, 32).endCell(), LIMITS)).toEqual({
            kind: 'other',
        });
        expect(parseQueueMessage(beginCell().endCell(), LIMITS)).toEqual({ kind: 'other' });
    });

    it('элемент принимается, только если шаг хеша от него даёт хеш цепочки контракта', async () => {
        const items = [
            { kind: 'deposit' as const, l2Recipient: A, amount: 5n },
            { kind: 'forced' as const, bytes: transaction },
        ];
        const hashes = [123n];
        for (const item of items) hashes.push(queueStep(hashes[hashes.length - 1], item));
        const messages = [
            {
                message: { lt: 10n, hash: 'x', success: true, body: null },
                parsed: { kind: 'deposit' as const, l2Recipient: A },
            },
            {
                message: { lt: 11n, hash: 'y', success: true, body: null },
                parsed: { kind: 'forced' as const, bytes: transaction },
            },
        ];
        const from = { count: 7, hash: 123n };
        const matched = await matchQueueItems(from, hashes, messages, async (number) => (number === 8 ? 5n : null));
        expect(matched.map(({ item, message }) => [item.number, item.kind, message])).toEqual([
            [8, 'deposit', { lt: '10', hash: 'x', number: 8 }],
            [9, 'forced', { lt: '11', hash: 'y', number: 9 }],
        ]);
        // Другая сумма депозита, другие байты, нет квитанции, нет сообщения — остановка с текстом.
        await expect(matchQueueItems(from, hashes, messages, async () => 6n)).rejects.toThrow(
            /элемент очереди №8 .*не сходится с хешем очереди контракта/,
        );
        const altered = [
            messages[0],
            {
                ...messages[1],
                parsed: { kind: 'forced' as const, bytes: Buffer.concat([transaction, Buffer.from([0])]) },
            },
        ];
        await expect(matchQueueItems(from, hashes, altered, async () => 5n)).rejects.toThrow(
            /элемент очереди №9 .*не сходится/,
        );
        await expect(matchQueueItems(from, hashes, messages, async () => null)).rejects.toThrow(
            'депозит без квитанции',
        );
        await expect(matchQueueItems(from, hashes, messages.slice(0, 1), async () => 5n)).rejects.toThrow(
            'сообщения, которое его поставило, сервис не нашёл',
        );
        expect(QueueMismatchError).toBeDefined();
    });

    it('ответ toncenter v3: успех — вычисление прошло и транзакция не прервана; внешние и возвращённые — без тела', () => {
        const body = beginCell().storeUint(RollupOpcodes.depositTon, 32).endCell().toBoc().toString('base64');
        const hash = Buffer.from('ab'.repeat(32), 'hex').toString('base64');
        const internal = { source: '0:00', bounced: false, message_content: { body } };
        const messages = v3Messages([
            { lt: '5', hash, description: { aborted: false, compute_ph: { success: true } }, in_msg: internal },
            { lt: '6', hash, description: { aborted: true, compute_ph: { success: true } }, in_msg: internal },
            { lt: '7', hash, description: { aborted: false, compute_ph: { skipped: true } }, in_msg: internal },
            {
                lt: '8',
                hash,
                description: { aborted: false, compute_ph: { success: true } },
                in_msg: { ...internal, source: null },
            },
            {
                lt: '9',
                hash,
                description: { aborted: false, compute_ph: { success: true } },
                in_msg: { ...internal, bounced: true },
            },
        ]);
        expect(messages.map((message) => [message.lt, message.success, message.body !== null])).toEqual([
            [5n, true, true],
            [6n, false, true],
            [7n, false, true],
            [8n, true, false],
            [9n, true, false],
        ]);
        expect(messages[0].hash).toBe('ab'.repeat(32));
    });
});

describe('сборщик блоков: очередь двойника контракта в Sandbox', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let feed: SandboxFeed;
    let source: SandboxQueueSource;
    const transaction = Buffer.from('02' + 'cd'.repeat(80), 'hex');

    beforeAll(async () => {
        const code = await compile('RollupMock');
        const nullifierCode = await compile('RollupNullifier');
        const constants = await readProtocolConstants(code, nullifierCode);
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                testConfig(constants, {
                    owner: owner.address,
                    sequencer: owner.address,
                    nullifierCode,
                    chainId: 7n,
                    escapeTimeout: 3600,
                }),
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('0.05'));
        await finalizeDummyKeys(rollup, owner);
        feed = new SandboxFeed(rollup.address);
        source = new SandboxQueueSource(rollup, feed, constants);
        const fees = await rollup.getQueueFees();
        feed.record(
            await rollup.sendDeposit(owner.getSender(), {
                l2Recipient: BigInt(A),
                value: toNano('1') + fees.depositFee,
                maxFee: fees.depositFee,
            }),
        );
        // Отвергнутый депозит (комиссия выше согласованной) элемента не ставит и в счёт не идёт.
        const refused = await rollup.sendDeposit(owner.getSender(), {
            l2Recipient: BigInt(B),
            value: toNano('1'),
            maxFee: 0n,
        });
        expect(refused.transactions).toHaveTransaction({ to: rollup.address, success: false });
        feed.record(refused);
        feed.record(
            await rollup.sendForceTransaction(owner.getSender(), {
                l2Transaction: forcedTransactionCell(transaction),
                value: fees.forceTransactionFee,
            }),
        );
        feed.record(
            await rollup.sendDeposit(owner.getSender(), {
                l2Recipient: BigInt(B),
                value: toNano('2') + fees.depositFee,
                maxFee: fees.depositFee,
            }),
        );
    });

    it('окно очереди восстанавливается из перехваченных сообщений и сверено с хешами контракта', async () => {
        const window = await source.read({ count: 0, hash: 0n }, null, 32);
        expect(window.head.count).toBe(3);
        expect(window.items.map(({ item }) => item)).toEqual([
            { kind: 'deposit', number: 1, l2Recipient: A, amount: toNano('1') },
            { kind: 'forced', number: 2, bytes: transaction },
            { kind: 'deposit', number: 3, l2Recipient: B, amount: toNano('2') },
        ]);
        // Окно с середины: от отметки 1 и сообщения элемента 1; не больше max.
        const next = await source.read(
            { count: 1, hash: queueStep(0n, window.items[0].item as never) },
            window.items[0].message,
            1,
        );
        expect(next.items.map(({ item }) => item.number)).toEqual([2]);
        // Без курсора — счёт с начала истории: тот же элемент.
        const counted = await source.read(
            { count: 2, hash: queueStep(next.from.hash, next.items[0].item as never) },
            null,
            32,
        );
        expect(counted.items.map(({ item }) => item)).toEqual([window.items[2].item]);
    });

    it('чужая отметка, неверный курсор и подменённое сообщение — остановка с текстом, не пропуск', async () => {
        await expect(
            source.read(
                { count: 1, hash: 5n },
                (await source.read({ count: 0, hash: 0n }, null, 1)).items[0].message,
                2,
            ),
        ).rejects.toThrow('хеш очереди в отметке 1 у контракта');
        await expect(source.read({ count: 1, hash: 0n }, { lt: '0', hash: 'x', number: 2 }, 2)).rejects.toThrow(
            'курсор сообщений',
        );
        await expect(source.read({ count: 9, hash: 0n }, { lt: '0', hash: 'x', number: 9 }, 2)).rejects.toThrow(
            'дальше головы',
        );
        // Подменённое тело принудительной транзакции в перехваченном: шаг хеша не сходится.
        const all = await feed.after(null, 100);
        const tampered = all.map((message) =>
            message.body && parseQueueMessage(message.body, LIMITS).kind === 'forced'
                ? {
                      ...message,
                      body: beginCell()
                          .storeUint(RollupOpcodes.forceTransaction, 32)
                          .storeUint(0, 64)
                          .storeRef(forcedTransactionCell(Buffer.from('02ee', 'hex')))
                          .endCell(),
                  }
                : message,
        );
        const forgedSource = new ContractQueueSource(rollup, { after: async () => tampered }, LIMITS);
        await expect(forgedSource.read({ count: 0, hash: 0n }, null, 32)).rejects.toThrow(
            /элемент очереди №2 .*не сходится с хешем очереди контракта/,
        );
    });

    it('хеши цепочки берутся у контракта и начинаются с хеша в отметке', async () => {
        const queue = await rollup.getDepositQueue();
        const hashes = await chainHashes(rollup, { count: 0, hash: 0n }, 3, { count: 3, hash: queue.head.hash });
        expect(hashes).toHaveLength(4);
        expect(hashes[3]).toBe(queue.head.hash);
    });
});

describe('сборщик блоков: собственный расчёт против программы на блоках цепочки Reth', () => {
    it('11 слов, отметки очереди и фронтир каждого блока цепочки сервис считает сам так же, как программа', () => {
        let tree = { frontier: emptyWithdrawalFrontier(), count: 0n };
        let from = { count: 0, hash: 0n };
        for (const report of rethReports) {
            const block = blockOf(report.blockNumber);
            const segment: QueuedItem[] = rethExpected.queue
                .filter((item) => item.number > block.queueProcessedFrom && item.number <= block.queueProcessedUpTo)
                .map((item) =>
                    item.kind === 'deposit'
                        ? deposit(item.number, item.l2Recipient, BigInt(item.amount))
                        : forced(item.number, hexBytes(item.bytes)),
                );
            // Листья — как из квитанций узла: логи моста.
            const receipts = [
                {
                    logs: rethExpected.withdrawals
                        .filter((leaf) => leaf.block === report.blockNumber)
                        .map((leaf) => ({
                            address: BRIDGE_ADDRESS,
                            topics: [WITHDRAWAL_TOPIC, '0x' + '00'.repeat(12) + 'ab'.repeat(20)],
                            data:
                                '0x' +
                                BigInt(leaf.recipientHash).toString(16).padStart(64, '0') +
                                BigInt(leaf.amount).toString(16).padStart(64, '0'),
                        })),
                },
                { logs: [{ address: '0x' + '22'.repeat(20), topics: [], data: '0x' }] },
            ];
            const expected = expectedPublicValues({
                chainId: BigInt(rethExpected.chainId),
                parentHash: report.blockNumber === 1 ? rethExpected.genesisHash : blockOf(report.blockNumber - 1).hash,
                candidateHash: block.hash,
                timestamp: block.timestamp,
                queueFrom: from,
                segment,
                treeBefore: tree,
                leaves: bridgeLeaves(receipts),
                dataChunks: report.dataChunksHex.map((chunk) => Buffer.from(chunk, 'hex')),
            });
            expect({ block: report.blockNumber, mismatches: reportMismatches(report, expected, from) }).toEqual({
                block: report.blockNumber,
                mismatches: [],
            });
            // Порча любого входа видна: другой хеш родителя, другой лист.
            const inputs = {
                chainId: BigInt(rethExpected.chainId),
                parentHash: block.parentHash,
                candidateHash: block.hash,
                timestamp: block.timestamp,
                queueFrom: from,
                segment,
                treeBefore: tree,
                leaves: bridgeLeaves(receipts),
                dataChunks: report.dataChunksHex.map((chunk) => Buffer.from(chunk, 'hex')),
            };
            for (const broken of [
                { ...inputs, parentHash: block.hash },
                { ...inputs, timestamp: block.timestamp + 1 },
                ...(segment.length > 0 ? [{ ...inputs, segment: segment.slice(1) }] : []),
                { ...inputs, leaves: [...inputs.leaves, { recipientHash: 1n, amount: 1n }] },
                { ...inputs, dataChunks: [] },
            ]) {
                expect(reportMismatches(report, expectedPublicValues(broken), from).length).toBeGreaterThan(0);
            }
            tree = expected.treeAfter;
            from = expected.queue;
        }
        expect(tree.count).toBe(BigInt(rethExpected.withdrawals.length));
    });

    it('лог моста не той формы — исключение, как MalformedBridgeLog в программе', () => {
        const log = {
            address: BRIDGE_ADDRESS,
            topics: [WITHDRAWAL_TOPIC, '0x' + '00'.repeat(32)],
            data: '0x' + '00'.repeat(64),
        };
        expect(bridgeLeaves([{ logs: [log] }])).toEqual([{ recipientHash: 0n, amount: 0n }]);
        expect(() => bridgeLeaves([{ logs: [{ ...log, topics: [WITHDRAWAL_TOPIC] }] }])).toThrow('не той формы');
        expect(() =>
            bridgeLeaves([{ logs: [{ ...log, topics: [WITHDRAWAL_TOPIC, '0x' + '01'.repeat(32)] }] }]),
        ).toThrow('не той формы');
        expect(() => bridgeLeaves([{ logs: [{ ...log, data: '0x' + '00'.repeat(63) }] }])).toThrow('не той формы');
        expect(() => bridgeLeaves([{ logs: [{ ...log, data: '0x' + '00'.repeat(32) + 'ff'.repeat(32) }] }])).toThrow(
            'u128',
        );
        expect(
            appendLeaves({ frontier: emptyWithdrawalFrontier(), count: 0n }, [{ recipientHash: 1n, amount: 2n }]).count,
        ).toBe(1n);
    });
});

describe('сборщик блоков: состояние на диске и разбор отказов', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'sequencer-state-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('состояние переживает запись и чтение: bigint, Buffer, вложенные элементы очереди', () => {
        const state = genesisState(7n);
        state.tip.queue = { count: 3, hash: (1n << 255n) + 5n };
        state.pending = {
            number: 1,
            attempt: 1,
            phase: 'inserted',
            withPool: false,
            forcedCount: 0,
            signers: [A],
            dir,
            request: buildRequest({
                parentHash: GENESIS_HASH,
                timestamp: 1,
                feeRecipient: A,
                credits: [],
                forced: [],
                pool: [],
            }),
            payload: { blockHash: '0x01' } as ExecutionPayload,
            segment: [forced(1, Buffer.from('beef', 'hex')), deposit(2, A, 9n)],
        };
        const store = new StateStore(dir);
        store.save(state);
        const loaded = store.load(7n);
        expect(loaded).toEqual(state);
        expect(Buffer.isBuffer((loaded.pending!.segment[0].item as { bytes: Buffer }).bytes)).toBe(true);
        expect(deserialize(serialize({ value: 2n ** 200n }))).toEqual({ value: 2n ** 200n });
    });

    it('без файла — генезис; файл другой цепочки или версии — отказ', () => {
        const store = new StateStore(dir);
        expect(store.load(7n)).toEqual(genesisState(7n));
        store.save(genesisState(7n));
        expect(() => store.load(8n)).toThrow('цепочки 7');
        writeFileSync(store.file, serialize({ ...genesisState(7n), version: 2 }));
        expect(() => store.load(7n)).toThrow('версии 2');
    });

    it('запись атомарная: временный файл и переименование, прежний файл цел до переименования', () => {
        const file = path.join(dir, 'a', 'b.json');
        writeAtomically(file, 'one');
        writeAtomically(file, 'two');
        expect(readFileSync(file, 'utf8')).toBe('two');
        expect(() => readFileSync(`${file}.tmp`)).toThrow();
    });

    it('причина отказа программы — строка паники хоста, а не обвязка', () => {
        const stderr =
            "thread 'main' panicked at host/src/main.rs:534:43:\nнативный расчёт отверг батч: DepositMismatch(0)\nnote: run with `RUST_BACKTRACE=1`";
        expect(refusalReason({ code: 101, stdout: '', stderr })).toBe(
            'нативный расчёт отверг батч: DepositMismatch(0)',
        );
        expect(
            refusalReason({
                code: 2,
                stdout: '',
                stderr: 'Свидетель не продолжает предыдущий батч: не совпал хеш очереди.\n',
            }),
        ).toContain('не продолжает');
        expect(refusalReason({ code: 9, stdout: '', stderr: '' })).toBe('код выхода 9');
    });
});
