import path from 'path';
import { Address } from '@ton/core';
import { check, defaultTools, DEFAULT_RETH, DEFAULT_STATE_DIR, run, TestnetOptions } from './testnet';
import { rateLimiter, TestnetQueueSource } from './queue/toncenter';
import { QueueLagError, QueueMismatchError } from './queue/types';

// Сборщик блоков из командной строки (ts-node). Только testnet; ключ API toncenter — из
// TONCENTER_API_KEY (по желанию), кошелёк секвенсора — WALLET_MNEMONIC и WALLET_VERSION.
//
//   npx ts-node sequencer/main.ts queue <адрес контракта> [--from=<номер>] [--max=<число>]
//       очередь L1 контракта, каждый элемент сверен с хешем цепочки; ничего не отправляет и ключей
//       не требует. Расхождение — код 2, отставание индексатора — код 3;
//   npx ts-node sequencer/main.ts check <адрес контракта> --fee-recipient=0x… [параметры]
//       проверить всё (сеть, контракт, ключ, хост, прувер, кошелёк, время, узел) и ничего не слать;
//   npx ts-node sequencer/main.ts run <адрес контракта> --fee-recipient=0x… [параметры]
//       сервис: узел reth, очередь, LocalProver, TestnetSubmitter. Остановка, где нужен человек, — код 2.
// Параметры check и run: --state-dir=<каталог> (.tools/sequencer), --proof-time=<с> (1800),
// --poll=<с> (30), --http-port, --auth-port, --p2p-port (8645, 8651, 30403), --include-pool.
// Подробности — sequencer/README.md, «Сервис против контракта в testnet».

const usage = 'npx ts-node sequencer/main.ts queue|check|run <адрес контракта> [параметры] (sequencer/README.md)';

function serviceOptions(args: string[]): TestnetOptions {
    const positional = args.filter((arg) => !arg.startsWith('--'));
    if (positional.length !== 1) throw new Error(`ожидается один адрес контракта: ${usage}`);
    const flags = new Map(args.filter((arg) => arg.startsWith('--')).map((arg) => {
        const [name, value] = arg.slice(2).split('=', 2);
        return [name, value ?? ''] as const;
    }));
    const known = ['fee-recipient', 'state-dir', 'proof-time', 'poll', 'http-port', 'auth-port', 'p2p-port', 'include-pool'];
    for (const name of flags.keys()) if (!known.includes(name)) throw new Error(`непонятный параметр --${name}: ${usage}`);
    const number = (name: string, fallback: number) => {
        const value = flags.get(name);
        if (value === undefined) return fallback;
        if (!/^\d+$/.test(value)) throw new Error(`--${name} — целое число, получено «${value}»`);
        return Number(value);
    };
    const feeRecipient = flags.get('fee-recipient') ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(feeRecipient)) throw new Error('нужен --fee-recipient=0x… — адрес секвенсора на L2 (получатель чаевых)');
    return {
        rollup: Address.parse(positional[0]),
        feeRecipient,
        stateDir: path.resolve(flags.get('state-dir') || DEFAULT_STATE_DIR),
        apiKey: process.env.TONCENTER_API_KEY || undefined,
        reth: DEFAULT_RETH,
        tools: defaultTools(),
        ports: { http: number('http-port', 8645), auth: number('auth-port', 8651), p2p: number('p2p-port', 30403) },
        expectedProofTime: number('proof-time', 1800),
        includePool: flags.has('include-pool'),
        pollSeconds: number('poll', 30),
    };
}

const print = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function queue(args: string[]) {
    const positional = args.filter((arg) => !arg.startsWith('--'));
    const options = Object.fromEntries(
        args.filter((arg) => arg.startsWith('--')).map((arg) => arg.slice(2).split('=')),
    );
    if (positional.length !== 1) throw new Error(`ожидается один адрес контракта: ${usage}`);
    for (const key of Object.keys(options))
        if (!['from', 'max'].includes(key) || !/^\d+$/.test(options[key] ?? ''))
            throw new Error(`непонятный аргумент --${key}: ${usage}`);
    const address = Address.parse(positional[0]);
    const apiKey = process.env.TONCENTER_API_KEY || undefined;
    // Пределы «змейки» и отрезка — у самого контракта.
    const limit = rateLimiter(apiKey ? 9 : 1);
    const probe = new TestnetQueueSource(address, { maxForcedTxCells: 0, maxForcedTxBytes: 0 }, { apiKey, limit });
    const limits = await probe.contract.getQueueLimits();
    const source = new TestnetQueueSource(address, limits, { apiKey, limit, allowBelowProcessed: true });
    const marks = await source.contract.getDepositQueue();
    const from = options.from !== undefined ? Number(options.from) : Number(marks.processed.count);
    const known = new Map([
        [0, 0n],
        [Number(marks.processed.count), marks.processed.hash],
        [Number(marks.head.count), marks.head.hash],
    ]);
    const hashAt = known.get(from) ?? (await source.contract.getQueueItem(from + 1))?.hashBefore;
    if (hashAt === undefined)
        throw new QueueMismatchError(`у контракта нет записи об элементе ${from + 1}: хеш в отметке ${from} не узнать`);
    const window = await source.read(
        { count: from, hash: hashAt },
        null,
        Number(options.max ?? limits.maxBatchQueueItems),
    );
    console.log(
        `Контракт ${address.toString({ testOnly: true })}: поставлено ${window.head.count}, обработано ${window.processed.count}; предел отрезка ${limits.maxBatchQueueItems}.`,
    );
    for (const { item, message } of window.items) {
        const what =
            item.kind === 'deposit'
                ? `депозит ${item.amount} нанотон → ${item.l2Recipient}`
                : `принудительная, ${item.bytes.length} байт, 0x${item.bytes.toString('hex').slice(0, 24)}…`;
        console.log(`  №${item.number}: ${what} (lt ${message.lt})`);
    }
    console.log(`Сверено с хешем цепочки очереди контракта: ${window.items.length} элементов после отметки ${from}.`);
}

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    if (command === 'queue') return queue(rest);
    if (command === 'check') {
        if (!(await check(serviceOptions(rest), print))) process.exit(1);
        return;
    }
    if (command === 'run') process.exit(await run(serviceOptions(rest), print));
    throw new Error(`команда не указана: ${usage}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(error instanceof QueueMismatchError ? 2 : error instanceof QueueLagError ? 3 : 1);
});
