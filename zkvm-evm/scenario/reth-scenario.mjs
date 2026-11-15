// Сценарий на настоящем узле Reth: депозиты с L1 → блоки EVM → входы батчей и доказательство
// счёта для аварийного выхода (фикстуры fixtures/evm_batches/reth/).
//
//   node zkvm-evm/scenario/reth-scenario.mjs [адрес получателя выплат в TON]
//
// С адресом вывод через мост и оба аварийных выхода идут этому получателю (кошелёк будущего
// прогона в testnet: согласие подписывается одноразовым ключом, переподписать его потом нельзя).
// Без адреса получатели — ничьи адреса, годные только для Sandbox.
//
// Чем он отличается от anvil-scenario.sh. Генезис — с ПУСТЫМ состоянием: все монеты L2
// появляются только из депозитов (REVIEW.md, 9-А). Блоки собирает сам сценарий через Engine API,
// без клиента консенсуса: депозиты идут в блок зачислениями EIP-4895. Состояние для программы
// штатный rsp берёт одним запросом debug_executionWitness (режим --state-backend
// execution-witness), а не eth_getProof.
//
// Блоки подобраны под правила очереди контракта: батч k обрабатывает то, что стояло в очереди
// L1 на момент батча k−1.
//   депозит 1 (счёт пользователя) → блок 1, пустой → депозит 2 → блок 2: зачисление депозита 1
//   → блок 3: зачисление депозита 2, перевод и вывод через мост от пользователя
//   → блок 4: пользователь создаёт контракт с тремя слотами хранилища
//   → блок 5: контракт обнуляет один слот (REVIEW.md, 7-1).
// Блок 5 — форма из находки 7-1: слоты подобраны так, что после удаления ключа в корневой ветке
// дерева хранилища остаётся единственный потомок — ветка, и чтобы свернуть корень, её надо
// раскрыть. Сценарий показывает, что свидетель узла её раскрывает и программа блок принимает;
// что режим eth_getProof на таком блоке отказал бы, он НЕ проверяет.
// Номер зачисления — его место в блоке, с нуля: Reth принимает любые номера, программа — нет.
//
// Ключ пользователя одноразовый (cast wallet new) и в файлы не попадает, поэтому каждый запуск
// даёт новую цепочку и меняет фикстуры целиком. Ключ передаётся cast аргументом командной строки
// (виден в списке процессов и в тексте ошибки cast) — как в zk/gen-evm-exit-fixture.mjs, REVIEW.md, 9-З.
// Блок становится головой и финальным сразу, а наш хост проверяет его уже после: недоказуемый
// блок сценарий только обнаружит (и откажет), но не откатит. Инструменты вне репозитория (PROVING.md):
// reth v2.2.0, cast (Foundry), rsp на коммите 5afe72eb; хост — zkvm-evm/target/release.
// Нагрузка: узел, пять исполнений блока в zkVM штатным rsp и пять — нашим хостом, по одному.
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import tonCore from '@ton/core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = process.env.EVM_TOOLS ?? path.join(ROOT, '.tools');
const RETH = process.env.RETH ?? path.join(TOOLS, 'reth', 'bin', 'reth');
const CAST = process.env.CAST ?? path.join(TOOLS, 'foundry', 'bin', 'cast');
const RSP = process.env.RSP ?? path.join(TOOLS, 'rsp', 'target', 'release', 'rsp');
const HOST = process.env.EVM_HOST ?? path.join(ROOT, 'zkvm-evm', 'target', 'release', 'rollup-evm-host');
const WORK = path.join(TOOLS, 'evm-spike', 'reth');
const FIXTURES = path.join(ROOT, 'fixtures', 'evm_batches', 'reth');
// Фикстуры собираются в рабочем каталоге и переносятся целиком в самом конце: сбой на середине
// не оставит в репозитории смесь двух цепочек.
const OUT = path.join(WORK, 'fixtures');
/** ELF программы, под который выведен ключ контракта (fixtures/evm_batches/program.json). */
const PROGRAM = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'evm_batches', 'program.json'), 'utf8'));
const CHAIN_ID = 362107787851n;
const HTTP_PORT = 8548;
const AUTH_PORT = 8552;
const HTTP = `http://127.0.0.1:${HTTP_PORT}`;
const AUTH = `http://127.0.0.1:${AUTH_PORT}`;
/** Адрес моста: 20 байт строки «ton-zk-rollup-bridge» (BRIDGE_ADDRESS в zkvm-evm/lib). */
const BRIDGE = '0x' + Buffer.from('ton-zk-rollup-bridge').toString('hex');
const ZERO = '0x' + '00'.repeat(32);
/** Депозиты в нанотонах (= gwei): что зачтётся на L2. */
const USER_DEPOSIT = 500_000_000n;
const OTHER_DEPOSIT = 300_000_000n;
const TRANSFER_TO = '0x' + '22'.repeat(20);
const TRANSFER_WEI = 10_000_000_000_000_000n;
/** Вывод через мост: 0,1 монеты. */
const WITHDRAW_WEI = 100_000_000_000_000_000n;
/** Получатель выплат в TON (basechain): заданный кошелёк либо ничьи адреса для Sandbox. */
const payoutTo = process.argv[2] ? tonCore.Address.parse(process.argv[2]) : null;
if (payoutTo && payoutTo.workChain !== 0) throw new Error('получатель выплат обязан быть в basechain');
const WITHDRAW_RECIPIENT = payoutTo ? '0x' + payoutTo.hash.toString('hex') : '0x' + '11'.repeat(32);
// Слоты 5 и 11: keccak ключей начинаются с одного полубайта (0) и расходятся на втором — под
// корнем хранилища они дают ветку. Слот 2 — в другом полубайте (4): его и обнуляем.
const KEPT_SLOTS = [5, 11];
const DELETED_SLOT = 2;
// Контракт: конструктор пишет единицу в три слота; код — «обнулить слот из первых 32 байт данных»
// (PUSH1 0, PUSH1 0, CALLDATALOAD, SSTORE, STOP).
const RUNTIME = '60006000355500';
const INIT = [...KEPT_SLOTS, DELETED_SLOT].map((slot) => `6001${'60' + slot.toString(16).padStart(2, '0')}55`).join('');
const CREATE_CODE = `0x${INIT}6007${'60' + (INIT.length / 2 + 12).toString(16).padStart(2, '0')}6000396007${'6000'}f3${RUNTIME}`;
/** Метка согласия на аварийный выход — как EVM_EXIT_TAG в contracts/rollup/evm_exit.tolk. */
const TAG = Buffer.from('ton-zk-rollup:evm-exit:v1');
const ETH_PREFIX = Buffer.from('\x19Ethereum Signed Message:\n32');

