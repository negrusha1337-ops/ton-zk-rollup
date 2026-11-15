import { Address, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { Blockchain } from '@ton/sandbox';
import { run } from '../scripts/runRethCycleTestnet';
import { loadRethExpected, RETH_PROVEN_BLOCKS, rethProofStatus } from '../wrappers/evmProofs';
import { Rollup } from '../wrappers/Rollup';
import { LATE_DEPOSIT_VALUE, TESTNET_ESCAPE_TIMEOUT_SECONDS, TESTNET_MAX_BLOCK_AGE_SECONDS } from '../wrappers/rollupValues';
import { BASE_DEPOSIT_FEE } from '../wrappers/Rollup';
import { sandboxProvider } from './helpers/sandboxProvider';

// Скрипт прогона полного цикла v2 в testnet (scripts/runRethCycleTestnet.ts), исполненный
// целиком в Sandbox: настоящий контракт, настоящие пруфы блоков Reth, а вместо сети — поддельный
// NetworkProvider (tests/helpers/sandboxProvider.ts) и поддельные часы. Проверяется порядок шагов
// скрипта, возобновление после сбоя отправки, режим escape и отказы предполётной проверки.
// Чего здесь НЕТ и что впервые исполнится только в сети: кошелёк по мнемонике и его комиссии,
// задержки и ошибки API, расхождение часов машины и блоков.

// Часы теста: их двигает подменённый sleep скрипта, по ним же идёт время блоков Sandbox.
const mockClock = { now: 0, tick: (_: number) => undefined as void };
jest.mock('@ton/blueprint', () => ({
    ...jest.requireActual('@ton/blueprint'),
    sleep: async (ms: number) => mockClock.tick(Math.ceil(ms / 1000)),
}));

const expected = loadRethExpected();
const LAST = RETH_PROVEN_BLOCKS[RETH_PROVEN_BLOCKS.length - 1];
const wallet = new Address(0, Buffer.from(expected.exitRecipientHash.replace(/^0x/, ''), 'hex'));
const opensAt = expected.blocks[LAST - 1].timestamp;
const closesAt = expected.blocks[0].timestamp + TESTNET_MAX_BLOCK_AGE_SECONDS;
const leaves = expected.withdrawals.filter((leaf) => leaf.block <= LAST);
const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
const exitsAt = (block: number) => expected.exitsByBlock.find((entry) => entry.block === block)?.exits ?? [];
const exitedAt = (block: number) => sum(exitsAt(block).map((exit) => BigInt(exit.balanceWei) / 1_000_000_000n));
/** Сообщений до приёма батча 1 включительно: развёртывание, части ключа, фиксация, очередь, данные, батч. */
const SENDS_THROUGH_BATCH_1 = 1 + 12 + 1 + expected.blocks[0].headAtBatch + 1 + 1;

describe('Скрипт прогона полного цикла v2: исполнение в Sandbox на настоящих пруфах', () => {
    const argv = process.argv;
    let dateNow: jest.SpyInstance;

    beforeAll(() => {
        const status = rethProofStatus();
        if (!status.current) throw new Error(`пруфы блоков Reth негодны: ${status.reason}`);
        process.argv = ['node', 'blueprint', 'run', 'runRethCycleTestnet', '--testnet', '--mnemonic'];
        dateNow = jest.spyOn(Date, 'now').mockImplementation(() => mockClock.now * 1000);
    });
    afterAll(() => {
        process.argv = argv;
        dateNow.mockRestore();
    });

    /** Новая сеть Sandbox с кошельком прогона на `balance` и часами на `now`. */
    async function setup(now: number, balance = toNano('10')) {
        const blockchain = await Blockchain.create();
        mockClock.now = now;
        blockchain.now = now;
        mockClock.tick = (seconds) => {
            mockClock.now += seconds;
            blockchain.now = mockClock.now;
        };
        const funder = await blockchain.treasury('funder');
        await funder.send({ to: wallet, value: balance, bounce: false });
        const code = await compile('Rollup');
        const rollup = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: wallet, sequencer: wallet, nullifierCode: await compile('RollupNullifier'),
                    genesisStateRoot: BigInt(expected.genesisHash), chainId: BigInt(expected.chainId),
                    escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS, maxBlockAge: TESTNET_MAX_BLOCK_AGE_SECONDS,
                },
                code,
            ),
        );
        const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;
        return { blockchain, rollup, balanceOf, started: await balanceOf(wallet) };
    }

    it('полный путь: развёртывание до окна, ожидание, очередь, три батча, выводы, заморозка, выходы, возврат', async () => {
        const { blockchain, rollup, balanceOf, started } = await setup(opensAt - 600);
        const first = sandboxProvider(blockchain, wallet);
        await run(first.provider, []);
        expect(first.lines.join('\n')).toMatch(/Жду открытия окна/);
        expect(first.lines[first.lines.length - 2]).toMatch(/^Готово: очередь L1, три батча/);
        expect(await rollup.getRollupState()).toMatchObject({ batchIndex: LAST, withdrawalsCount: BigInt(leaves.length) });
        expect((await rollup.getEscapeState()).frozen).toBe(true);
        // Очередь — элементы цепочки по порядку и поздний депозит; батчи приняты в окне.
        const queue = await rollup.getDepositQueue();
        expect(queue.head.count).toBe(BigInt(expected.blocks[LAST - 1].headAtBatch + 1));
        expect(queue.processed.count).toBe(BigInt(expected.blocks[LAST - 1].queueProcessedUpTo));
        // Кошелёк Sandbox не платит за отправку: его баланс вырос ровно на выплаты — каждый лист
        // моста, оба счёта против блока 3 и поздний депозит за вычетом платы за место.
        const paid = sum(leaves.map((leaf) => BigInt(leaf.amount))) + exitedAt(LAST) + LATE_DEPOSIT_VALUE - BASE_DEPOSIT_FEE;
        expect(leaves).toHaveLength(5);
        expect(exitsAt(LAST)).toHaveLength(2);
        expect((await balanceOf(wallet)) - started).toBe(paid);
        // Сообщений — столько, сколько считает разбивка потребности.
        expect(first.lines.join('\n')).toContain(`(${first.sent.length} сообщений)`);

        // Повторный запуск законченного прогона ничего не отправляет и ничего не платит дважды.
        const again = sandboxProvider(blockchain, wallet);
        await run(again.provider, []);
        expect(again.sent).toHaveLength(0);
        expect((await balanceOf(wallet)) - started).toBe(paid);
    });

    it('сбой отправки посреди очереди: запуск останавливается, повторный продолжает с того же шага', async () => {
        const { blockchain, rollup, balanceOf, started } = await setup(opensAt + 60);
        // Сбой на четвёртом элементе очереди батча 2.
        const failAt = SENDS_THROUGH_BATCH_1 + 4;
        const broken = sandboxProvider(blockchain, wallet, { failAt });
        await expect(run(broken.provider, [])).rejects.toThrow(/Обычный путь остановился \(принято батчей: 1 из 3\): сеть недоступна[^]*запусти скрипт ещё раз/);
        expect(broken.sent).toHaveLength(failAt - 1);
        const head = (await rollup.getDepositQueue()).head.count;
        expect(head).toBe(BigInt(expected.blocks[0].headAtBatch + 3));

        const resumed = sandboxProvider(blockchain, wallet);
        await run(resumed.provider, [rollup.address.toString()]);
        expect((await rollup.getRollupState()).batchIndex).toBe(LAST);
        // Ни один элемент не поставлен дважды: всего отправок — как в прогоне без сбоя.
        const queue = await rollup.getDepositQueue();
        expect(queue.head.count).toBe(BigInt(expected.blocks[LAST - 1].headAtBatch + 1));
        expect(resumed.lines.join('\n')).toContain(`(${broken.sent.length + resumed.sent.length} сообщений)`);
        const paid = sum(leaves.map((leaf) => BigInt(leaf.amount))) + exitedAt(LAST) + LATE_DEPOSIT_VALUE - BASE_DEPOSIT_FEE;
        expect((await balanceOf(wallet)) - started).toBe(paid);
    });

    it('режим escape после батча 1: заморозка по сроку, возврат необработанного депозита, выход — если есть согласие', async () => {
        const { blockchain, rollup, balanceOf, started } = await setup(opensAt + 60);
        // Сбой после двух принудительных транзакций батча 2: в хвосте очереди депозит и они.
        const broken = sandboxProvider(blockchain, wallet, { failAt: SENDS_THROUGH_BATCH_1 + 3 });
        await expect(run(broken.provider, [])).rejects.toThrow(/принято батчей: 1 из 3/);
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
        // Ещё один депозит кошелька — ПОСЛЕ принудительных: возврат обязан дойти и до него.
        const extra = toNano('0.2');
        await rollup.sendDeposit(sandboxProvider(blockchain, wallet).provider.sender(), { l2Recipient: 0xbeefn, value: extra + BASE_DEPOSIT_FEE });

        const escape = sandboxProvider(blockchain, wallet);
        await run(escape.provider, ['escape']);
        expect((await rollup.getEscapeState()).frozen).toBe(true);
        expect(escape.lines[escape.lines.length - 2]).toMatch(/^Готово \(режим escape\)/);
        // Заморозка — не раньше срока от самого старого необработанного элемента.
        expect(mockClock.now).toBeGreaterThan(opensAt + TESTNET_ESCAPE_TIMEOUT_SECONDS);
        // Необработанные депозиты (всё, что стояло в очереди после отметки батча 1) возвращены.
        const pending = expected.queue.slice(expected.blocks[0].queueProcessedUpTo, expected.blocks[0].headAtBatch + 2);
        expect(pending.map((item) => item.kind)).toEqual(['deposit', 'forced', 'forced']);
        const refunded = sum(pending.map((item) => (item.kind === 'deposit' ? BigInt(item.amount) : 0n))) + extra;
        // Счета выходят против блока 1, только если цепочка несёт согласие на него (16-2).
        if (exitsAt(1).length === 0) expect(escape.lines.join('\n')).toMatch(/Против блока 1 согласий на выход в цепочке нет/);
        expect((await balanceOf(wallet)) - started).toBe(refunded + exitedAt(1));
        // Обычный путь после заморозки закрыт — и скрипт говорит это до любой отправки.
        const after = sandboxProvider(blockchain, wallet);
        await expect(run(after.provider, [])).rejects.toThrow(/ничего не отправлено[^]*rollup уже заморожен/);
        expect(after.sent).toHaveLength(0);
    });

    it('16-2: если к батчу 1 окно уже не вместит остальные, батч не отправляется, а депозиты возвращает escape', async () => {
        const { blockchain, rollup, balanceOf, started } = await setup(opensAt + 60);
        // «Сеть» зависает на публикации данных батча 1: до закрытия окна остаётся меньше, чем нужно на батчи 2 и 3.
        const stalled = sandboxProvider(blockchain, wallet, {
            beforeSend: (index) => {
                if (index === SENDS_THROUGH_BATCH_1 - 1) mockClock.tick(1500);
            },
        });
        await expect(run(stalled.provider, [])).rejects.toThrow(/принято батчей: 0 из 3\): Батч 1 НЕ отправлен: [^]*до закрытия \d+ с, а на путь/);
        expect(stalled.sent).toHaveLength(SENDS_THROUGH_BATCH_1 - 1);
        expect((await rollup.getRollupState()).batchIndex).toBe(0);
        // Ни один депозит не обработан: аварийный путь возвращает оба целиком.
        const escape = sandboxProvider(blockchain, wallet);
        await run(escape.provider, ['escape']);
        const deposits = expected.queue.slice(0, expected.blocks[0].headAtBatch).map((item) => (item.kind === 'deposit' ? BigInt(item.amount) : 0n));
        expect(sum(deposits)).toBeGreaterThan(0n);
        expect((await balanceOf(wallet)) - started).toBe(sum(deposits));
    });

    it('предполётные отказы: до любой отправки и с названной причиной', async () => {
        const refused = async (now: number, balance: bigint, args: string[], owner = wallet) => {
            const { blockchain } = await setup(now, balance);
            const attempt = sandboxProvider(blockchain, owner);
            const error: Error = await run(attempt.provider, args).then(
                () => new Error('скрипт не отказал'),
                (reason) => reason,
            );
            expect(attempt.sent).toHaveLength(0);
            return error.message;
        };
        expect(await refused(opensAt + 60, toNano('3'), [])).toMatch(/ничего не отправлено[^]*не хватает/);
        // Чужой кошелёк: выплаты ушли бы не ему.
        const stranger = new Address(0, Buffer.alloc(32, 7));
        expect(await refused(opensAt + 60, toNano('10'), [], stranger)).toMatch(/получатель: согласия на аварийный выход[^]*получатель: выводы через мост/);
        // Окно: слишком рано для заданного ожидания, слишком поздно для пути, закрыто.
        expect(await refused(opensAt - 3600, toNano('10'), [])).toMatch(/больше, чем задано ждать/);
        expect(await refused(closesAt - 300, toNano('10'), [])).toMatch(/до закрытия 300 с, а на путь/);
        expect(await refused(closesAt + 10, toNano('10'), [])).toMatch(/окно закрыто 10 с назад/);
        // Параметры развёртывания вне границ контракта и непонятные аргументы.
        expect(await refused(opensAt + 60, toNano('10'), ['maxBlockAge=600'])).toMatch(/параметры стенда: возраст блока/);
        expect(await refused(opensAt + 60, toNano('10'), ['pace=abc'])).toMatch(/целое число секунд/);
        expect(await refused(opensAt + 60, toNano('10'), ['escape'])).toMatch(/контракт не развёрнут/);
    });

    it('режим check печатает разбивку и окно и ничего не отправляет', async () => {
        const { blockchain } = await setup(opensAt + 60);
        const check = sandboxProvider(blockchain, wallet);
        await run(check.provider, ['check']);
        expect(check.sent).toHaveLength(0);
        const text = check.lines.join('\n');
        expect(text).toMatch(/Потребность кошелька на весь путь/);
        expect(text).toMatch(/ИТОГО нужно [\d.]+ TON; вернётся [\d.]+ TON; не вернётся [\d.]+ TON/);
        expect(text).toMatch(/Время: окно батчей/);
        expect(text).toMatch(/Режим check: ничего не отправлено/);
    });
});
