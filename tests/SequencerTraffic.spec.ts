import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { Address, beginCell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { run } from '../scripts/sequencerTraffic';
import { Rollup } from '../wrappers/Rollup';
import { WithdrawalLeaf, withdrawalTree } from '../wrappers/rollupMath';
import { GENESIS_HASH } from '../sequencer/protocol';
import { finalizeDummyKeys, mockProof, readProtocolConstants, testConfig } from './helpers/rollupSetup';
import { sandboxProvider } from './helpers/sandboxProvider';

// Скрипт нагрузки на сервис (scripts/sequencerTraffic.ts) в Sandbox: двойник контракта (пруф —
// заглушка) с ключом-пустышкой, вместо сети — поддельный NetworkProvider и часы. Вместо сервиса —
// «секвенсор» теста: на каждом шаге часов обрабатывает всю очередь L1 батчем двойника, а выводы
// нагрузки кладёт листьями в дерево и пишет отчёты блоков в каталог сервиса (blocks/<N>/report.json)
// — так, как их пишет сервис. Проверяется: план и отказы до отправки, ключи только у счетов для
// вывода (права 600), постановка без дублей и после сбоя, выплаты по Merkle-доказательствам.
// Чего здесь нет: EVM (вывод «исполняет» тест), комиссии кошелька, toncenter.

const mockClock = { now: 0, tick: async (_: number) => undefined as void };
jest.mock('@ton/blueprint', () => ({
    ...jest.requireActual('@ton/blueprint'),
    sleep: async (ms: number) => mockClock.tick(Math.ceil(ms / 1000)),
}));

const WORK = path.join(__dirname, '..', '.tools', 'sequencer-test', 'traffic');
const CHAIN_ID = 362107787851n;
const wallet = new Address(0, Buffer.alloc(32, 0x5a));
const NO_HINTS = beginCell().endCell();

type JournalItem = { kind: string; l2Address: string; number: number | null; keyStored?: boolean; status: string; prev: { count: string } };

describe('Нагрузка на сервис: депозиты, принудительные выводы и выплаты в Sandbox', () => {
    const argv = process.argv;
    let dateNow: jest.SpyInstance;
    let blockchain: Blockchain;
    let rollup: SandboxContract<Rollup>;
    let sequencer: SandboxContract<TreasuryContract>;
    let dir: string;
    const stateDir = () => path.join(dir, 'service');
    const trafficDir = () => path.join(dir, 'traffic');
    const journal = () => {
        const name = readdirSync(trafficDir()).find((file) => file.startsWith('journal-'))!;
        return JSON.parse(readFileSync(path.join(trafficDir(), name), 'utf8')) as { items: JournalItem[]; claims: { status: string }[]; summary: Record<string, unknown> };
    };

    beforeAll(() => {
        process.argv = ['node', 'blueprint', 'run', 'sequencerTraffic', '--testnet', '--mnemonic'];
        dateNow = jest.spyOn(Date, 'now').mockImplementation(() => mockClock.now * 1000);
    });
    afterAll(() => {
        process.argv = argv;
        dateNow.mockRestore();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** Двойник с ключом-пустышкой; «секвенсор» теста обрабатывает очередь на каждом шаге часов. */
    async function setup(balance = toNano('5')) {
        dir = path.join(WORK, randomBytes(4).toString('hex'));
        mkdirSync(dir, { recursive: true });
        blockchain = await Blockchain.create();
        mockClock.now = 1_800_000_000;
        blockchain.now = mockClock.now;
        const code = await compile('RollupMock');
        const nullifierCode = await compile('RollupNullifier');
        const constants = await readProtocolConstants(code, nullifierCode);
        const owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(testConfig(constants, { owner: owner.address, sequencer: sequencer.address, nullifierCode, chainId: CHAIN_ID, escapeTimeout: 21600 }), code),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('0.05'));
        await finalizeDummyKeys(rollup, owner);
        await owner.send({ to: wallet, value: balance, bounce: false });
        const leaves: WithdrawalLeaf[] = [];
        let stateRoot = BigInt(GENESIS_HASH);
        let block = 0;
        const process = async () => {
            const queue = await rollup.getDepositQueue();
            if (queue.head.count === queue.processed.count || !existsSync(trafficDir())) return;
            const items = journal().items;
            const before = leaves.length;
            for (let number = Number(queue.processed.count) + 1; number <= Number(queue.head.count); number++) {
                // Номер ещё не записан, пока скрипт ждёт постановки: элемент встал сразу за своей отметкой.
                const item = items.find((entry) => (entry.number ?? Number(entry.prev.count) + 1) === number && entry.status !== 'lost');
                if (item?.kind === 'withdrawal') leaves.push({ leafIndex: leaves.length, recipientHash: BigInt('0x' + wallet.hash.toString('hex')), amount: toNano('0.05') });
            }
            block++;
            const newStateRoot = BigInt('0x' + randomBytes(32).toString('hex'));
            const root = withdrawalTree(leaves).root;
            const report = {
                blockNumber: block,
                withdrawals: leaves.slice(before).map((leaf) => ({ ...leaf, recipientHash: '0x' + leaf.recipientHash.toString(16), amount: leaf.amount.toString() })),
                publicValues: {
                    prevStateRoot: '0x' + stateRoot.toString(16), newStateRoot: '0x' + newStateRoot.toString(16),
                    prevWithdrawalsCount: String(before), withdrawalsCount: String(leaves.length), withdrawalsRoot: '0x' + root.toString(16),
                },
            };
            mkdirSync(path.join(stateDir(), 'blocks', String(block)), { recursive: true });
            writeFileSync(path.join(stateDir(), 'blocks', String(block), 'report.json'), JSON.stringify(report));
            await rollup.sendSubmitBatch(sequencer.getSender(), {
                proof: mockProof(), hints: NO_HINTS, value: toNano('0.2'),
                roots: { newStateRoot, withdrawalsRoot: root, withdrawalsCount: BigInt(leaves.length), queueProcessedUpTo: queue.head.count, blockTimestamp: BigInt(blockchain.now!) },
            });
            stateRoot = newStateRoot;
        };
        mockClock.tick = async (seconds) => {
            mockClock.now += seconds;
            blockchain.now = mockClock.now;
            await process();
        };
    }
    const args = (extra: string[] = []) => [rollup.address.toString(), 'interval=600', 'duration=3600', 'drain=1800', `stateDir=${stateDir()}`, `trafficDir=${trafficDir()}`, ...extra];
    const balance = async () => (await blockchain.getContract(wallet)).balance;

    it('сутки в миниатюре: депозит, вывод с него, …; очередь обработана, выводы выплачены, ключи — права 600', async () => {
        await setup();
        const started = await balance();
        const traffic = sandboxProvider(blockchain, wallet);
        await run(traffic.provider, args());
        const items = journal().items;
        expect(items.map((item) => item.kind)).toEqual(['deposit', 'withdrawal', 'deposit', 'withdrawal', 'deposit', 'withdrawal']);
        expect(items.map((item) => item.number)).toEqual([1, 2, 3, 4, 5, 6]);
        // Вывод — со счёта своего депозита, после его обработки.
        expect(items[1].l2Address).toBe(items[0].l2Address);
        const queue = await rollup.getDepositQueue();
        expect(queue.head.count).toBe(6n);
        expect(queue.processed.count).toBe(6n);
        expect(journal().claims.map((claim) => claim.status)).toEqual(['paid', 'paid', 'paid']);
        // Sandbox-отправитель не списывает с кошелька: баланс вырос ровно на три выплаты.
        expect((await balance()) - started).toBe(3n * toNano('0.05'));
        const keys = path.join(trafficDir(), 'keys.json');
        expect(statSync(keys).mode & 0o777).toBe(0o600);
        expect((JSON.parse(readFileSync(keys, 'utf8')) as { address: string }[]).map((key) => key.address)).toEqual(items.filter((item) => item.kind === 'deposit').map((item) => item.l2Address));
        const text = traffic.lines.join('\n');
        expect(text).toMatch(/план на 3600 с, действие раз в 600 с: депозитов 3, выводов 3/);
        expect(text).toMatch(/обработано контрактом 6 из 6; ждут 0/);
        expect(text).toMatch(/выплаты по выводам: выплачено 3 \(0\.15 TON\), долг 0, в пути 0/);

        // Повтор законченной нагрузки: новых элементов нет (срок вышел), выплаты не повторяются —
        // даже если журнал не знает об исходе (сбой между Withdraw и записью): лист уже погашен.
        const file = path.join(trafficDir(), readdirSync(trafficDir()).find((name) => name.startsWith('journal-'))!);
        const lost = JSON.parse(readFileSync(file, 'utf8'));
        lost.claims = lost.claims.map((claim: object) => ({ ...claim, status: 'sent', paidAt: null }));
        writeFileSync(file, JSON.stringify(lost));
        const again = sandboxProvider(blockchain, wallet);
        await run(again.provider, args());
        expect(again.sent).toHaveLength(0);
        expect(journal().claims.map((claim) => claim.status)).toEqual(['paid', 'paid', 'paid']);
    }, 300_000);

    it('withdrawEvery=2: ключ хранится только у счетов для вывода; у остальных — один адрес в журнале', async () => {
        await setup();
        await run(sandboxProvider(blockchain, wallet).provider, args(['withdrawEvery=2', 'duration=3000']));
        const deposits = journal().items.filter((item) => item.kind === 'deposit');
        const keys = JSON.parse(readFileSync(path.join(trafficDir(), 'keys.json'), 'utf8')) as { address: string; secret: string }[];
        expect(deposits.length).toBeGreaterThanOrEqual(3);
        expect(keys.map((key) => key.address)).toEqual(deposits.filter((item) => item.keyStored).map((item) => item.l2Address));
        expect(deposits.filter((item) => !item.keyStored).length).toBeGreaterThan(0);
        expect(readFileSync(path.join(trafficDir(), readdirSync(trafficDir()).find((file) => file.startsWith('journal-'))!), 'utf8')).not.toMatch(/secret/);
    }, 300_000);

    it('бюджет: новых элементов не больше, чем в него помещается', async () => {
        await setup();
        const traffic = sandboxProvider(blockchain, wallet);
        await run(traffic.provider, args(['budget=0.25']));
        // Депозит и вывод стоят около 0,075 TON каждый: третий элемент — последний.
        expect(journal().items.map((item) => item.kind)).toEqual(['deposit', 'withdrawal', 'deposit']);
        expect(traffic.lines.join('\n')).toMatch(/Бюджет исчерпан: потрачено 0\.2\d* TON из 0\.25 TON/);
    }, 300_000);

    it('сбой отправки посреди нагрузки: запуск падает, повторный продолжает без дублей', async () => {
        await setup();
        // Отправки: депозит, вывод, Withdraw по его листу, депозит — сбой на нём.
        const broken = sandboxProvider(blockchain, wallet, { failAt: 4 });
        await expect(run(broken.provider, args())).rejects.toThrow('сеть недоступна (сбой, заданный тестом)');
        await run(sandboxProvider(blockchain, wallet).provider, args());
        const items = journal().items;
        // Не ушедшее сообщение помечено «не найдено», а не поставлено вторым.
        expect(items.filter((item) => item.status === 'lost')).toHaveLength(1);
        const queued = items.filter((item) => item.number !== null);
        expect((await rollup.getDepositQueue()).head.count).toBe(BigInt(queued.length));
        expect(new Set(queued.map((item) => item.number)).size).toBe(queued.length);
        expect(journal().claims.every((claim) => claim.status === 'paid')).toBe(true);
    }, 300_000);

    it('заморозка: settle возвращает необработанные депозиты нагрузки; новая нагрузка не начинается', async () => {
        await setup();
        // «Сервис» обработал первые два элемента и пропал.
        const traffic = sandboxProvider(blockchain, wallet);
        await run(traffic.provider, args(['duration=1200', 'drain=0']));
        const processedBefore = Number((await rollup.getDepositQueue()).processed.count);
        const tick = mockClock.tick;
        mockClock.tick = async (seconds) => {
            mockClock.now += seconds;
            blockchain.now = mockClock.now;
        };
        await run(sandboxProvider(blockchain, wallet).provider, args(['duration=3000', 'drain=0']));
        const pending = journal().items.filter((item) => item.number !== null && item.number > processedBefore && item.kind === 'deposit');
        expect(pending.length).toBeGreaterThan(0);
        // Срок вышел — заморозка (кто угодно), затем settle.
        await mockClock.tick(21600 + 60);
        await rollup.sendActivateEscapeHatch(sequencer.getSender(), toNano('0.01'));
        expect((await rollup.getEscapeState()).frozen).toBe(true);
        const before = await balance();
        const settle = sandboxProvider(blockchain, wallet);
        await run(settle.provider, args(['settle']));
        expect((await balance()) - before).toBe(BigInt(pending.length) * toNano('0.06'));
        for (const item of pending) expect(await rollup.getDepositReceipt(item.number!)).toBeNull();
        expect(settle.lines.join('\n')).toMatch(/Возврат необработанного депозита №\d+: 0\.06 TON/);
        // Новая нагрузка на замороженный rollup не начинается.
        expect((await run(sandboxProvider(blockchain, wallet).provider, args()).catch((error: Error) => error.message))).toMatch(/rollup заморожен: очередь закрыта/);
        mockClock.tick = tick;
    }, 300_000);

    it('режим check и отказы: точная причина, ни одной отправки', async () => {
        await setup(toNano('1'));
        const refused = async (extra: string[], who = wallet) => {
            const attempt = sandboxProvider(blockchain, who);
            const error: Error = await run(attempt.provider, args(extra)).then(() => new Error('не отказал'), (reason) => reason);
            expect(attempt.sent).toHaveLength(0);
            return error.message;
        };
        const check = sandboxProvider(blockchain, wallet);
        await run(check.provider, args(['check', 'budget=0.5']));
        expect(check.sent).toHaveLength(0);
        expect(check.lines.join('\n')).toMatch(/Режим check: ничего не отправлено/);
        expect(await refused(['budget=3'])).toMatch(/ничего не отправлено[^]*на кошельке 1 TON, бюджет 3 TON: не хватает 2 TON/);
        expect(await refused(['budget=0.1'])).toMatch(/бюджет 0\.1000 TON меньше одного депозита и одного вывода/);
        expect(await refused(['withdraw=0.04'])).toMatch(/вывод 40000000 нанотон меньше наименьшего 50000000: мост откатит вызов/);
        expect(await refused(['deposit=0.05'])).toMatch(/депозит 50000000 нанотон не покрывает вывод 50000000 и газ L2 80000/);
        expect(await refused([], sequencer.address)).toMatch(/кошелёк нагрузки — кошелёк сервиса/);
        // Не testnet: без --testnet и с --custom скрипт не начинается.
        process.argv = ['node', 'blueprint', 'run', 'sequencerTraffic', '--mainnet', '--mnemonic'];
        expect(await refused([])).toMatch(/только с флагом --testnet/);
        process.argv = ['node', 'blueprint', 'run', 'sequencerTraffic', '--testnet', '--mnemonic', '--custom', 'https://toncenter.com/api/v2/'];
        expect(await refused([])).toMatch(/Флаги --custom запрещены/);
        process.argv = ['node', 'blueprint', 'run', 'sequencerTraffic', '--testnet', '--mnemonic'];
    }, 120_000);
});
