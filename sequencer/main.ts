import path from 'path';
import { Address, fromNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { loadEvmRollupKey, loadRethExpected } from '../wrappers/evmProofs';
import { RollupNullifier } from '../wrappers/RollupNullifier';
import { BATCH_COST_ESTIMATE, check, defaultTools, DEFAULT_RETH, DEFAULT_STATE_DIR, MIN_WALLET_BALANCE, run, TestnetOptions } from './testnet';
import { resolveDeployChainId, usedChainIds } from './chainId';
import { DEFAULT_ESCAPE_TIMEOUT, DEFAULT_MAX_BLOCK_AGE, deploy, networkForwardPrices, serviceCommands } from './deploy';
import { rateLimiter, TestnetQueueSource } from './queue/toncenter';
import { QueueLagError, QueueMismatchError } from './queue/types';
import { serviceWallet, ServiceEnv, takeServiceEnv } from './serviceEnv';
import { onSnapshot, rollupOn, ToncenterChain } from './ton';
import { claimProofCell, recipientHashOf, withdrawalClaims } from './withdrawals';

// Сборщик блоков из командной строки (ts-node). Только testnet. Окружение — .env проекта (читается
// сам, без печати; переменная окружения процесса главнее) и окружение процесса (serviceEnv.ts):
// кошелёк сервиса — ТОЛЬКО SEQUENCER_MNEMONIC и SEQUENCER_WALLET_VERSION; WALLET_MNEMONIC — кошелёк
// прогонов, сервис его не берёт (тот же ключ — отказ); обе пары удаляются из process.env в начале
// любой команды. Ключ API toncenter — TONCENTER_API_KEY (по желанию).
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
//
//   npx ts-node sequencer/main.ts address
//       testnet-адрес кошелька сервиса (для пополнения); сети не касается;
//   npx ts-node sequencer/main.ts deploy [--escape-timeout=21600] [--max-block-age=3600]
//       [--proof-time=1800] [--state-dir=<каталог>] [--chain-id=<число>] [--dry-run]
//       развернуть rollup v2 кошельком сервиса (владелец и секвенсор — он), загрузить ключ,
//       chainId — --chain-id или случайный 40-битный, не бывший в прогонах (sequencer/chainId.ts),
//       записан в <каталог>/deploy-chain.json (и при --dry-run): повтор возьмёт его же;
//       сверить развёртывание и напечатать команды check и run; возобновляемо. --dry-run — всё
//       посчитать и проверить, ничего не слать. Отказ — код 1 и причина;
//   npx ts-node sequencer/main.ts withdrawals <адрес контракта> [--state-dir=<каталог>] [--recipient=<адрес TON>]
//       листья дерева выводов по отчётам блоков сервиса, сверенные с контрактом, их
//       доказательства (BOC) и погашены ли; ничего не отправляет.
// Подробности — sequencer/README.md, «Сервис против контракта в testnet», и TESTNET.md.

const usage = 'npx ts-node sequencer/main.ts address|deploy|queue|check|run|withdrawals [параметры] (sequencer/README.md)';

/** Флаги вида --имя=значение (или --имя) с проверкой на известные имена. */
function flagsOf(args: string[], known: string[]): Map<string, string> {
    const flags = new Map(args.filter((arg) => arg.startsWith('--')).map((arg) => {
        const [name, value] = arg.slice(2).split('=', 2);
        return [name, value ?? ''] as const;
    }));
    for (const name of flags.keys()) if (!known.includes(name)) throw new Error(`непонятный параметр --${name}: ${usage}`);
    return flags;
}

const seconds = (flags: Map<string, string>, name: string, fallback: number) => {
    const value = flags.get(name);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new Error(`--${name} — целое число секунд, получено «${value}»`);
    return Number(value);
};

async function deployCommand(args: string[], env: ServiceEnv) {
    if (args.some((arg) => !arg.startsWith('--'))) throw new Error(`deploy не принимает адреса: адрес выводится из кошелька и параметров (${usage})`);
    const flags = flagsOf(args, ['escape-timeout', 'max-block-age', 'proof-time', 'state-dir', 'dry-run', 'chain-id']);
    const params = {
        escapeTimeout: seconds(flags, 'escape-timeout', DEFAULT_ESCAPE_TIMEOUT),
        maxBlockAge: seconds(flags, 'max-block-age', DEFAULT_MAX_BLOCK_AGE),
        expectedProofTime: seconds(flags, 'proof-time', 1800),
    };
    const stateDir = path.resolve(flags.get('state-dir') || DEFAULT_STATE_DIR);
    const apiKey = env.values.TONCENTER_API_KEY;
    const chain = new ToncenterChain({ apiKey, limit: rateLimiter(apiKey ? 9 : 1) });
    const wallet = await serviceWallet(env);
    // Свой chainId у каждого развёртывания (круг 23, пункт 2): записан в каталоге до первой отправки.
    const chainId = resolveDeployChainId({ stateDir, flag: flags.has('chain-id') ? flags.get('chain-id') : undefined, used: usedChainIds(), log: print });
    const result = await deploy({
        chain,
        wallet,
        stateDir,
        params,
        dryRun: flags.has('dry-run'),
        log: print,
        code: await compile('Rollup'),
        nullifierCode: await compile('RollupNullifier'),
        key: loadEvmRollupKey(),
        chainSource: { chainId: chainId.toString(), genesisHash: loadRethExpected().genesisHash },
        forward: networkForwardPrices(),
        reserve: MIN_WALLET_BALANCE,
    });
    print(`батч стоит около ${fromNano(BATCH_COST_ESTIMATE)} TON: на сутки при батче в час — около ${fromNano(24n * BATCH_COST_ESTIMATE)} TON на кошельке сервиса`);
    if (result.status === 'dry-run') return;
    print(result.status === 'already' ? 'Готово: контракт был развёрнут раньше, сверка пройдена.' : `Готово: развёрнуто, отправлено ${result.sent} сообщений.`);
    print('Дальше (TESTNET.md, «Секвенсор как сервис»):');
    for (const line of serviceCommands(result.address, params, stateDir, DEFAULT_STATE_DIR)) print(`  ${line}`);
}

async function addressCommand(args: string[], env: ServiceEnv) {
    if (args.length > 0) throw new Error(`address не принимает параметров: ${usage}`);
    const wallet = await serviceWallet(env);
    console.log(`Кошелёк сервиса (${wallet.version}), testnet:`);
    console.log(`  для пополнения (non-bounceable): ${wallet.address.toString({ testOnly: true, bounceable: false })}`);
    console.log(`  он же (bounceable):              ${wallet.address.toString({ testOnly: true })}`);
    console.log(`  raw:                             ${wallet.address.toRawString()}`);
}

async function withdrawalsCommand(args: string[], env: ServiceEnv) {
    const positional = args.filter((arg) => !arg.startsWith('--'));
    if (positional.length !== 1) throw new Error(`ожидается один адрес контракта: ${usage}`);
    const flags = flagsOf(args, ['state-dir', 'recipient']);
    const address = Address.parse(positional[0]);
    const stateDir = path.resolve(flags.get('state-dir') || DEFAULT_STATE_DIR);
    const recipient = flags.has('recipient') ? recipientHashOf(Address.parse(flags.get('recipient')!)) : null;
    const apiKey = env.values.TONCENTER_API_KEY;
    const chain = new ToncenterChain({ apiKey, limit: rateLimiter(apiKey ? 9 : 1) });
    const snapshot = await chain.account(address);
    const on = rollupOn(address, snapshot);
    const state = await on((rollup) => rollup.getRollupState());
    const claims = withdrawalClaims(stateDir, state);
    console.log(`Контракт ${address.toString({ testOnly: true })}: батчей ${state.batchIndex}, листьев ${claims.length}; дерево по отчётам ${stateDir}/blocks сверено с контрактом.`);
    for (const claim of claims) {
        if (recipient !== null && claim.recipientHash !== recipient) continue;
        const nullifier = await on((rollup) => rollup.getNullifierAddress(claim.leafIndex));
        const account = await chain.account(nullifier);
        const claimed = account.state === 'active' && (await onSnapshot(RollupNullifier.createFromAddress(nullifier), account, (opened) => opened.getIsClaimed()));
        console.log(
            `  лист ${claim.leafIndex} (блок ${claim.block}): ${fromNano(claim.amount)} TON → 0:${claim.recipientHash.toString(16).padStart(64, '0')}, ` +
                `${claimed ? 'погашен' : 'НЕ погашен'}; доказательство (BOC): ${claimProofCell(claim).toBoc().toString('base64')}`,
        );
    }
}

function serviceOptions(args: string[], env: ServiceEnv): TestnetOptions {
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
        apiKey: env.values.TONCENTER_API_KEY,
        reth: DEFAULT_RETH,
        tools: defaultTools(),
        ports: { http: number('http-port', 8645), auth: number('auth-port', 8651), p2p: number('p2p-port', 30403) },
        expectedProofTime: number('proof-time', 1800),
        includePool: flags.has('include-pool'),
        pollSeconds: number('poll', 30),
        env,
    };
}