const hex = (bytes) => '0x' + Buffer.from(bytes).toString('hex');
const bytes = (value) => Buffer.from(value.replace(/^0x/, ''), 'hex');
const keccak = (...parts) => Buffer.from(keccak_256(Buffer.concat(parts)));
const word = (value) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
const quantity = (value) => '0x' + BigInt(value).toString(16);
const fail = (message) => {
    throw new Error(message);
};
const cast = (...args) => execFileSync(CAST, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** cast 1.9 часть ответов заворачивает в конверт {schema_version, success, data}. */
const unwrap = (answer) => (answer && typeof answer === 'object' && 'schema_version' in answer ? answer.data : answer);

// --- JSON-RPC: обычный и Engine API (под JWT) ---
const secret = randomBytes(32);
const b64 = (value) => Buffer.from(value).toString('base64url');
const jwt = () => {
    const body = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iat: Math.floor(Date.now() / 1000) }))}`;
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
};
async function call(url, method, params) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(url === AUTH ? { authorization: `Bearer ${jwt()}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const answer = await response.json();
    if (answer.error) fail(`${method}: ${JSON.stringify(answer.error)}`);
    return answer.result;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Собирает следующий блок: зачисления `credits` (депозиты; номер — место в блоке) и всё, что
 * лежит в пуле транзакций. Роль клиента консенсуса: начать сборку, забрать блок, принять его,
 * сделать головой цепочки.
 */
