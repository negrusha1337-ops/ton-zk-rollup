// Сценарий протокола версии 2 на настоящем узле Reth: очередь L1 (депозиты и принудительные
// транзакции) → блоки EVM → входы батчей, исполнение в zkVM без пруфа и доказательства счетов для
// аварийного выхода (фикстуры fixtures/evm_batches/reth/).
//
//   node zkvm-evm/scenario/reth-scenario.mjs [адрес получателя выплат в TON]
//
// С адресом выводы через мост и аварийные выходы обоих счетов идут этому получателю (кошелёк
// будущего прогона в testnet: согласие подписывается одноразовым ключом, переподписать его потом
// нельзя). Без адреса получатель — ничей адрес, годный только для Sandbox.
//
// Генезис закреплён протоколом (zkvm-evm/lib/src/genesis.rs): один счёт — мост-предустановка
// (код, nonce 1, баланс 0), время 0, лимит газа 30 млн. Все монеты L2 — только из депозитов.
//
// Блоки собирает сам сценарий: testing_buildBlockV1 (транзакции в заданном порядке, лимит газа
// родителя, пустой extraData) → engine_newPayloadV3 → engine_forkchoiceUpdatedV3. Узлу отдаются
// только транзакции, которые программа включит; ответ сверяется со списком транзакция в
// транзакцию — узел выбрасывает негодные молча. Что из очереди включается, а что пропускается и
// почему, сценарий знает по построению, а ПРОВЕРЯЕТ это нативный запуск самой программы (хост):
// отчёт хоста о каждом элементе очереди сверяется с ожиданием. Настоящему сборщику блоков
// список пропусков надо получать от программы ДО сборки — этого сценарий не делает.
//
// Состояние для программы штатный rsp берёт одним запросом debug_executionWitness. Счета
// отправителей пропущенных принудительных транзакций блок не трогает, и в свидетеле узла их нет:
// сценарий берёт eth_getProof этих счетов на блоке-родителе, а хост дополняет ими свидетель.
// На блоке 3 сценарий показывает, что без дополнения хост отказывает.
//
// Цепочка (номер элемента очереди L1 — с единицы):
//   блок 1  — родитель — генезис; зачисление депозита 1 (счёт A); в очереди уже два элемента, блок
//             обрабатывает один (N < head);
//   блок 2  — депозит 2 (счёт B), принудительный вывод включён, пропуски: мусор, nonce выше, дубль
//             (nonce ниже), отправителя нет в дереве (в том числе тот, кому в этом же блоке
//             зачисляется депозит); транзакции секвенсора: перевод, вывод через мост, создание
//             четырёх контрактов;
//   блок 3  — прежние корень и счётчик выводов ненулевые; пропуски по каждой причине формы и по
//             каждой достижимой причине revm; включённые принудительные: откат моста, вывод ровно
//             на минимум, нехватка газа; транзакции секвенсора: два вывода из контракта L2 одной
//             транзакцией, вывод во внутреннем откатившемся кадре, DELEGATECALL в мост, вызов
//             моста не по форме;
//   блок 4  — контракт обнуляет слот рядом с веткой (REVIEW.md, 7-1); отрезок очереди пуст;
//   блок 5  — обнуление слота под расширением: корень хранилища сворачивается в лист;
//   блок 6  — пустой (точка отсчёта для замера циклов);
//   блок 7  — полный отрезок: MAX_BATCH_QUEUE_ITEMS принудительных выводов, все включены;
//   блок 8  — полный отрезок принудительных, пропущенных revm (nonce выше);
//   блок 9  — полный отрезок депозитов на новые счета;
//   блок 10 — полный отрезок мусора;
//   блок 11 — принудительная транзакция счёта, которого нет в дереве, а путь к его месту
//             свидетель узла не раскрывает (отсутствие доказывает только дополнение);
//   блок 12 — полный отрезок самых длинных принудительных транзакций, какие принимает контракт
//             (8 128 байт): пропущены по длине, без разбора (FORCED_TX_MAX_BYTES).
//
// Ключи счетов одноразовые, создаются в памяти и никуда не пишутся: каждый запуск даёт новую
// цепочку и меняет фикстуры целиком. Блок становится головой сразу, а хост проверяет его уже
// после: недоказуемый блок сценарий только обнаружит (и откажет), но не откатит.
// Инструменты вне репозитория (PROVING.md): reth v2.2.0, rsp на коммите 5afe72eb; хост —
// zkvm-evm/target/release. Нагрузка: узел, исполнение каждого блока в zkVM штатным rsp и нашим
// хостом, строго по одному.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import tonCore from '@ton/core';
import { evmSourcesSha256 } from '../../zk/evm-binding.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = process.env.EVM_TOOLS ?? path.join(ROOT, '.tools');
const RETH = process.env.RETH ?? path.join(TOOLS, 'reth', 'bin', 'reth');
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
const ZERO = '0x' + '00'.repeat(32);
const GWEI = 1_000_000_000n;

// --- константы протокола: обязаны совпадать с zkvm-evm/lib (сверяются ниже с узлом и хостом) ---
/** Адрес моста: 20 байт строки «ton-zk-rollup-bridge» (BRIDGE_ADDRESS). */
const BRIDGE = '0x' + Buffer.from('ton-zk-rollup-bridge').toString('hex');
/** keccak-256 от «Withdrawal(address,bytes32,uint256)» (WITHDRAWAL_TOPIC). */
const WITHDRAWAL_TOPIC = '0x' + Buffer.from(keccak_256(Buffer.from('Withdrawal(address,bytes32,uint256)'))).toString('hex');
/** Код моста (BRIDGE_CODE в zkvm-evm/lib/src/bridge.rs, там же разбор по шагам). */
const BRIDGE_CODE =
    '0x36602018605357' + '633b9aca003406605357' + '633b9aca003404806302faf08011605357' + '602052600035600052' +
    '337f' + WITHDRAWAL_TOPIC.slice(2) + '60406000a200' + '5b60006000fd';
/** Хеш заголовка генезиса (GENESIS_HASH в zkvm-evm/lib/src/genesis.rs и в контракте). */
const GENESIS_HASH = '0xc0284e91570e7f1314f6e4460a613225f49b46deeebd2be3c463fb1c1e0e7883';
const GAS_LIMIT = 30_000_000n;
const FORCED_TX_GAS_CAP = 40_000n;
const MAX_BATCH_QUEUE_ITEMS = 32;
/** Наибольшая длина принудительной транзакции: 64 ячейки по 127 байт (MAX_FORCED_TX_CELLS контракта). */
const MAX_FORCED_TX_BYTES = 64 * 127;
/** Предел длины принудительной транзакции в программе (FORCED_TX_MAX_BYTES в zkvm-evm/lib). */
const FORCED_TX_MAX_BYTES_PROGRAM = 256;
/** Наименьший вывод: 0,05 монеты, в нанотонах. */
const MIN_WITHDRAWAL = 50_000_000n;