const print = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function queue(args: string[], env: ServiceEnv) {
    const positional = args.filter((arg) => !arg.startsWith('--'));
    const options = Object.fromEntries(
        args.filter((arg) => arg.startsWith('--')).map((arg) => arg.slice(2).split('=')),
    );
    if (positional.length !== 1) throw new Error(`ожидается один адрес контракта: ${usage}`);
    for (const key of Object.keys(options))
        if (!['from', 'max'].includes(key) || !/^\d+$/.test(options[key] ?? ''))
            throw new Error(`непонятный аргумент --${key}: ${usage}`);
    const address = Address.parse(positional[0]);
    const apiKey = env.values.TONCENTER_API_KEY;
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
    // До любой команды: окружение сервиса снято, обе пары кошельков из process.env удалены.
    const env = takeServiceEnv();
    if (command === 'address') return addressCommand(rest, env);
    if (command === 'deploy') return deployCommand(rest, env);
    if (command === 'withdrawals') return withdrawalsCommand(rest, env);
    if (command === 'queue') return queue(rest, env);
    if (command === 'check') {
        if (!(await check(serviceOptions(rest, env), print))) process.exit(1);
        return;
    }
    if (command === 'run') process.exit(await run(serviceOptions(rest, env), print));
    throw new Error(`команда не указана: ${usage}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(error instanceof QueueMismatchError ? 2 : error instanceof QueueLagError ? 3 : 1);
});