async function buildBlock(credits) {
    const head = await call(HTTP, 'eth_getBlockByNumber', ['latest', false]);
    const withdrawals = credits.map(({ address, amount }, index) => ({
        index: quantity(index),
        validatorIndex: '0x0',
        address,
        amount: quantity(amount),
    }));
    const timestamp = quantity(Math.max(Number(head.timestamp) + 1, Math.floor(Date.now() / 1000)));
    const at = (hash) => ({ headBlockHash: hash, safeBlockHash: hash, finalizedBlockHash: hash });
    const started = await call(AUTH, 'engine_forkchoiceUpdatedV3', [
        at(head.hash),
        { timestamp, prevRandao: ZERO, suggestedFeeRecipient: '0x' + '00'.repeat(20), withdrawals, parentBeaconBlockRoot: ZERO },
    ]);
    if (started.payloadStatus.status !== 'VALID' || !started.payloadId) fail(`сборка блока не началась: ${JSON.stringify(started)}`);
    await sleep(1500);
    const payload = (await call(AUTH, 'engine_getPayloadV3', [started.payloadId])).executionPayload;
    const status = await call(AUTH, 'engine_newPayloadV3', [payload, [], ZERO]);
    if (status.status !== 'VALID') fail(`узел не принял собранный блок: ${JSON.stringify(status)}`);
    const done = await call(AUTH, 'engine_forkchoiceUpdatedV3', [at(payload.blockHash), null]);
    if (done.payloadStatus.status !== 'VALID') fail(`блок не стал головой цепочки: ${JSON.stringify(done)}`);
    return payload;
}

const run = (binary, args, logFile) => {
    try {
        const output = execFileSync('nice', ['-n', '15', binary, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, SP1_PROVER: 'mock', RAYON_NUM_THREADS: '4' },
            maxBuffer: 64 * 1024 * 1024,
        });
        writeFileSync(logFile, output);
    } catch (error) {
        writeFileSync(logFile, `${error.stdout ?? ''}\n${error.stderr ?? ''}`);
        fail(`${path.basename(binary)} завершился с ошибкой: см. ${logFile}`);
    }
};