/** Депозиты в нанотонах (= gwei): что зачтётся на L2. */
const USER_DEPOSIT = 3_000_000_000n;
const OTHER_DEPOSIT = 300_000_000n;
const TRANSFER_TO = '0x' + '22'.repeat(20);
const TRANSFER_WEI = 10_000_000n * GWEI;
/** Получатель выплат в TON (basechain): заданный кошелёк либо ничей адрес для Sandbox. */
const payoutTo = process.argv[2] ? tonCore.Address.parse(process.argv[2]) : null;
if (payoutTo && payoutTo.workChain !== 0) throw new Error('получатель выплат обязан быть в basechain');
// Слоты 5 и 11: keccak ключей начинаются с одного полубайта (0) и расходятся на втором — под
// корнем хранилища они дают ветку. Слот 2 — в другом полубайте (4): его и обнуляем первым.
const KEPT_SLOTS = [5, 11];
const DELETED_SLOT = 2;
/** Метка согласия на аварийный выход — как EVM_EXIT_TAG в contracts/rollup/evm_exit.tolk. */
const TAG = Buffer.from('ton-zk-rollup:evm-exit:v1');
const ETH_PREFIX = Buffer.from('\x19Ethereum Signed Message:\n32');

const hex = (bytes) => '0x' + Buffer.from(bytes).toString('hex');
const bytes = (value) => Buffer.from(value.replace(/^0x/, ''), 'hex');
const keccak = (...parts) => Buffer.from(keccak_256(Buffer.concat(parts)));
const word = (value) => Buffer.from(BigInt(value).toString(16).padStart(64, '0'), 'hex');
const quantity = (value) => '0x' + BigInt(value).toString(16);
const fail = (message) => {
    throw new Error(message);
};
const WITHDRAW_RECIPIENT = payoutTo ? hex(payoutTo.hash) : hex(keccak(Buffer.from('ton-zk-rollup-payout-nobody')));

// --- RLP и подписанные транзакции ---
/** Целое как байты RLP: без ведущих нулей, ноль — пустая строка. */
const int = (value) => {
    const text = BigInt(value).toString(16);
    return value === 0n || value === 0 ? Buffer.alloc(0) : Buffer.from(text.length % 2 ? '0' + text : text, 'hex');
};
const lengthPrefix = (length, offset) => {
    if (length < 56) return Buffer.from([offset + length]);
    const size = int(length);
    return Buffer.concat([Buffer.from([offset + 55 + size.length]), size]);
};
/** RLP: массив — список, Buffer — строка. */
const rlp = (item) => {
    if (Array.isArray(item)) {
        const payload = Buffer.concat(item.map(rlp));
        return Buffer.concat([lengthPrefix(payload.length, 0xc0), payload]);
    }
    if (item.length === 1 && item[0] < 0x80) return item;
    return Buffer.concat([lengthPrefix(item.length, 0x80), item]);
};
const ORDER = secp256k1.Point.Fn.ORDER;

function newAccount() {
    const secret = secp256k1.utils.randomSecretKey();
    const address = hex(keccak(Buffer.from(secp256k1.getPublicKey(secret, false)).subarray(1)).subarray(12));
    return { secret, address };
}
/** Подпись хеша: r, s и номер восстановления. С `highS` — та же подпись с s в верхней половине. */
function signHash(account, hash, highS = false) {
    const signature = secp256k1.Signature.fromBytes(secp256k1.sign(hash, account.secret, { prehash: false, format: 'recovered' }), 'recovered');
    return highS
        ? { r: signature.r, s: ORDER - signature.s, recovery: signature.recovery ^ 1 }
        : { r: signature.r, s: signature.s, recovery: signature.recovery };
}
/**
 * Подписанная транзакция в кодировке EIP-2718. Типы 0 (EIP-155), 1, 2; типы 3 и 4 — только как
 * байты для очереди L1 (программа их пропускает, узлу они не отдаются).
 */
/** Кем подписаны байты транзакции (по байтам): чьё доказательство счёта нужно хосту. */
const signerOf = new Map();
function signTransaction(account, fields, options = {}) {
    const raw = encodeSigned(account, fields, options);
    signerOf.set(hex(raw), account.address);
    return raw;
}
function encodeSigned(account, fields, options) {
    const {
        type = 2, chainId = CHAIN_ID, nonce, gas, to = null, value = 0n, data = '0x',
        gasPrice = 2n * GWEI, maxFee = 2n * GWEI, maxPriority = GWEI,
    } = fields;
    const target = to === null ? Buffer.alloc(0) : bytes(to);
    const input = bytes(data);
    if (type === 0) {
        const base = [int(nonce), int(gasPrice), int(gas), target, int(value), input];
        const signed = options.noChainId ? base : [...base, int(chainId), int(0), int(0)];
        const { r, s, recovery } = signHash(account, keccak(rlp(signed)), options.highS);
        const v = options.noChainId ? 27n + BigInt(recovery) : chainId * 2n + 35n + BigInt(recovery);
        return rlp([...base, int(v), int(r), int(s)]);
    }
    const payload = {
        1: [int(chainId), int(nonce), int(gasPrice), int(gas), target, int(value), input, []],
        2: [int(chainId), int(nonce), int(maxPriority), int(maxFee), int(gas), target, int(value), input, []],
        // EIP-4844: наибольшая цена blob-газа и один хеш блоба.
        3: [int(chainId), int(nonce), int(maxPriority), int(maxFee), int(gas), target, int(value), input, [], int(GWEI), [Buffer.concat([Buffer.from([1]), Buffer.alloc(31, 7)])]],
        // EIP-7702: одно делегирование (chainId, адрес, nonce, yParity, r, s).
        4: [int(chainId), int(nonce), int(maxPriority), int(maxFee), int(gas), target, int(value), input, [], [[int(chainId), Buffer.alloc(20, 9), int(0), int(0), int(1), int(1)]]],
    }[type];
    const prefix = Buffer.from([type]);
    const { r, s, recovery } = signHash(account, keccak(prefix, rlp(payload)), options.highS);
    return Buffer.concat([prefix, rlp([...payload, int(recovery), int(r), int(s)])]);
}
/** Адрес контракта, созданного счётом `sender` транзакцией с этим nonce. */
const contractAddress = (sender, nonce) => hex(keccak(rlp([bytes(sender), int(nonce)])).subarray(12));

// --- маленький ассемблер EVM: мнемоники, PUSH с числом и метки ---
const OPCODES = {
    STOP: 0x00, SUB: 0x03, DIV: 0x04, EQ: 0x14, ISZERO: 0x15, ADDRESS: 0x30, CALLVALUE: 0x34, CALLDATALOAD: 0x35,
    CALLDATASIZE: 0x36, CODECOPY: 0x39, POP: 0x50, MLOAD: 0x51, MSTORE: 0x52, SSTORE: 0x55, JUMPI: 0x57, GAS: 0x5a,
    JUMPDEST: 0x5b, CALL: 0xf1, RETURN: 0xf3, DELEGATECALL: 0xf4, REVERT: 0xfd,
};
/**
 * Строки: мнемоника; число — PUSH1 с этим байтом; `0x…` из 40 цифр — PUSH20; `@имя` — PUSH1 со
 * смещением метки; `имя:` — JUMPDEST с меткой.
 */
