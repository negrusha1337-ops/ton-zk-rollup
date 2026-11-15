import { Address } from '@ton/core';
import { rateLimiter, TestnetQueueSource } from './queue/toncenter';
import { QueueLagError, QueueMismatchError } from './queue/types';

// Сборщик блоков из командной строки (ts-node). В этом шаге — только чтение очереди L1 контракта
// в testnet: отправщика батчей и прувера для сети ещё нет, полный цикл идёт в Sandbox
// (tests/SequencerReth.spec.ts). Ничего не отправляет и ключей не требует; ключ API toncenter —
// из переменной окружения TONCENTER_API_KEY, если задан.
//
//   npx ts-node sequencer/main.ts queue <адрес контракта> [--from=<номер>] [--max=<число>]
//
// Печатает отметки контракта и элементы очереди после отметки (по умолчанию — после
// обработанного контрактом), каждый сверенный с хешем цепочки очереди. Расхождение — код 2,
// отставание индексатора (сообщений ещё нет) — код 3.

const usage = 'npx ts-node sequencer/main.ts queue <адрес контракта> [--from=<номер>] [--max=<число>]';

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
    throw new Error(`команда не указана: ${usage}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(error instanceof QueueMismatchError ? 2 : error instanceof QueueLagError ? 3 : 1);
});