// --- узел ---
for (const port of [HTTP_PORT, AUTH_PORT]) {
    let busy = true;
    try {
        await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: '{}' });
    } catch (error) {
        busy = false;
    }
    if (busy) fail(`порт ${port} занят: на нём уже кто-то отвечает`);
}
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });
const genesisFile = path.join(WORK, 'genesis.json');
// Правила — по Cancun с нулевого блока (как зашито в программе), счетов в генезисе нет.
const forks = ['homestead', 'daoFork', 'eip150', 'eip155', 'eip158', 'byzantium', 'constantinople', 'petersburg', 'istanbul', 'muirGlacier', 'berlin', 'london'];
writeFileSync(
    genesisFile,
    JSON.stringify(
        {
            config: {
                chainId: Number(CHAIN_ID),
                ...Object.fromEntries(forks.map((fork) => [`${fork}Block`, 0])),
                daoForkSupport: true,
                mergeNetsplitBlock: 0,
                terminalTotalDifficulty: '0',
                terminalTotalDifficultyPassed: true,
                shanghaiTime: 0,
                cancunTime: 0,
            },
            nonce: '0x0',
            timestamp: '0x0',
            extraData: '0x',
            gasLimit: '0x1c9c380',
            difficulty: '0x0',
            mixHash: ZERO,
            coinbase: '0x' + '00'.repeat(20),
            baseFeePerGas: '0x3b9aca00',
            alloc: {},
        },
        null,
        2,
    ),
);
writeFileSync(path.join(WORK, 'jwt.hex'), secret.toString('hex'));
const version = execFileSync(RETH, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
const node = spawn(
    RETH,
    [
        'node', '--chain', genesisFile, '--datadir', path.join(WORK, 'data'),
        '--http', '--http.port', String(HTTP_PORT), '--http.api', 'eth,debug,net,web3,txpool',
        '--authrpc.port', String(AUTH_PORT), '--authrpc.jwtsecret', path.join(WORK, 'jwt.hex'),
        '--port', '30399', '--disable-discovery', '--ipcdisable', '--max-outbound-peers', '0',
        '--rpc.eth-proof-window', '1000', '--log.file.directory', path.join(WORK, 'logs'),
    ],
    { stdio: 'ignore' },
);
process.on('exit', () => node.kill());
// Остановка по сигналу (тайм-аут, Ctrl-C) тоже обязана погасить узел.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(1));

try {
    for (let attempt = 0; ; attempt++) {
        try {
            await call(HTTP, 'eth_blockNumber', []);
            break;
        } catch (error) {
            if (attempt > 100) fail('reth не поднялся');
            await sleep(200);
        }
    }
    if (BigInt(await call(HTTP, 'eth_chainId', [])) !== CHAIN_ID) fail('на порту отвечает узел другой цепочки');
    const genesis = await call(HTTP, 'eth_getBlockByNumber', ['0x0', false]);
    // Корень пустого дерева: в генезисе действительно нет ни одного счёта.
    if (genesis.stateRoot !== '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421') fail('состояние генезиса не пусто');

    // --- цепочка ---
    const wallet = unwrap(JSON.parse(cast('wallet', 'new', '--json')))[0];
    const key = wallet.private_key ?? wallet.privateKey;
    const user = wallet.address.toLowerCase();
    if (!key || !user) fail('cast wallet new не выдал ключ и адрес');
    // Второй счёт только получает депозит и ничего не делает: его баланс — ровно депозит.
    const otherWallet = unwrap(JSON.parse(cast('wallet', 'new', '--json')))[0];
    const otherKey = otherWallet.private_key ?? otherWallet.privateKey;
    const other = otherWallet.address.toLowerCase();
    const deposits = [
        { l2Recipient: user, amount: USER_DEPOSIT },
        { l2Recipient: other, amount: OTHER_DEPOSIT },
    ];
    const credit = ({ l2Recipient, amount }) => ({ address: l2Recipient, amount });
    const blocks = [await buildBlock([]), await buildBlock([credit(deposits[0])])];
    const send = (nonce, to, value, data) =>
        cast(
            'send', '--async', '--private-key', key, '--nonce', String(nonce), '--gas-limit', '100000',
            '--gas-price', '2000000000', '--priority-gas-price', '1000000000', '--value', value.toString(), '--rpc-url', HTTP,
            to, ...(data ? [data] : []),
        );
    send(0, TRANSFER_TO, TRANSFER_WEI);
    const bridgeTx = send(1, BRIDGE, WITHDRAW_WEI, WITHDRAW_RECIPIENT);
    for (let attempt = 0; BigInt((await call(HTTP, 'txpool_status', [])).pending) < 2n; attempt++) {
        if (attempt > 50) fail('транзакции пользователя не дошли до пула');
        await sleep(200);
    }
    blocks.push(await buildBlock([credit(deposits[1])]));
    if (blocks[2].transactions.length !== 2) fail('в блок 3 попали не обе транзакции');
    for (const hash of [bridgeTx]) {
        const receipt = await call(HTTP, 'eth_getTransactionReceipt', [hash]);
        if (receipt?.status !== '0x1') fail('перевод на мост не состоялся');
    }
    // Блоки 4 и 5: контракт с хранилищем и обнуление слота рядом с веткой (7-1).
    const waitPending = async (count) => {
        for (let attempt = 0; BigInt((await call(HTTP, 'txpool_status', [])).pending) < count; attempt++) {
            if (attempt > 50) fail('транзакция не дошла до пула');
            await sleep(200);
        }
    };
    const createTx = cast('send', '--async', '--private-key', key, '--nonce', '2', '--gas-limit', '300000', '--gas-price', '2000000000',
        '--priority-gas-price', '1000000000', '--rpc-url', HTTP, '--create', CREATE_CODE);
    await waitPending(1n);
    blocks.push(await buildBlock([]));
    const created = await call(HTTP, 'eth_getTransactionReceipt', [createTx]);
    if (created?.status !== '0x1' || !created.contractAddress) fail('контракт не создан');
    const storageContract = created.contractAddress;
    const slotAt = (slot, block) => call(HTTP, 'eth_getStorageAt', [storageContract, quantity(slot), block]);
    for (const slot of [...KEPT_SLOTS, DELETED_SLOT]) if (BigInt(await slotAt(slot, '0x4')) !== 1n) fail('слот контракта не записан');
    const clearTx = send(3, storageContract, 0n, '0x' + DELETED_SLOT.toString(16).padStart(64, '0'));
    await waitPending(1n);
    blocks.push(await buildBlock([]));
    if ((await call(HTTP, 'eth_getTransactionReceipt', [clearTx]))?.status !== '0x1') fail('обнуление слота не состоялось');
    if (BigInt(await slotAt(DELETED_SLOT, '0x5')) !== 0n) fail('слот не обнулён');
    for (const slot of KEPT_SLOTS) if (BigInt(await slotAt(slot, '0x5')) !== 1n) fail('соседние слоты изменились');
    // Форма дерева хранилища до удаления: в корневой ветке ровно два потомка, и сосед удаляемого
    // ключа — ветка. Иначе блок 5 не тот случай, ради которого он заведён.
    const slotKey = (slot) => keccak(word(BigInt(slot)));
    if (new Set(KEPT_SLOTS.map((slot) => slotKey(slot)[0] >> 4)).size !== 1 || slotKey(DELETED_SLOT)[0] >> 4 === slotKey(KEPT_SLOTS[0])[0] >> 4) {
        fail('слоты подобраны неверно: сосед удаляемого ключа не ветка');
    }

    // --- входы батчей: свидетель от узла штатным rsp, затем наш хост (исполнение в zkVM без пруфа) ---
    const queue = [[], [deposits[0]], [deposits[1]], [], []];
    const withdrawalLeaf = { recipientHash: WITHDRAW_RECIPIENT, amount: (WITHDRAW_WEI / 1_000_000_000n).toString() };
    let depositHash = ZERO;
    const reports = [];
    for (let number = 1; number <= blocks.length; number++) {
        run(RSP, [
            '--block-number', String(number), '--rpc-url', HTTP, '--genesis-path', genesisFile,
            '--cache-dir', path.join(WORK, 'cache'), '--report-path', path.join(WORK, 'rsp-report.csv'),
            '--state-backend', 'execution-witness',
        ], path.join(WORK, `rsp-block-${number}.log`));
        const witness = path.join(WORK, `witness-${number}.json`);
        writeFileSync(witness, JSON.stringify({
            prevDepositHash: depositHash,
            deposits: queue[number - 1].map(({ l2Recipient, amount }) => ({ l2Recipient, amount: amount.toString() })),
            // Дерево выводов программа пересчитывает целиком: вывод блока 3 — прежний лист для блоков 4 и 5.
            priorWithdrawals: number > 3 ? [withdrawalLeaf] : [],
        }));
        run(HOST, [
            '--block-input', path.join(WORK, 'cache', 'input', CHAIN_ID.toString(), `${number}.bin`), '--chain-id', CHAIN_ID.toString(),
            '--witness', witness, '--execute',
            '--write-input', path.join(OUT, `block-${number}.bin`), '--report', path.join(OUT, `block-${number}.json`),
        ], path.join(WORK, `host-block-${number}.log`));
        const report = JSON.parse(readFileSync(path.join(OUT, `block-${number}.json`), 'utf8'));
        if (report.publicValues.newStateRoot !== blocks[number - 1].blockHash) fail(`блок ${number}: программа коммитит не хеш блока со слов узла`);
        // Хост обязан нести тот же ELF, под который выведен ключ контракта: устаревший бинарник
        // дал бы фикстуры от прежней программы.
        if (report.programElfSha256.replace(/^0x/, '') !== PROGRAM.programElfSha256.replace(/^0x/, '')) fail('хост собран с другим ELF, чем записан в fixtures/evm_batches/program.json');
        depositHash = report.publicValues.newDepositHash;
        reports.push(report);
    }

    // --- аварийные выходы обоих счетов против блока 3: eth_getProof и подпись согласия ---
    const blockHash = bytes(blocks[2].blockHash);
    const recipientHash = payoutTo ? payoutTo.hash : keccak(Buffer.from('evm-exit-recipient-reth'));
    const consent = keccak(TAG, word(CHAIN_ID), blockHash, recipientHash);
    const exits = [];
    for (const [account, secretKey] of [[user, key], [other, otherKey]]) {
        const proof = await call(HTTP, 'eth_getProof', [account, [], '0x3']);
        const signature = cast('wallet', 'sign', '--private-key', secretKey, hex(consent));
        const raw = bytes(signature);
        const point = secp256k1.Signature.fromBytes(raw.subarray(0, 64), 'compact')
            .addRecoveryBit(raw[64] - 27)
            .recoverPublicKey(keccak(ETH_PREFIX, consent))
            .toBytes(false);
        if (hex(keccak(Buffer.from(point).subarray(1)).subarray(12)) !== account) fail('подпись согласия не восстанавливается в адрес счёта');
        if (!keccak(bytes(proof.accountProof[0])).equals(bytes(blocks[2].stateRoot))) fail('доказательство счёта не от корня состояния блока 3');
        exits.push({ account, balanceWei: BigInt(proof.balance).toString(), accountProof: proof.accountProof, signature });
    }
    if (BigInt(exits[1].balanceWei) !== OTHER_DEPOSIT * 1_000_000_000n) fail('баланс второго счёта — не его депозит');

    writeFileSync(
        path.join(OUT, 'expected.json'),
        JSON.stringify(
            {
                source: `Сгенерировано zkvm-evm/scenario/reth-scenario.mjs (${version}); не редактировать вручную`,
                note: 'Цепочка узла Reth с пустым генезисом: депозиты с L1 зачислениями EIP-4895, перевод и вывод через мост. Ключ пользователя одноразовый и в файл не попадает.',
                chainId: CHAIN_ID.toString(),
                genesisHash: genesis.hash,
                blocks: blocks.map((block, index) => ({
                    number: index + 1,
                    hash: block.blockHash,
                    stateRoot: block.stateRoot,
                    transactions: block.transactions.length,
                    zkvmCycles: reports[index].zkvmCycles,
                })),
                user,
                // Очередь L1 в порядке постановки и номер батча, который обязан обработать элемент.
                deposits: deposits.map(({ l2Recipient, amount }, index) => ({ l2Recipient, amount: amount.toString(), batch: index + 2 })),
                withdrawal: { leafIndex: 0, ...withdrawalLeaf },
                storageDeletion: { block: 5, contract: storageContract.toLowerCase(), deletedSlot: DELETED_SLOT, keptSlots: KEPT_SLOTS },
                transferWei: TRANSFER_WEI.toString(),
                // Аварийные выходы против блока 3: согласие обоих счетов — одному получателю.
                exitBlock: 3,
                exitRecipient: payoutTo ? payoutTo.toString({ testOnly: true }) : null,
                exitRecipientHash: hex(recipientHash),
                consentHash: hex(consent),
                exits,
            },
            null,
            1,
        ) + '\n',
    );
    rmSync(FIXTURES, { recursive: true, force: true });
    cpSync(OUT, FIXTURES, { recursive: true });
    console.log(`Записано: fixtures/evm_batches/reth/ — блоки 1–5 (${reports.map((report) => report.zkvmCycles).join(', ')} циклов), выходы: ${exits.map((exit) => `${exit.account} — ${exit.balanceWei} wei`).join(', ')}`);
} finally {
    node.kill();
}