function assemble(lines) {
    const out = [];
    const labels = {};
    const fixups = [];
    for (const line of lines) {
        if (typeof line === 'number') out.push(0x60, line);
        else if (line.startsWith('0x')) out.push(0x73, ...bytes(line));
        else if (line.startsWith('@')) {
            fixups.push([out.length + 1, line.slice(1)]);
            out.push(0x60, 0);
        } else if (line.endsWith(':')) {
            labels[line.slice(0, -1)] = out.length;
            out.push(OPCODES.JUMPDEST);
        } else out.push(OPCODES[line] ?? fail(`неизвестная мнемоника ${line}`));
    }
    for (const [at, label] of fixups) out[at] = labels[label] ?? fail(`нет метки ${label}`);
    if (out.length > 255) fail('код длиннее 255 байт: метки — PUSH1');
    return Buffer.from(out);
}
/** Код создания: скопировать код контракта из хвоста и вернуть его. */
const creation = (runtime) =>
    hex(Buffer.concat([Buffer.from([0x60, runtime.length, 0x60, 12, 0x60, 0, 0x39, 0x60, runtime.length, 0x60, 0, 0xf3]), runtime]));
/** Вызов моста из памяти[0..32] с суммой, которую оставляют на стеке `valueLines`. */
const callBridge = (valueLines) => [0, 0, 0x20, 0, ...valueLines, BRIDGE, 'GAS', 'CALL'];
const loadRecipient = [0, 'CALLDATALOAD', 0, 'MSTORE'];
// Два вывода одной транзакцией: четверть суммы и остаток, оба — тому же получателю.
const SPLITTER = assemble([
    ...loadRecipient,
    ...callBridge([4, 'CALLVALUE', 'DIV']), 'ISZERO', '@fail', 'JUMPI',
    ...callBridge([4, 'CALLVALUE', 'DIV', 'CALLVALUE', 'SUB']), 'ISZERO', '@fail', 'JUMPI',
    'STOP',
    'fail:', 0, 0, 'REVERT',
]);
// Вывод во внутреннем откатившемся кадре. Снаружи (32 байта данных) контракт вызывает себя с 33
// байтами и всей суммой; внутренний кадр вызывает мост, а потом откатывается, вернув признак
// успеха вызова моста. Наружный кадр пишет этот признак в слот 0 и завершается успешно: лог моста
// был записан и стёрт откатом, транзакция при этом успешна.
const REVERTER = assemble([
    'CALLDATASIZE', 0x21, 'EQ', '@inner', 'JUMPI',
    ...loadRecipient,
    0x20, 0x40, 0x21, 0, 'CALLVALUE', 'ADDRESS', 'GAS', 'CALL', 'POP',
    0x40, 'MLOAD', 0, 'SSTORE',
    'STOP',
    'inner:',
    ...loadRecipient,
    ...callBridge(['CALLVALUE']),
    0, 'MSTORE',
    0x20, 0, 'REVERT',
]);
// DELEGATECALL в мост: код моста исполняется от имени этого контракта, лог пишется с ЕГО адреса,
// монеты остаются на нём. Признак успеха — в слот 0. Код кончается БЕЗ STOP: исполнение
// «проваливается за конец кода» — на этом тест проверяет, что программа исполняет только
// байты, покрытые хешем кода (REVIEW.md, 6-1).
const DELEGATOR = assemble([...loadRecipient, 0, 0, 0x20, 0, BRIDGE, 'GAS', 'DELEGATECALL', 0, 'SSTORE']);
// Контракт с хранилищем: конструктор пишет единицу в три слота; код — «обнулить слот из первых
// 32 байт данных» (PUSH1 0, PUSH1 0, CALLDATALOAD, SSTORE, STOP).
const STORAGE_RUNTIME = '60006000355500';
const STORAGE_INIT = [...KEPT_SLOTS, DELETED_SLOT].map((slot) => `6001${'60' + slot.toString(16).padStart(2, '0')}55`).join('');
const STORAGE_CREATE = `0x${STORAGE_INIT}6007${'60' + (STORAGE_INIT.length / 2 + 12).toString(16).padStart(2, '0')}6000396007${'6000'}f3${STORAGE_RUNTIME}`;

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

/** Получатель чаевых — счёт секвенсора: настоящий адрес, а не ноль (иначе чаевые сгорают). */
const sequencer = newAccount();

/**
 * Собирает следующий блок: зачисления `credits` (депозиты; номер — место в блоке) и ровно
 * транзакции `transactions` в этом порядке. Узел негодные транзакции выбрасывает молча —
 * поэтому ответ сверяется со списком байт в байт.
 */
async function buildBlock(credits, transactions) {
    const head = await call(HTTP, 'eth_getBlockByNumber', ['latest', false]);
    const withdrawals = credits.map(({ address, amount }, index) => ({
        index: quantity(index),
        validatorIndex: '0x0',
        address,
        amount: quantity(amount),
    }));
    const timestamp = quantity(Math.max(Number(head.timestamp) + 1, Math.floor(Date.now() / 1000)));
    const at = (hash) => ({ headBlockHash: hash, safeBlockHash: hash, finalizedBlockHash: hash });
    const raw = transactions.map((transaction) => hex(transaction));
    const envelope = await call(HTTP, 'testing_buildBlockV1', [{
        parentBlockHash: head.hash,
        payloadAttributes: { timestamp, prevRandao: ZERO, suggestedFeeRecipient: sequencer.address, withdrawals, parentBeaconBlockRoot: ZERO },
        transactions: raw,
    }]);
    const payload = envelope.executionPayload;
    if (payload.transactions.length !== raw.length || payload.transactions.some((transaction, index) => transaction !== raw[index])) {
        fail(`блок ${Number(head.number) + 1}: узел включил не те транзакции (${payload.transactions.length} из ${raw.length})`);
    }
    if (BigInt(payload.gasLimit) !== GAS_LIMIT || payload.extraData !== '0x' || payload.prevRandao !== ZERO) fail('узел собрал блок с другими закреплёнными полями заголовка');
    const status = await call(AUTH, 'engine_newPayloadV3', [payload, [], ZERO]);
    if (status.status !== 'VALID') fail(`узел не принял собранный блок: ${JSON.stringify(status)}`);
    const done = await call(AUTH, 'engine_forkchoiceUpdatedV3', [at(payload.blockHash), null]);
    if (done.payloadStatus.status !== 'VALID') fail(`блок не стал головой цепочки: ${JSON.stringify(done)}`);
    return payload;
}

const hostEnvironment = { ...process.env, SP1_PROVER: 'mock', RAYON_NUM_THREADS: '4' };
const run = (binary, args, logFile) => {
    try {
        const output = execFileSync('nice', ['-n', '15', binary, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: hostEnvironment,
            maxBuffer: 64 * 1024 * 1024,
        });
        writeFileSync(logFile, output);
    } catch (error) {
        writeFileSync(logFile, `${error.stdout ?? ''}\n${error.stderr ?? ''}`);
        fail(`${path.basename(binary)} завершился с ошибкой: см. ${logFile}`);
    }
};

// --- до узла: хост обязан быть собран из нынешних исходников ---
// program.json пишет хост (--vkeys) и отказывается это делать, если собран не из исходников на
// диске; отчёты хоста ниже сверяются с ним по хешу ELF.
if (PROGRAM.sourcesSha256 !== evmSourcesSha256()) {
    fail('fixtures/evm_batches/program.json описывает другие исходники: пересоберите хост и запустите rollup-evm-host --vkeys');
}

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
// Правила — по Cancun с нулевого блока (как зашито в программе); единственный счёт — мост.
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
            gasLimit: quantity(GAS_LIMIT),
            difficulty: '0x0',
            mixHash: ZERO,
            coinbase: '0x' + '00'.repeat(20),
            baseFeePerGas: quantity(GWEI),
            alloc: { [BRIDGE]: { code: BRIDGE_CODE, nonce: '0x1', balance: '0x0' } },
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
        '--http', '--http.port', String(HTTP_PORT), '--http.api', 'eth,debug,net,web3,testing',
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
    // Генезис — константа протокола: узел обязан получить тот же хеш заголовка, что посчитан в
    // zkvm-evm/lib независимо и записан в контракте.
    if (genesis.hash !== GENESIS_HASH) fail(`хеш генезиса у узла ${genesis.hash}, а константа протокола — ${GENESIS_HASH}`);
    if ((await call(HTTP, 'eth_getCode', [BRIDGE, '0x0'])) !== BRIDGE_CODE) fail('по адресу моста в генезисе не код моста');
    if (BigInt(await call(HTTP, 'eth_getTransactionCount', [BRIDGE, '0x0'])) !== 1n) fail('nonce счёта моста в генезисе — не 1');

    // --- счета ---
    const user = newAccount(); // A: депозит, все включённые транзакции
    const other = newAccount(); // B: только депозит; его принудительные транзакции все пропущены
    const strangers = [newAccount(), newAccount()]; // счетов в дереве нет
    const recipientData = WITHDRAW_RECIPIENT;
    const bridgeCall = (account, nonce, valueNanotons, extra = {}, options = {}) =>
        signTransaction(account, { nonce, gas: FORCED_TX_GAS_CAP, to: BRIDGE, value: valueNanotons * GWEI, data: recipientData, ...extra }, options);

    // --- очередь L1: элементы в порядке постановки ---
    /** @type {{kind: 'deposit', l2Recipient: string, amount: bigint}|{kind: 'forced', bytes: Buffer, label: string, expect: string}} */
    const queue = [];
    const deposit = (l2Recipient, amount) => queue.push({ kind: 'deposit', l2Recipient, amount });
    /** `expect`: 'included' либо причина пропуска в том виде, как её печатает хост. */
    const forced = (label, expect, transaction) => {
        queue.push({ kind: 'forced', bytes: Buffer.from(transaction), label, expect });
        return transaction;
    };
    /** Транзакция блока: байты, ожидаемый статус и число логов моста. */
    const entry = (label, raw, status = 1, bridgeLogs = 0) => ({ label, raw, status, bridgeLogs });
    const blocks = [];
    /** Собрать блок: отрезок очереди до `upTo` включительно, транзакции — включённые принудительные и затем секвенсора. */
    let processed = 0;
    async function nextBlock(note, upTo, transactions, headAtBatch = upTo) {
        const segment = queue.slice(processed, upTo);
        if (segment.length > MAX_BATCH_QUEUE_ITEMS) fail('отрезок очереди длиннее предела');
        const credits = segment.filter((item) => item.kind === 'deposit').map(({ l2Recipient, amount }) => ({ address: l2Recipient, amount }));
        const payload = await buildBlock(credits, transactions.map((transaction) => transaction.raw));
        const number = blocks.length + 1;
        const receipts = await call(HTTP, 'eth_getBlockReceipts', [quantity(number)]);
        transactions.forEach((transaction, index) => {
            const receipt = receipts[index];
            const logs = receipt.logs.filter((log) => log.address === BRIDGE).length;
            if (Number(receipt.status) !== transaction.status || logs !== transaction.bridgeLogs) {
                fail(`блок ${number}, «${transaction.label}»: статус ${Number(receipt.status)} и логов моста ${logs}, ожидалось ${transaction.status} и ${transaction.bridgeLogs}`);
            }
        });
        // Выводы блока со слов УЗЛА: логи моста в порядке блока.
        const withdrawals = receipts.flatMap((receipt) => receipt.logs).filter((log) => log.address === BRIDGE).map((log) => ({
            recipientHash: '0x' + log.data.slice(2, 66),
            amount: BigInt('0x' + log.data.slice(66)).toString(),
        }));
        blocks.push({ number, note, payload, from: processed, upTo, headAtBatch, segment, transactions, withdrawals });
        processed = upTo;
        return { payload, receipts };
    }

    // Блок 1: в очереди два депозита, блок обрабатывает первый.
    deposit(user.address, USER_DEPOSIT);
    deposit(other.address, OTHER_DEPOSIT);
    await nextBlock('родитель — генезис; зачисление депозита; частичная обработка очереди', 1, [], 2);

    // Блок 2.
    let nonce = 0;
    const firstForced = forced('принудительный вывод 0,1', 'included', bridgeCall(user, nonce++, 100_000_000n));
    forced('мусор', 'Skipped(Undecodable)', keccak(Buffer.from('ton-zk-rollup: not a transaction')).subarray(0, 20));
    forced('nonce выше', 'Skipped(Invalid(NonceTooHigh))', bridgeCall(user, 7, MIN_WITHDRAWAL));
    forced('дубль включённой', 'Skipped(Invalid(NonceTooLow))', firstForced);
    forced('отправителя нет в дереве', 'Skipped(Invalid(LackOfFunds))', bridgeCall(strangers[0], 0, MIN_WITHDRAWAL));
    forced('отправитель получает депозит в этом же блоке', 'Skipped(Invalid(LackOfFunds))', bridgeCall(other, 0, MIN_WITHDRAWAL));
    const contracts = {};
    const create = (name, code) => {
        contracts[name] = contractAddress(user.address, nonce);
        return entry(`создание ${name}`, signTransaction(user, { nonce: nonce++, gas: 300_000n, data: code }));
    };
    await nextBlock('депозит, принудительный вывод включён, пропуски; перевод, вывод, создание контрактов', queue.length, [
        entry('принудительный вывод 0,1', firstForced, 1, 1),
        entry('перевод', signTransaction(user, { type: 0, nonce: nonce++, gas: 21_000n, to: TRANSFER_TO, value: TRANSFER_WEI })),
        entry('вывод 0,25', signTransaction(user, { type: 0, nonce: nonce++, gas: 60_000n, to: BRIDGE, value: 250_000_000n * GWEI, data: recipientData }), 1, 1),
        create('splitter', creation(SPLITTER)),
        create('reverter', creation(REVERTER)),
        create('delegator', creation(DELEGATOR)),
        create('storage', STORAGE_CREATE),
    ]);
    for (const [name, code] of [['splitter', SPLITTER], ['reverter', REVERTER], ['delegator', DELEGATOR], ['storage', bytes(STORAGE_RUNTIME)]]) {
        if ((await call(HTTP, 'eth_getCode', [contracts[name], 'latest'])) !== hex(code)) fail(`контракт ${name} не создан по ожидаемому адресу`);
    }
    const slotAt = (address, slot, block) => call(HTTP, 'eth_getStorageAt', [address, quantity(slot), quantity(block)]);
    for (const slot of [...KEPT_SLOTS, DELETED_SLOT]) if (BigInt(await slotAt(contracts.storage, slot, 2)) !== 1n) fail('слот контракта не записан');

    // Блок 3: пропуски по каждой причине, включённые принудительные вперемешку с ними.
    const next = nonce; // nonce счёта A перед блоком 3
    forced('получатель — не мост', 'Skipped(NotBridgeCall)', signTransaction(user, { nonce: next, gas: 21_000n, to: TRANSFER_TO, value: TRANSFER_WEI }));
    forced('тип 3 (блобы)', 'Skipped(UnsupportedType)', signTransaction(user, { type: 3, nonce: next, gas: FORCED_TX_GAS_CAP, to: BRIDGE, value: MIN_WITHDRAWAL * GWEI, data: recipientData }));
    const reverted = forced('включена: сумма ниже минимума, мост откатывает', 'included', bridgeCall(user, nonce++, 10_000_000n));
    forced('тип 4 (делегирование)', 'Skipped(UnsupportedType)', signTransaction(user, { type: 4, nonce, gas: FORCED_TX_GAS_CAP, to: BRIDGE, value: MIN_WITHDRAWAL * GWEI, data: recipientData }));
    forced('чужой chainId', 'Skipped(ForeignChainId)', bridgeCall(user, nonce, MIN_WITHDRAWAL, { chainId: CHAIN_ID + 1n }));
    forced('существующий счёт, nonce выше', 'Skipped(Invalid(NonceTooHigh))', bridgeCall(other, 3, MIN_WITHDRAWAL));
    forced('без chainId', 'Skipped(MissingChainId)', bridgeCall(user, nonce, MIN_WITHDRAWAL, { type: 0 }, { noChainId: true }));
    forced('s в верхней половине', 'Skipped(Signature)', bridgeCall(user, nonce, MIN_WITHDRAWAL, {}, { highS: true }));
    const minimum = forced('включена: вывод ровно на минимум', 'included', bridgeCall(user, nonce++, MIN_WITHDRAWAL, { type: 1 }));
    forced('лимит газа выше предела', 'Skipped(GasLimitAboveCap)', bridgeCall(user, nonce, MIN_WITHDRAWAL, { gas: FORCED_TX_GAS_CAP + 1n }));
    forced('создание контракта', 'Skipped(Create)', signTransaction(user, { nonce, gas: FORCED_TX_GAS_CAP, data: '0x00' }));
    forced('хвост после транзакции', 'Skipped(Undecodable)', Buffer.concat([bridgeCall(user, nonce, MIN_WITHDRAWAL), Buffer.from([0])]));
    forced('нехватка баланса', 'Skipped(Invalid(LackOfFunds))', bridgeCall(other, 0, 1_000_000_000n));
    forced('цена ниже базовой', 'Skipped(Invalid(GasPriceBelowBaseFee))', bridgeCall(other, 0, MIN_WITHDRAWAL, { type: 0, gasPrice: 1n }));
    forced('чаевые выше наибольшей цены', 'Skipped(Invalid(PriorityFeeAboveMaxFee))', bridgeCall(other, 0, MIN_WITHDRAWAL, { maxPriority: 3n * GWEI }));
    forced('лимита газа не хватает на саму транзакцию', 'Skipped(Invalid(IntrinsicGas))', bridgeCall(other, 0, MIN_WITHDRAWAL, { gas: 21_000n }));
    forced('плата не помещается в 256 бит', 'Skipped(Invalid(PaymentOverflow))', signTransaction(other, { nonce: 0, gas: FORCED_TX_GAS_CAP, to: BRIDGE, value: 2n ** 256n - 1n, data: recipientData }));
    forced('nonce — наибольшее u64', 'Skipped(Invalid(NonceOverflow))', bridgeCall(other, 2n ** 64n - 1n, MIN_WITHDRAWAL));
    forced('nonce ниже', 'Skipped(Invalid(NonceTooLow))', bridgeCall(user, 0, 70_000_000n));
    forced('второго отправителя нет в дереве', 'Skipped(Invalid(LackOfFunds))', bridgeCall(strangers[1], 0, MIN_WITHDRAWAL));
    const starved = forced('включена: газа не хватает на код моста', 'included', bridgeCall(user, nonce++, MIN_WITHDRAWAL, { gas: 21_550n }));
    const callContract = (label, name, valueNanotons, status, logs) =>
        entry(label, signTransaction(user, { nonce: nonce++, gas: 200_000n, to: contracts[name], value: valueNanotons * GWEI, data: recipientData }), status, logs);
    await nextBlock('пропуски по каждой причине; выводы из контракта L2, откатившийся кадр, DELEGATECALL', queue.length, [
        entry('принудительная: мост откатывает', reverted, 0, 0),
        entry('принудительная: вывод на минимум', minimum, 1, 1),
        entry('принудительная: нехватка газа', starved, 0, 0),
        callContract('два вывода из контракта L2', 'splitter', 200_000_000n, 1, 2),
        callContract('вывод во внутреннем откатившемся кадре', 'reverter', 100_000_000n, 1, 0),
        callContract('DELEGATECALL в мост', 'delegator', 100_000_000n, 1, 0),
        entry('вызов моста с 31 байтом данных', signTransaction(user, { nonce: nonce++, gas: 60_000n, to: BRIDGE, value: MIN_WITHDRAWAL * GWEI, data: recipientData.slice(0, 64) }), 0, 0),
        entry('перевод EIP-2930', signTransaction(user, { type: 1, nonce: nonce++, gas: 21_000n, to: TRANSFER_TO, value: TRANSFER_WEI })),
    ]);
    // Вызов моста внутри откатившегося кадра СОСТОЯЛСЯ (признак в слоте 0), а лога нет.
    if (BigInt(await slotAt(contracts.reverter, 0, 3)) !== 1n) fail('вызов моста во внутреннем кадре не состоялся: случай не тот');
    // DELEGATECALL прошёл успешно, лог записан с адреса вызывающего контракта.
    if (BigInt(await slotAt(contracts.delegator, 0, 3)) !== 1n) fail('DELEGATECALL в мост не прошёл: случай не тот');
    const blockThree = await call(HTTP, 'eth_getBlockReceipts', ['0x3']);
    const delegated = blockThree[5].logs;
    if (delegated.length !== 1 || delegated[0].address !== contracts.delegator || delegated[0].topics[0] !== WITHDRAWAL_TOPIC) {
        fail('DELEGATECALL в мост не записал лог события с адреса вызывающего');
    }
    // Счёт B не тронут ни одной из своих принудительных транзакций.
    if (BigInt(await call(HTTP, 'eth_getTransactionCount', [other.address, '0x3'])) !== 0n) fail('у счёта B изменился nonce');

    // Блоки 4 и 5: обнуление слотов (7-1). Отрезок очереди пуст.
    const clear = (slot) => entry(`обнуление слота ${slot}`, signTransaction(user, { nonce: nonce++, gas: 100_000n, to: contracts.storage, data: hex(word(slot)) }));
    await nextBlock('обнуление слота рядом с веткой (7-1)', queue.length, [clear(DELETED_SLOT)]);
    if (BigInt(await slotAt(contracts.storage, DELETED_SLOT, 4)) !== 0n) fail('слот не обнулён');
    for (const slot of KEPT_SLOTS) if (BigInt(await slotAt(contracts.storage, slot, 4)) !== 1n) fail('соседние слоты изменились');
    // Форма дерева хранилища до удаления: в корневой ветке ровно два потомка, и сосед удаляемого
    // ключа — ветка. Иначе блок 4 не тот случай, ради которого он заведён.
    const slotKey = (slot) => keccak(word(BigInt(slot)));
    if (new Set(KEPT_SLOTS.map((slot) => slotKey(slot)[0] >> 4)).size !== 1 || slotKey(DELETED_SLOT)[0] >> 4 === slotKey(KEPT_SLOTS[0])[0] >> 4) {
        fail('слоты подобраны неверно: сосед удаляемого ключа не ветка');
    }
    // После блока 4 в хранилище два слота с общим первым полубайтом: корень — расширение → ветка.
    // Блок 5 обнуляет один из них: читает под расширением и сворачивает корень в лист.
    await nextBlock('обнуление слота под расширением', queue.length, [clear(KEPT_SLOTS[0])]);
    if (BigInt(await slotAt(contracts.storage, KEPT_SLOTS[0], 5)) !== 0n || BigInt(await slotAt(contracts.storage, KEPT_SLOTS[1], 5)) !== 1n) fail('блок 5: слоты не те');

    // Блоки 6–10: замер циклов.
    await nextBlock('пустой блок', queue.length, []);
    const full = [];
    for (let index = 0; index < MAX_BATCH_QUEUE_ITEMS; index++) {
        full.push(entry(`вывод ${index}`, forced(`полный отрезок: вывод ${index}`, 'included', bridgeCall(user, nonce++, MIN_WITHDRAWAL + BigInt(index))), 1, 1));
    }
    await nextBlock('полный отрезок: все принудительные выводы включены', queue.length, full);
    for (let index = 0; index < MAX_BATCH_QUEUE_ITEMS; index++) {
        forced(`полный отрезок: nonce выше ${index}`, 'Skipped(Invalid(NonceTooHigh))', bridgeCall(other, 5 + index, MIN_WITHDRAWAL));
    }
    await nextBlock('полный отрезок: все принудительные пропущены revm', queue.length, []);
    for (let index = 0; index < MAX_BATCH_QUEUE_ITEMS; index++) {
        deposit(hex(keccak(Buffer.from(`ton-zk-rollup-depositor-${index}`)).subarray(12)), MIN_WITHDRAWAL + BigInt(index));
    }
    await nextBlock('полный отрезок: депозиты на новые счета', queue.length, []);
    for (let index = 0; index < MAX_BATCH_QUEUE_ITEMS; index++) {
        forced(`полный отрезок: мусор ${index}`, 'Skipped(Undecodable)', keccak(Buffer.from(`ton-zk-rollup-garbage-${index}`)));
    }
    await nextBlock('полный отрезок: мусор', queue.length, []);
    // Блок 11: отправителя нет в дереве, и первый полубайт пути к его месту — тот же, что у
    // существующего счёта (первого получателя депозита блока 9): под корневой веткой там узел,
    // которого пустой блок не трогает. Доказать «счёта нет» может только дополнение свидетеля.
    const occupied = keccak(bytes(queue.find((item) => item.kind === 'deposit' && item.amount === MIN_WITHDRAWAL).l2Recipient))[0] >> 4;
    let deepStranger = newAccount();
    while (keccak(bytes(deepStranger.address))[0] >> 4 !== occupied) deepStranger = newAccount();
    forced('отправителя нет, путь к его месту не раскрыт', 'Skipped(Invalid(LackOfFunds))', bridgeCall(deepStranger, 0, MIN_WITHDRAWAL));
    await nextBlock('отсутствующий отправитель под нераскрытым узлом', queue.length, []);
    // Блок 12: самый длинный элемент, какой контракт ставит в очередь (64 ячейки по 127 байт).
    // Данные вызова подобраны так, чтобы транзакция заняла ровно столько. Программа пропускает
    // такой элемент по длине, не разбирая: остаётся цена чтения входа и хеша очереди. (Без
    // предела длины тот же отрезок стоил 20,76 млн циклов — разбор, сверка кодировки, хеш подписи.)
    const longest = (index) => {
        const build = (length, fill) => signTransaction(strangers[0], {
            nonce: index, gas: FORCED_TX_GAS_CAP, to: BRIDGE, data: hex(Buffer.alloc(length, fill)),
        });
        // Длина подписи зависит от подписываемого (r и s бывают на байт короче), поэтому простая
        // поправка длины данных может колебаться между «на байт меньше» и «на байт больше»:
        // перебираем соседние длины и байт заполнения, пока транзакция не займёт ровно предел.
        // Обвязка транзакции при длинных данных (префиксы длины RLP уже трёхбайтовые).
        const base = MAX_FORCED_TX_BYTES - (build(1000, 0x80).length - 1000);
        for (let fill = 0x80 + index; fill < 0x100; fill++) {
            for (const length of [base, base + 1, base - 1, base + 2, base - 2]) {
                const transaction = build(length, fill);
                if (transaction.length === MAX_FORCED_TX_BYTES) return transaction;
            }
        }
        return fail('не удалось подобрать длину данных под предел очереди');
    };
    for (let index = 0; index < MAX_BATCH_QUEUE_ITEMS; index++) {
        forced(`полный отрезок: наибольшая по длине ${index}`, 'Skipped(TooLong)', longest(index));
    }
    await nextBlock('полный отрезок: принудительные наибольшей длины, пропущены по длине', queue.length, []);

    // На мосту — ровно сумма выводов; у получателя чаевых — ненулевой баланс.
    const allWithdrawals = blocks.flatMap((block) => block.withdrawals.map((leaf) => ({ ...leaf, block: block.number })));
    const burnt = allWithdrawals.reduce((sum, leaf) => sum + BigInt(leaf.amount), 0n) * GWEI;
    if (BigInt(await call(HTTP, 'eth_getBalance', [BRIDGE, 'latest'])) !== burnt) fail('баланс моста не равен сумме выводов');
    if (BigInt(await call(HTTP, 'eth_getBalance', [sequencer.address, 'latest'])) === 0n) fail('чаевые не дошли до получателя');

    // --- входы батчей: свидетель от узла штатным rsp, дополнение счетами отправителей, наш хост ---
    let depositHash = ZERO;
    let frontier = [];
    let withdrawalsCount = 0n;
    const reports = [];
    const refusedWithoutSupplement = [];
    for (const block of blocks) {
        const number = block.number;
        const header = await call(HTTP, 'eth_getBlockByNumber', [quantity(number), false]);
        if (header.hash !== block.payload.blockHash || header.miner !== sequencer.address) fail(`блок ${number}: узел хранит другой блок`);
        run(RSP, [
            '--block-number', String(number), '--rpc-url', HTTP, '--genesis-path', genesisFile,
            '--cache-dir', path.join(WORK, 'cache'), '--report-path', path.join(WORK, 'rsp-report.csv'),
            '--state-backend', 'execution-witness',
        ], path.join(WORK, `rsp-block-${number}.log`));
        // Доказательства счетов на состоянии РОДИТЕЛЯ — для отправителей принудительных транзакций
        // отрезка. Отправителя сценарий знает сам (он их подписывал); настоящий секвенсор
        // восстанавливает его из подписи. Лишнее доказательство ничего не меняет, недостающее
        // хост обнаружит и откажет.
        const accountProofs = [];
        const senders = new Set(block.segment.filter((item) => item.kind === 'forced').map((item) => signerOf.get(hex(item.bytes))).filter(Boolean));
        for (const address of senders) {
            const proof = await call(HTTP, 'eth_getProof', [address, [], quantity(number - 1)]);
            const code = await call(HTTP, 'eth_getCode', [address, quantity(number - 1)]);
            accountProofs.push({ address, accountProof: proof.accountProof, ...(code === '0x' ? {} : { code }) });
        }
        const witness = {
            prevDepositHash: depositHash,
            queueProcessedFrom: block.from,
            queue: block.segment.map((item) =>
                item.kind === 'deposit'
                    ? { deposit: { l2Recipient: item.l2Recipient, amount: item.amount.toString() } }
                    : { forcedTransaction: hex(item.bytes) },
            ),
            withdrawalsFrontier: frontier,
            withdrawalsCount: withdrawalsCount.toString(),
            accountProofs,
        };
        const witnessFile = path.join(WORK, `witness-${number}.json`);
        writeFileSync(witnessFile, JSON.stringify(witness));
        const blockInput = ['--block-input', path.join(WORK, 'cache', 'input', CHAIN_ID.toString(), `${number}.bin`), '--chain-id', CHAIN_ID.toString()];
        if (number === 3 || number === 11) {
            // Спайк 1 на настоящем узле: без дополнения свидетеля хост отказывает — пути к счетам
            // отправителей пропущенных транзакций в свидетеле узла нет. Блок 3 — существующий
            // счёт, который блок не трогает; блок 11 — отсутствующий счёт.
            const bare = path.join(WORK, `witness-${number}-bare.json`);
            writeFileSync(bare, JSON.stringify({ ...witness, accountProofs: [] }));
            const attempt = spawnSync('nice', ['-n', '15', HOST, ...blockInput, '--witness', bare], { encoding: 'utf8', env: hostEnvironment });
            if (attempt.status !== 2 || !attempt.stderr.includes('В свидетеле нет пути к счёту отправителя')) {
                fail(`блок ${number}: без дополнения свидетеля хост обязан отказать (код ${attempt.status})`);
            }
            refusedWithoutSupplement.push({ block: number, message: attempt.stderr.trim().split('\n')[0] });
        }
        run(HOST, [
            ...blockInput, '--witness', witnessFile, '--execute',
            '--write-input', path.join(OUT, `block-${number}.bin`), '--report', path.join(OUT, `block-${number}.json`),
        ], path.join(WORK, `host-block-${number}.log`));
        const report = JSON.parse(readFileSync(path.join(OUT, `block-${number}.json`), 'utf8'));
        const values = report.publicValues;
        if (values.newStateRoot !== block.payload.blockHash) fail(`блок ${number}: программа коммитит не хеш блока со слов узла`);
        if (values.prevStateRoot !== (number === 1 ? GENESIS_HASH : blocks[number - 2].payload.blockHash)) fail(`блок ${number}: прежнее слово состояния — не хеш родителя`);
        if (BigInt(values.blockTimestamp) !== BigInt(block.payload.timestamp)) fail(`блок ${number}: время блока не то`);
        // Хост обязан нести тот же ELF, под который выведен ключ контракта: устаревший бинарник
        // дал бы фикстуры от прежней программы.
        if (report.programElfSha256.replace(/^0x/, '') !== PROGRAM.programElfSha256.replace(/^0x/, '')) fail('хост собран с другим ELF, чем записан в fixtures/evm_batches/program.json');
        if (report.queueProcessedFrom !== block.from || report.queueProcessedUpTo !== block.upTo) fail(`блок ${number}: отметки очереди в отчёте не те`);
        // Судьба каждой принудительной транзакции — со слов программы против ожидания сценария.
        const expected = block.segment.map((item, queueIndex) => ({ item, queueIndex })).filter(({ item }) => item.kind === 'forced');
        if (report.forced.length !== expected.length) fail(`блок ${number}: в отчёте не все принудительные транзакции`);
        report.forced.forEach((outcome, index) => {
            const { item, queueIndex } = expected[index];
            const actual = outcome.outcome === 'included' ? 'included' : `Skipped(${outcome.reason})`;
            if (outcome.queueIndex !== queueIndex || actual !== item.expect) fail(`блок ${number}, «${item.label}»: программа решила ${actual}, ожидалось ${item.expect}`);
        });
        // Выводы — со слов программы против логов моста со слов узла.
        const leaves = report.withdrawals.map(({ recipientHash, amount }) => ({ recipientHash, amount }));
        if (JSON.stringify(leaves) !== JSON.stringify(block.withdrawals)) fail(`блок ${number}: выводы программы не совпали с логами моста у узла`);
        if (BigInt(values.prevWithdrawalsCount) !== withdrawalsCount || BigInt(values.withdrawalsCount) !== withdrawalsCount + BigInt(leaves.length)) fail(`блок ${number}: счётчик выводов не тот`);
        depositHash = values.newDepositHash;
        frontier = report.withdrawalsFrontierAfter;
        withdrawalsCount = BigInt(values.withdrawalsCount);
        reports.push(report);
    }

    // --- аварийные выходы обоих счетов против каждого блока, где оба уже есть: eth_getProof и
    // подпись согласия. Согласие привязано к блоку, поэтому подписей — по одной на блок.
    const recipientHash = payoutTo ? payoutTo.hash : bytes(WITHDRAW_RECIPIENT);
    const exitsByBlock = [];
    for (const block of blocks.slice(1)) {
        const blockHash = bytes(block.payload.blockHash);
        const consent = keccak(TAG, word(CHAIN_ID), blockHash, recipientHash);
        const exits = [];
        for (const account of [user, other]) {
            const proof = await call(HTTP, 'eth_getProof', [account.address, [], quantity(block.number)]);
            const { r, s, recovery } = signHash(account, keccak(ETH_PREFIX, consent));
            const signature = hex(Buffer.concat([word(r), word(s), Buffer.from([27 + recovery])]));
            const point = new secp256k1.Signature(r, s, recovery).recoverPublicKey(keccak(ETH_PREFIX, consent)).toBytes(false);
            if (hex(keccak(Buffer.from(point).subarray(1)).subarray(12)) !== account.address) fail('подпись согласия не восстанавливается в адрес счёта');
            if (!keccak(bytes(proof.accountProof[0])).equals(bytes(block.payload.stateRoot))) fail('доказательство счёта не от корня состояния блока');
            exits.push({ account: account.address, balanceWei: BigInt(proof.balance).toString(), nonce: Number(proof.nonce), accountProof: proof.accountProof, signature });
        }
        if (BigInt(exits[1].balanceWei) !== OTHER_DEPOSIT * GWEI) fail('баланс второго счёта — не его депозит');
        exitsByBlock.push({ block: block.number, blockHash: block.payload.blockHash, consentHash: hex(consent), exits });
    }
    const EXIT_BLOCK = 3;
    const defaultExit = exitsByBlock.find((exit) => exit.block === EXIT_BLOCK);

    const queueJson = queue.map((item, index) => ({
        number: index + 1,
        // Батч (номер блока), который обрабатывает элемент.
        batch: blocks.find((block) => index < block.upTo).number,
        ...(item.kind === 'deposit'
            ? { kind: 'deposit', l2Recipient: item.l2Recipient, amount: item.amount.toString() }
            : { kind: 'forced', label: item.label, bytes: hex(item.bytes), outcome: item.expect }),
    }));
    let leafIndex = 0;
    writeFileSync(
        path.join(OUT, 'expected.json'),
        JSON.stringify(
            {
                source: `Сгенерировано zkvm-evm/scenario/reth-scenario.mjs (${version}); не редактировать вручную`,
                note: 'Цепочка узла Reth по протоколу версии 2: генезис с мостом-предустановкой, депозиты зачислениями EIP-4895, принудительные транзакции из очереди L1, выводы по логам моста. Ключи счетов одноразовые и в файл не попадают.',
                protocolVersion: 2,
                chainId: CHAIN_ID.toString(),
                genesisHash: genesis.hash,
                genesisStateRoot: genesis.stateRoot,
                bridge: { address: BRIDGE, code: BRIDGE_CODE, codeHash: hex(keccak(bytes(BRIDGE_CODE))), withdrawalTopic: WITHDRAWAL_TOPIC },
                programElfSha256: PROGRAM.programElfSha256,
                feeRecipient: sequencer.address,
                user: user.address,
                other: other.address,
                strangers: [...strangers, deepStranger].map((account) => account.address),
                contracts,
                transferTo: TRANSFER_TO,
                transferWei: TRANSFER_WEI.toString(),
                blocks: blocks.map((block, index) => ({
                    number: block.number,
                    note: block.note,
                    hash: block.payload.blockHash,
                    parentHash: block.payload.parentHash,
                    stateRoot: block.payload.stateRoot,
                    timestamp: Number(block.payload.timestamp),
                    transactions: block.transactions.map(({ label, raw, status, bridgeLogs }) => ({ label, hash: hex(keccak(raw)), status, bridgeLogs })),
                    // Отметки очереди L1: батч заявляет queueProcessedUpTo; headAtBatch — сколько
                    // элементов стояло в очереди, когда блок собирался.
                    queueProcessedFrom: block.from,
                    queueProcessedUpTo: block.upTo,
                    headAtBatch: block.headAtBatch,
                    withdrawalsRoot: reports[index].publicValues.withdrawalsRoot,
                    withdrawalsCount: Number(reports[index].publicValues.withdrawalsCount),
                    zkvmCycles: reports[index].zkvmCycles,
                })),
                // Очередь L1 в порядке постановки.
                queue: queueJson,
                // Все листья дерева выводов по порядку номеров — со слов узла (логи моста).
                withdrawals: allWithdrawals.map((leaf) => ({ leafIndex: leafIndex++, ...leaf })),
                storageDeletion: { block: 4, contract: contracts.storage, deletedSlot: DELETED_SLOT, keptSlots: KEPT_SLOTS, extensionBlock: 5, extensionDeletedSlot: KEPT_SLOTS[0] },
                // Спайк 1: без доказательств счетов отправителей хост эти блоки отвергает.
                refusedWithoutSupplement,
                // Аварийные выходы: согласие обоих счетов — одному получателю. По умолчанию —
                // против блока exitBlock; exitsByBlock — против любого блока начиная со второго.
                exitRecipient: payoutTo ? payoutTo.toString({ testOnly: true }) : null,
                exitRecipientHash: hex(recipientHash),
                exitBlock: EXIT_BLOCK,
                consentHash: defaultExit.consentHash,
                exits: defaultExit.exits,
                exitsByBlock,
            },
            null,
            1,
        ) + '\n',
    );
    rmSync(FIXTURES, { recursive: true, force: true });
    cpSync(OUT, FIXTURES, { recursive: true });

    // --- замер циклов (спайк 4, PROTOCOL-V2.md, 0.5): цена элемента очереди для прувера ---
    const cycles = (number) => reports[number - 1].zkvmCycles;
    const baseline = cycles(6);
    const perItem = (number) => Math.round((cycles(number) - baseline) / MAX_BATCH_QUEUE_ITEMS);
    writeFileSync(
        path.join(ROOT, 'bench', 'evm-v2-cycles.json'),
        JSON.stringify(
            {
                source: 'Сгенерировано zkvm-evm/scenario/reth-scenario.mjs; не редактировать вручную',
                note: 'Программа батча EVM протокола версии 2: блоки узла Reth исполнены в zkVM SP1 БЕЗ пруфа, измерены циклы RISC-V. Время и память доказательства здесь НЕ измерялись. Цена элемента очереди — разность с пустым блоком, делённая на число элементов; свидетель состояния у блоков разный, поэтому это оценка с точностью до нескольких процентов.',
                reth: version,
                programElfSha256: PROGRAM.programElfSha256,
                constants: { forcedTxGasCap: Number(FORCED_TX_GAS_CAP), forcedTxMaxBytes: FORCED_TX_MAX_BYTES_PROGRAM, maxBatchQueueItems: MAX_BATCH_QUEUE_ITEMS, gasLimit: Number(GAS_LIMIT) },
                // Тот же отрезок из 32 элементов по 8 128 байт до введения предела длины в программе
                // (замер 15.11.2026, прежний ELF): разбор, сверка кодировки и хеш подписи каждого.
                beforeLengthLimit: { fullSegmentOfLongestCycles: 20757803, emptyBlockCycles: 7754015 },
                blocks: blocks.map((block, index) => ({
                    number: block.number,
                    note: block.note,
                    transactions: block.transactions.length,
                    queueItems: block.segment.length,
                    forcedIncluded: block.segment.filter((item) => item.kind === 'forced' && item.expect === 'included').length,
                    forcedSkipped: block.segment.filter((item) => item.kind === 'forced' && item.expect !== 'included').length,
                    deposits: block.segment.filter((item) => item.kind === 'deposit').length,
                    withdrawals: block.withdrawals.length,
                    gasUsed: Number(block.payload.gasUsed),
                    dataBytes: reports[index].dataBytes,
                    zkvmCycles: reports[index].zkvmCycles,
                })),
                emptyBlockCycles: baseline,
                // Газ L2 включённого принудительного вывода (вызов моста с 32 байтами данных).
                forcedWithdrawalGas: Math.round(Number(blocks[6].payload.gasUsed) / MAX_BATCH_QUEUE_ITEMS),
                cyclesPerQueueItem: {
                    forcedWithdrawalIncluded: perItem(7),
                    forcedSkippedByRevm: perItem(8),
                    deposit: perItem(9),
                    forcedSkippedByForm: perItem(10),
                    // Наибольший по длине (8 128 байт) элемент очереди: пропущен по длине без разбора.
                    forcedSkippedLongest: perItem(12),
                },
                // Худший для прувера отрезок: все элементы — включённые принудительные выводы.
                fullSegmentWorstCase: { cycles: cycles(7), overEmptyBlock: cycles(7) - baseline, ratioToEmptyBlock: Number((cycles(7) / baseline).toFixed(3)) },
                // Худший отрезок, который может навязать посторонний за одну плату за место в
                // очереди (без монет на L2): транзакции, которые доходят до revm и отвергаются.
                fullSegmentOfRefused: { cycles: cycles(8), overEmptyBlock: cycles(8) - baseline, ratioToEmptyBlock: Number((cycles(8) / baseline).toFixed(3)) },
            },
            null,
            2,
        ) + '\n',
    );
    console.log(`Записано: fixtures/evm_batches/reth/ — блоки 1–${blocks.length} (${reports.map((report) => report.zkvmCycles).join(', ')} циклов)`);
} finally {
    node.kill();
}
