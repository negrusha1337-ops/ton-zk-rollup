// Сценарий протокола версии 2 на настоящем узле Reth: очередь L1 (депозиты и принудительные
// транзакции) → блоки EVM → входы батчей, исполнение в zkVM без пруфа и доказательства счетов для
// аварийного выхода (фикстуры fixtures/evm_batches/reth/).
//
//   node zkvm-evm/scenario/reth-scenario.mjs [адрес получателя выплат в TON]
//       [--first-block-time=<unix>] [--first-block-in=<секунд от запуска>]
//
// С адресом выводы через мост и аварийные выходы обоих счетов идут этому получателю (кошелёк
// будущего прогона в testnet: согласие подписывается одноразовым ключом, переподписать его потом
// нельзя). Без адреса получатель — ничей адрес, годный только для Sandbox.
//
// Время блоков. Контракт принимает батч, только пока `blockTimestamp ≤ now ≤ blockTimestamp +
// maxBlockAge`, а между сборкой цепочки и приёмом батча — проверка и пруфы, то есть часы. Поэтому
// время первого блока задаётся: `--first-block-time` (unix) либо `--first-block-in` (секунд от
// запуска); без них — момент запуска. Каждый следующий блок — на секунду позже родителя: вся
// цепочка укладывается в одно окно maxBlockAge. Узел Reth блок с временем из будущего через
// Engine API принимает (после Merge время блока сверяет клиент консенсуса, а его здесь нет).
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
//             каждой достижимой причине revm; вызовы моста с негодными подписями (`badSignatures`:
//             r не на кривой, нули, значения у порядка группы и модуля поля, перевёрнутый v,
//             вырожденная точка восстановления) — этот блок идёт в пруф; включённые
//             принудительные: откат моста, вывод ровно на минимум, нехватка газа; транзакции
//             секвенсора: два вывода из контракта L2 одной транзакцией, вывод во внутреннем
//             откатившемся кадре, DELEGATECALL в мост, вызовы моста не по форме (31 байт данных,
//             сумма не в целых нанотонах);
//   блок 4  — контракт обнуляет слот рядом с веткой (REVIEW.md, 7-1); вызов моста, который мост
//             откатывает (счёт моста раскрыт, логов нет); отрезок очереди пуст;
//   блок 5  — обнуление слота под расширением: корень хранилища сворачивается в лист;
//   блок 6  — пустой (точка отсчёта для замера циклов);
//   блок 7  — полный отрезок: MAX_BATCH_QUEUE_ITEMS принудительных выводов, все включены;
//   блок 8  — полный отрезок принудительных, пропущенных revm (nonce выше);
//   блок 9  — полный отрезок депозитов на новые счета;
//   блок 10 — полный отрезок мусора;
//   блок 11 — принудительная транзакция счёта, которого нет в дереве, а путь к его месту
//             свидетель узла не раскрывает (отсутствие доказывает только дополнение);
//   блок 12 — полный отрезок элементов наибольшей длины, какую принимает контракт (256 байт):
//             мусор вперемешку с выводами через мост, раздутыми списком доступа ровно до предела,
//             — последние ВКЛЮЧЕНЫ;
//   блок 13 — замер: полный отрезок вызовов моста с негодными подписями (те же виды, что в блоке 3);
//   блок 14 — замер: полный отрезок мусора наибольшей длины;
//   блок 15 — замер: полный отрезок годных по форме вызовов наибольшей длины от 32 разных
//             счетов, которых нет в дереве (отказ revm; на каждого — своё доказательство
//             отсутствия в свидетеле): худшее, что может поставить в очередь посторонний без
//             монет на L2.
//
// Хеш очереди L1 и дерево выводов (корень, счётчик, фронтир) сценарий считает САМ — из своей
// очереди и из логов моста у узла — и сверяет с отчётом хоста; во вход следующего блока и в
// expected.json идут свои значения, а не взятые из отчёта.
//
// Ключи счетов одноразовые, создаются в памяти и никуда не пишутся: каждый запуск даёт новую
// цепочку и меняет фикстуры целиком. Блок становится головой сразу, а хост проверяет его уже
// после: недоказуемый блок сценарий только обнаружит (и откажет), но не откатит.
// Инструменты вне репозитория (PROVING.md): reth v2.2.0, rsp на коммите 5afe72eb; хост —
// zkvm-evm/target/release. Нагрузка: узел, исполнение каждого блока в zkVM штатным rsp и нашим
// хостом, строго по одному.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
/**
 * Наибольшая длина принудительной транзакции, байт: MAX_FORCED_TX_BYTES в
 * contracts/rollup/logic.tolk и FORCED_TX_MAX_BYTES в zkvm-evm/lib — одно число.
 */
const MAX_FORCED_TX_BYTES = 256;
/** Наименьший вывод: 0,05 монеты, в нанотонах. */
const MIN_WITHDRAWAL = 50_000_000n;

/** Депозиты в нанотонах (= gwei): что зачтётся на L2. */
const USER_DEPOSIT = 3_000_000_000n;
const OTHER_DEPOSIT = 300_000_000n;
const TRANSFER_TO = '0x' + '22'.repeat(20);
const TRANSFER_WEI = 10_000_000n * GWEI;
// --- аргументы ---
const STARTED_AT = Math.floor(Date.now() / 1000);
const options = Object.fromEntries(
    process.argv.slice(2).filter((argument) => argument.startsWith('--')).map((argument) => {
        const [name, value] = argument.slice(2).split('=');
        if (!['first-block-time', 'first-block-in'].includes(name) || !/^\d+$/.test(value ?? '')) {
            throw new Error(`непонятный аргумент ${argument}: ожидается --first-block-time=<unix> или --first-block-in=<секунд>`);
        }
        return [name, Number(value)];
    }),
);
if ('first-block-time' in options && 'first-block-in' in options) throw new Error('время первого блока задано дважды');
/** Время первого блока (unix): заданное либо момент запуска. */
const FIRST_BLOCK_TIME = options['first-block-time'] ?? STARTED_AT + (options['first-block-in'] ?? 0);
const FIRST_BLOCK_TIME_SOURCE = 'first-block-time' in options ? 'first-block-time' : 'first-block-in' in options ? 'first-block-in' : 'now';
const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
if (positional.length > 1) throw new Error('лишний аргумент: ожидается не больше одного адреса получателя');
/** Получатель выплат в TON (basechain): заданный кошелёк либо ничей адрес для Sandbox. */
const payoutTo = positional[0] ? tonCore.Address.parse(positional[0]) : null;
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
/** Модуль поля secp256k1. */
const FIELD = secp256k1.Point.Fp.ORDER;
const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const modPow = (base, exponent, modulus) => {
    let result = 1n;
    for (base %= modulus; exponent > 0n; exponent >>= 1n, base = (base * base) % modulus) {
        if (exponent & 1n) result = (result * base) % modulus;
    }
    return result;
};

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
/**
 * Транзакция без подписи: хеш, который подписывается, и сборка байтов EIP-2718 с ЛЮБЫМИ
 * значениями подписи (`attach`) — в том числе негодными. `accessList` — список
 * `[адрес, [ключи хранилища]]` (типы 1 и 2).
 */
function unsigned(fields, options = {}) {
    const {
        type = 2, chainId = CHAIN_ID, nonce, gas, to = null, value = 0n, data = '0x',
        gasPrice = 2n * GWEI, maxFee = 2n * GWEI, maxPriority = GWEI, accessList = [],
    } = fields;
    const target = to === null ? Buffer.alloc(0) : bytes(to);
    const input = bytes(data);
    if (type === 0) {
        const base = [int(nonce), int(gasPrice), int(gas), target, int(value), input];
        const signed = options.noChainId ? base : [...base, int(chainId), int(0), int(0)];
        const v = (recovery) => (options.noChainId ? 27n + BigInt(recovery) : chainId * 2n + 35n + BigInt(recovery));
        return { hash: keccak(rlp(signed)), attach: ({ r, s, recovery }) => rlp([...base, int(v(recovery)), int(r), int(s)]) };
    }
    const list = accessList.map(([address, keys]) => [bytes(address), keys.map((key) => word(key))]);
    const payload = {
        1: [int(chainId), int(nonce), int(gasPrice), int(gas), target, int(value), input, list],
        2: [int(chainId), int(nonce), int(maxPriority), int(maxFee), int(gas), target, int(value), input, list],
        // EIP-4844: наибольшая цена blob-газа и один хеш блоба.
        3: [int(chainId), int(nonce), int(maxPriority), int(maxFee), int(gas), target, int(value), input, [], int(GWEI), [Buffer.concat([Buffer.from([1]), Buffer.alloc(31, 7)])]],
        // EIP-7702: одно делегирование (chainId, адрес, nonce, yParity, r, s).
        4: [int(chainId), int(nonce), int(maxPriority), int(maxFee), int(gas), target, int(value), input, [], [[int(chainId), Buffer.alloc(20, 9), int(0), int(0), int(1), int(1)]]],
    }[type];
    const prefix = Buffer.from([type]);
    return {
        hash: keccak(prefix, rlp(payload)),
        attach: ({ r, s, recovery }) => Buffer.concat([prefix, rlp([...payload, int(recovery), int(r), int(s)])]),
    };
}
function encodeSigned(account, fields, options) {
    const { hash, attach } = unsigned(fields, options);
    return attach(signHash(account, hash, options.highS));
}
/** Адрес, в который восстанавливается подпись хеша, либо null, если ключ не восстановить. */
function recoveredAddress(hash, { r, s, recovery }) {
    try {
        const point = new secp256k1.Signature(r, s, recovery).recoverPublicKey(hash).toBytes(false);
        return hex(keccak(Buffer.from(point).subarray(1)).subarray(12));
    } catch (error) {
        return null;
    }
}
/** Число, которое не является абсциссой точки secp256k1: x³ + 7 — невычет по модулю поля. */
function notAnAbscissa(seed) {
    for (let counter = 0; ; counter++) {
        const candidate = BigInt(hex(keccak(Buffer.from(`${seed}-${counter}`)))) % ORDER;
        const cube = (modPow(candidate, 3n, FIELD) + 7n) % FIELD;
        if (candidate > 0n && modPow(cube, (FIELD - 1n) / 2n, FIELD) === FIELD - 1n) return candidate;
    }
}
/**
 * Вызовы моста с негодными подписями — по одному на вид (REVIEW.md, круг 15, Н-1). Форма у
 * всех верная: получатель — мост, лимит газа в пределе, свой chainId; отличается только подпись.
 * В zkVM подпись восстанавливается другим кодом, чем нативно (подсказки и системные вызовы
 * SP1), поэтому каждый вид обязан пройти через zkVM: паника там — остановка rollup'а одним
 * элементом очереди. Каждый случай сценарий проверяет САМ (библиотекой noble): ключ не
 * восстанавливается либо восстанавливается в другой адрес.
 *
 * `honest` — счёт, чьей настоящей подписью подписана та же транзакция: из неё берутся годные
 * r и s для случаев, где негодно только одно из них. Возвращает список
 * `{ kind, note, bytes, expect, signer, r, s, recovery }`; `signer` — адрес, в который подпись
 * восстанавливается (только у перевёрнутого v).
 */
function badSignatureCalls(honest, fields, tag) {
    const { hash, attach } = unsigned(fields);
    const good = signHash(honest, hash);
    const z = BigInt(hex(hash)) % ORDER;
    // Вырожденное восстановление: Q = r⁻¹·(s·R − z·G) — бесконечно удалённая точка, когда
    // s·R = z·G. Берём R = k·G и s = z·k⁻¹: тогда s·R = z·G. Из двух пар (k, s) и (−k, −s) —
    // ту, где s в нижней половине (иначе подпись отсеется раньше, как высокое s).
    let k = BigInt(hex(keccak(Buffer.from(`ton-zk-rollup-degenerate-${tag}`), hash))) % ORDER;
    let degenerateS = (z * secp256k1.Point.Fn.inv(k)) % ORDER;
    if (degenerateS > ORDER / 2n) [k, degenerateS] = [ORDER - k, ORDER - degenerateS];
    const R = secp256k1.Point.BASE.multiply(k).toAffine();
    if (R.x >= ORDER || degenerateS === 0n) fail('вырожденная подпись не построилась: неудачный k');
    const degenerate = { r: R.x, s: degenerateS, recovery: Number(R.y & 1n) };
    // Проверка построения: s·R − z·G действительно ноль группы.
    if (!secp256k1.Point.BASE.multiply(k).multiply(degenerateS).equals(secp256k1.Point.BASE.multiply(z))) fail('вырожденная подпись построена неверно');

    const cases = [
        ['rNotOnCurve', 'r — не абсцисса точки кривой', { ...good, r: notAnAbscissa(`ton-zk-rollup-r-${tag}`) }],
        ['rZero', 'r = 0', { ...good, r: 0n }],
        ['sZero', 's = 0', { ...good, s: 0n }],
        ['rOrder', 'r = n (порядок группы)', { ...good, r: ORDER }],
        ['rOrderPlusOne', 'r = n + 1 (меньше модуля поля)', { ...good, r: ORDER + 1n }],
        ['rFieldModulus', 'r = p (модуль поля)', { ...good, r: FIELD }],
        ['rMax', 'r = 2^256 − 1', { ...good, r: 2n ** 256n - 1n }],
        ['sOrder', 's = n (порядок группы)', { ...good, s: ORDER }],
        ['vFlipped', 'r и s верные, v перевёрнут', { ...good, recovery: good.recovery ^ 1 }],
        ['degenerate', 'точка восстановления — бесконечно удалённая (s·R = z·G)', degenerate],
    ];
    if (ORDER + 1n >= FIELD) fail('n + 1 не меньше модуля поля');
    return cases.map(([kind, note, signature]) => {
        const recovered = recoveredAddress(hash, signature);
        if (kind === 'vFlipped') {
            if (!recovered || recovered === honest.address) fail('перевёрнутый v обязан дать другой адрес');
        } else if (recovered !== null) {
            fail(`подпись «${note}» восстановилась в ${recovered}: случай не тот`);
        }
        const raw = attach(signature);
        if (raw.length > MAX_FORCED_TX_BYTES) fail('вызов моста с негодной подписью длиннее предела');
        // Отправитель перевёрнутого v — посторонний адрес без счёта: отказ revm по балансу.
        if (recovered) signerOf.set(hex(raw), recovered);
        return {
            kind, note, bytes: raw, signer: recovered,
            expect: recovered ? 'Skipped(Invalid(LackOfFunds))' : 'Skipped(Signature)',
            r: quantity(signature.r), s: quantity(signature.s), recovery: signature.recovery,
        };
    });
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
    // Время: первый блок — заданное, каждый следующий — на секунду позже родителя.
    const timestamp = quantity(Number(head.number) === 0 ? FIRST_BLOCK_TIME : Number(head.timestamp) + 1);
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
    if (BigInt(payload.timestamp) !== BigInt(timestamp)) fail(`узел собрал блок с другим временем: ${payload.timestamp} вместо ${timestamp}`);
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
    // Вызовы моста с негодными подписями: транзакция счёта B, которая с его настоящей подписью
    // была бы действительна (nonce 0, сумма по карману). Этот блок идёт в пруф.
    const badSignatures = [];
    const withBadSignatures = (blockNumber, honest, valueNanotons, tag, kinds) => {
        const fields = { nonce: 0, gas: FORCED_TX_GAS_CAP, to: BRIDGE, value: valueNanotons * GWEI, data: recipientData };
        for (const item of badSignatureCalls(honest, fields, tag).filter(({ kind }) => !kinds || kinds.includes(kind))) {
            forced(`негодная подпись: ${item.note}`, item.expect, item.bytes);
            badSignatures.push({
                block: blockNumber, queueNumber: queue.length, kind: item.kind, note: item.note, r: item.r, s: item.s,
                yParity: item.recovery, recoversTo: item.signer, bytes: hex(item.bytes), expected: item.expect,
            });
        }
    };
    withBadSignatures(3, other, MIN_WITHDRAWAL, 'block-3');
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
        // Сумма не в целых нанотонах (0,05 монеты и 1 wei): мост откатывает, листа нет.
        entry('вызов моста с суммой не в целых нанотонах', signTransaction(user, { nonce: nonce++, gas: 60_000n, to: BRIDGE, value: MIN_WITHDRAWAL * GWEI + 1n, data: recipientData }), 0, 0),
        entry('перевод EIP-2930', signTransaction(user, { type: 1, nonce: nonce++, gas: 21_000n, to: TRANSFER_TO, value: TRANSFER_WEI })),
    ]);
    // Вызов моста внутри откатившегося кадра СОСТОЯЛСЯ (признак в слоте 0), а лога нет.
    if (BigInt(await slotAt(contracts.reverter, 0, 3)) !== 1n) fail('вызов моста во внутреннем кадре не состоялся: случай не тот');
    // DELEGATECALL прошёл успешно, лог записан с адреса вызывающего контракта.
    if (BigInt(await slotAt(contracts.delegator, 0, 3)) !== 1n) fail('DELEGATECALL в мост не прошёл: случай не тот');
    const blockThree = await call(HTTP, 'eth_getBlockReceipts', ['0x3']);
    const delegatedAt = blocks[2].transactions.findIndex((transaction) => transaction.label === 'DELEGATECALL в мост');
    const delegated = blockThree[delegatedAt].logs;
    if (delegated.length !== 1 || delegated[0].address !== contracts.delegator || delegated[0].topics[0] !== WITHDRAWAL_TOPIC) {
        fail('DELEGATECALL в мост не записал лог события с адреса вызывающего');
    }
    // Счёт B не тронут ни одной из своих принудительных транзакций.
    if (BigInt(await call(HTTP, 'eth_getTransactionCount', [other.address, '0x3'])) !== 0n) fail('у счёта B изменился nonce');

    // Блоки 4 и 5: обнуление слотов (7-1). Отрезок очереди пуст.
    const clear = (slot) => entry(`обнуление слота ${slot}`, signTransaction(user, { nonce: nonce++, gas: 100_000n, to: contracts.storage, data: hex(word(slot)) }));
    // Второй транзакцией — вызов моста, который мост откатывает: счёт моста раскрыт в свидетеле,
    // а логов моста в блоке нет (на таком блоке тест проверяет, что код моста сверяется только
    // при наличии логов).
    await nextBlock('обнуление слота рядом с веткой (7-1); откат моста без логов', queue.length, [
        clear(DELETED_SLOT),
        entry('вызов моста ниже минимума: логов нет', signTransaction(user, { nonce: nonce++, gas: 60_000n, to: BRIDGE, value: 10_000_000n * GWEI, data: recipientData }), 0, 0),
    ]);
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
    // Блок 12: элементы наибольшей длины, какую контракт ставит в очередь (MAX_FORCED_TX_BYTES).
    // Мусор ровно такой длины и — каждый четвёртый — вывод через мост, раздутый списком доступа
    // ровно до предела: он годен по форме и ВКЛЮЧАЕТСЯ. Длину подгоняют список доступа (адрес —
    // 23 байта, адрес с ключом — 56) и число байтов в наибольшей цене и чаевых.
    const accessShapes = [
        [[BRIDGE, []], [TRANSFER_TO, []], [BRIDGE, [0n]]],
        [[BRIDGE, [0n]], [TRANSFER_TO, [1n]]],
        [[BRIDGE, []], [TRANSFER_TO, []], [BRIDGE, []], [TRANSFER_TO, []]],
        [[BRIDGE, []], [TRANSFER_TO, [1n]]],
        [[BRIDGE, []], [TRANSFER_TO, []], [BRIDGE, []], [TRANSFER_TO, [1n]]],
    ];
    /** Вызов моста от `account` длиной ровно MAX_FORCED_TX_BYTES байт. */
    const longestBridgeCall = (account, accountNonce, valueNanotons) => {
        for (const accessList of accessShapes) {
            // Наибольшая цена — от 2 gwei (4 байта) до 2^56 wei (8 байт), чаевые — от 1 wei (1 байт)
            // до 1 gwei (4 байта): плата по наибольшей цене остаётся по карману.
            for (const maxFee of [2n * GWEI, 2n ** 32n, 2n ** 40n, 2n ** 48n]) {
                for (const maxPriority of [GWEI, 2n ** 16n, 2n ** 8n, 1n]) {
                    const transaction = signTransaction(account, {
                        nonce: accountNonce, gas: FORCED_TX_GAS_CAP, to: BRIDGE, value: valueNanotons * GWEI, data: recipientData,
                        maxFee, maxPriority, accessList,
                    });
                    if (transaction.length === MAX_FORCED_TX_BYTES) return transaction;
                }
            }
        }
        return fail('не удалось подобрать вызов моста длиной ровно в предел очереди');
    };
    const longestGarbage = (label) =>
        Buffer.concat(Array.from({ length: MAX_FORCED_TX_BYTES / 32 }, (_, part) => keccak(Buffer.from(`ton-zk-rollup-${label}-${part}`))));
    const longestIncluded = [];
    for (let index = 0; index < MAX_BATCH_QUEUE_ITEMS; index++) {
        if (index % 4 === 3) {
            const transaction = forced(`наибольшая длина: вывод со списком доступа ${index}`, 'included', longestBridgeCall(user, nonce++, MIN_WITHDRAWAL + BigInt(index)));
            longestIncluded.push(entry(`вывод наибольшей длины ${index}`, transaction, 1, 1));
        } else {
            forced(`наибольшая длина: мусор ${index}`, 'Skipped(Undecodable)', longestGarbage(`longest-garbage-${index}`));
        }
    }
    if (queue.slice(-MAX_BATCH_QUEUE_ITEMS).some((item) => item.bytes.length !== MAX_FORCED_TX_BYTES)) fail('элемент блока 12 не наибольшей длины');
    await nextBlock('полный отрезок элементов наибольшей длины: мусор и включённые выводы со списком доступа', queue.length, longestIncluded);

    // Блок 13 (замер): полный отрезок вызовов моста с негодными подписями — те же виды, что в
    // блоке 3, по кругу; суммы разные, чтобы элементы не повторялись байт в байт.
    for (let round = 0; queue.length - processed < MAX_BATCH_QUEUE_ITEMS; round++) {
        const left = MAX_BATCH_QUEUE_ITEMS - (queue.length - processed);
        const kinds = badSignatures.filter((item) => item.block === 3).map((item) => item.kind).slice(0, left);
        withBadSignatures(13, other, MIN_WITHDRAWAL + 1n + BigInt(round), `block-13-${round}`, kinds);
    }
    await nextBlock('полный отрезок: вызовы моста с негодными подписями', queue.length, []);

    // Блок 14 (замер): полный отрезок мусора наибольшей длины.
    for (let index = 0; index < MAX_BATCH_QUEUE_ITEMS; index++) {
        forced(`полный отрезок: мусор наибольшей длины ${index}`, 'Skipped(Undecodable)', longestGarbage(`full-garbage-${index}`));
    }
    await nextBlock('полный отрезок: мусор наибольшей длины', queue.length, []);

    // Блок 15 (замер): худшее, что ставит в очередь посторонний без монет на L2, — годные по
    // форме вызовы наибольшей длины, каждый от своего счёта, которого нет в дереве. Программа
    // разбирает каждый, восстанавливает подпись, идёт в revm и читает счёт отправителя: на
    // каждого в свидетеле своё доказательство отсутствия.
    const absentSenders = [];
    for (let index = 0; index < MAX_BATCH_QUEUE_ITEMS; index++) {
        const absent = newAccount();
        absentSenders.push(absent.address);
        forced(`полный отрезок: наибольшая длина, отправителя нет ${index}`, 'Skipped(Invalid(LackOfFunds))', longestBridgeCall(absent, 0, MIN_WITHDRAWAL));
    }
    await nextBlock('полный отрезок: годные по форме вызовы наибольшей длины от счетов, которых нет', queue.length, []);

    // На мосту — ровно сумма выводов; у получателя чаевых — ненулевой баланс.
    const allWithdrawals = blocks.flatMap((block) => block.withdrawals.map((leaf) => ({ ...leaf, block: block.number })));
    const burnt = allWithdrawals.reduce((sum, leaf) => sum + BigInt(leaf.amount), 0n) * GWEI;
    if (BigInt(await call(HTTP, 'eth_getBalance', [BRIDGE, 'latest'])) !== burnt) fail('баланс моста не равен сумме выводов');
    if (BigInt(await call(HTTP, 'eth_getBalance', [sequencer.address, 'latest'])) === 0n) fail('чаевые не дошли до получателя');

    // --- независимый счёт: хеш очереди L1 и дерево выводов — формулами контракта
    // (contracts/rollup/logic.tolk, wrappers/rollupMath.ts), без программы и хоста ---
    const FORCED_MARKER = word(1n << 255n);
    /** Шаг хеша очереди: депозит — sha256(прежний ‖ адрес словом ‖ сумма), принудительная — sha256(прежний ‖ метка ‖ keccak(байты)). */
    const queueStep = (previous, item) =>
        item.kind === 'deposit'
            ? sha256(previous, word(BigInt(item.l2Recipient)), word(item.amount))
            : sha256(previous, FORCED_MARKER, keccak(item.bytes));
    const EMPTY = Buffer.alloc(32);
    /** Корень дерева выводов из фронтира и счётчика; без листьев — ноль. */
    const treeRoot = (nodes, count) => {
        if (count === 0n) return EMPTY;
        let node = EMPTY;
        let empty = EMPTY;
        for (let height = 0; height < 32; height++) {
            node = (count >> BigInt(height)) & 1n ? sha256(nodes[height], node) : sha256(node, empty);
            empty = sha256(empty, empty);
        }
        return node;
    };
    /** Дозапись листа: номер листа — прежний счётчик. Возвращает новые фронтир и счётчик. */
    const treeAppend = (nodes, count, leaf) => {
        const next = [...nodes];
        let node = sha256(word(count), bytes(leaf.recipientHash), word(BigInt(leaf.amount)));
        for (let height = 0; height < 32; height++) {
            if (((count >> BigInt(height)) & 1n) === 0n) {
                next[height] = node;
                break;
            }
            node = sha256(next[height], node);
            next[height] = EMPTY;
        }
        return [next, count + 1n];
    };

    // --- входы батчей: свидетель от узла штатным rsp, дополнение счетами отправителей, наш хост ---
    let queueHash = EMPTY;
    let frontier = Array.from({ length: 32 }, () => EMPTY);
    let withdrawalsCount = 0n;
    const own = [];
    const refusedQueueMark = [];
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
            prevDepositHash: hex(queueHash),
            queueProcessedFrom: block.from,
            queue: block.segment.map((item) =>
                item.kind === 'deposit'
                    ? { deposit: { l2Recipient: item.l2Recipient, amount: item.amount.toString() } }
                    : { forcedTransaction: hex(item.bytes) },
            ),
            withdrawalsFrontier: frontier.map(hex),
            withdrawalsCount: withdrawalsCount.toString(),
            accountProofs,
        };
        const witnessFile = path.join(WORK, `witness-${number}.json`);
        writeFileSync(witnessFile, JSON.stringify(witness));
        const blockInput = ['--block-input', path.join(WORK, 'cache', 'input', CHAIN_ID.toString(), `${number}.bin`), '--chain-id', CHAIN_ID.toString()];
        // Прежнюю отметку очереди хост сверяет с отчётом предыдущего батча.
        const previousReport = number === 1 ? [] : ['--previous-report', path.join(OUT, `block-${number - 1}.json`)];
        if (number === 2) {
            // Отметку из свидетеля хост на веру не берёт: с отметкой на единицу больше, а также
            // вовсе без отчёта предыдущего батча он обязан отказать.
            const shifted = path.join(WORK, `witness-${number}-shifted.json`);
            writeFileSync(shifted, JSON.stringify({ ...witness, queueProcessedFrom: block.from + 1 }));
            for (const [what, args, message] of [
                ['чужая отметка', [...blockInput, '--witness', shifted, ...previousReport], 'а предыдущий батч обработал очередь до'],
                ['нет отчёта предыдущего батча', [...blockInput, '--witness', witnessFile], 'её нечем сверить'],
            ]) {
                const attempt = spawnSync('nice', ['-n', '15', HOST, ...args], { encoding: 'utf8', env: hostEnvironment });
                if (attempt.status !== 2 || !attempt.stderr.includes(message)) fail(`блок ${number}, «${what}»: хост обязан отказать (код ${attempt.status})`);
                refusedQueueMark.push({ block: number, what, message: attempt.stderr.trim().split('\n')[0] });
            }
        }
        if (number === 3 || number === 11) {
            // Спайк 1 на настоящем узле: без дополнения свидетеля хост отказывает — пути к счетам
            // отправителей пропущенных транзакций в свидетеле узла нет. Блок 3 — существующий
            // счёт, который блок не трогает; блок 11 — отсутствующий счёт.
            const bare = path.join(WORK, `witness-${number}-bare.json`);
            writeFileSync(bare, JSON.stringify({ ...witness, accountProofs: [] }));
            const attempt = spawnSync('nice', ['-n', '15', HOST, ...blockInput, '--witness', bare, ...previousReport], { encoding: 'utf8', env: hostEnvironment });
            if (attempt.status !== 2 || !attempt.stderr.includes('В свидетеле нет пути к счёту отправителя')) {
                fail(`блок ${number}: без дополнения свидетеля хост обязан отказать (код ${attempt.status})`);
            }
            refusedWithoutSupplement.push({ block: number, message: attempt.stderr.trim().split('\n')[0] });
        }
        run(HOST, [
            ...blockInput, '--witness', witnessFile, ...previousReport, '--execute',
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
        if (report.queueMarkCheckedAgainst !== (number === 1 ? 'empty queue' : 'previous report')) fail(`блок ${number}: хост не сверил прежнюю отметку очереди`);
        // Исполнение в zkVM состоялось, и его публичные значения равны нативным (иначе хост упал бы).
        if (!(report.zkvmCycles > 0)) fail(`блок ${number}: в zkVM не исполнялся`);
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
        // Свой счёт против программы: хеш очереди до и после отрезка, корень, счётчик и фронтир
        // дерева выводов до и после блока. Листья — из логов моста у узла.
        const before = { queueHash, root: treeRoot(frontier, withdrawalsCount), count: withdrawalsCount };
        queueHash = block.segment.reduce(queueStep, queueHash);
        for (const leaf of block.withdrawals) [frontier, withdrawalsCount] = treeAppend(frontier, withdrawalsCount, leaf);
        const after = { queueHash: hex(queueHash), withdrawalsRoot: hex(treeRoot(frontier, withdrawalsCount)), withdrawalsCount };
        const mismatch = [
            ['прежний хеш очереди', values.prevDepositHash, hex(before.queueHash)],
            ['хеш очереди', values.newDepositHash, after.queueHash],
            ['прежний корень выводов', values.prevWithdrawalsRoot, hex(before.root)],
            ['корень выводов', values.withdrawalsRoot, after.withdrawalsRoot],
            ['прежний счётчик выводов', values.prevWithdrawalsCount, before.count.toString()],
            ['счётчик выводов', values.withdrawalsCount, after.withdrawalsCount.toString()],
            ['фронтир выводов', JSON.stringify(report.withdrawalsFrontierAfter), JSON.stringify(frontier.map(hex))],
        ].find(([, program, mine]) => program !== mine);
        if (mismatch) fail(`блок ${number}: ${mismatch[0]} у программы ${mismatch[1]}, а по счёту сценария ${mismatch[2]}`);
        own.push(after);
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
                // Время блоков: первый — firstBlockTimestamp, каждый следующий на секунду позже.
                // Батч с блоком контракт принимает, пока blockTimestamp ≤ now ≤ blockTimestamp + maxBlockAge.
                generatedAt: STARTED_AT,
                firstBlockTimestamp: Number(blocks[0].payload.timestamp),
                firstBlockTimeSource: FIRST_BLOCK_TIME_SOURCE,
                lastBlockTimestamp: Number(blocks[blocks.length - 1].payload.timestamp),
                genesisHash: genesis.hash,
                genesisStateRoot: genesis.stateRoot,
                bridge: { address: BRIDGE, code: BRIDGE_CODE, codeHash: hex(keccak(bytes(BRIDGE_CODE))), withdrawalTopic: WITHDRAWAL_TOPIC },
                programElfSha256: PROGRAM.programElfSha256,
                feeRecipient: sequencer.address,
                user: user.address,
                other: other.address,
                strangers: [...strangers, deepStranger].map((account) => account.address),
                // Отправители блока 15: счетов нет в дереве.
                absentSenders,
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
                    // Корень и счётчик дерева выводов и хеш очереди в точке queueProcessedUpTo —
                    // по счёту сценария (сверены с программой выше).
                    withdrawalsRoot: own[index].withdrawalsRoot,
                    withdrawalsCount: Number(own[index].withdrawalsCount),
                    queueHash: own[index].queueHash,
                    zkvmCycles: reports[index].zkvmCycles,
                })),
                // Очередь L1 в порядке постановки.
                queue: queueJson,
                // Все листья дерева выводов по порядку номеров — со слов узла (логи моста).
                withdrawals: allWithdrawals.map((leaf) => ({ leafIndex: leafIndex++, ...leaf })),
                storageDeletion: { block: 4, contract: contracts.storage, deletedSlot: DELETED_SLOT, keptSlots: KEPT_SLOTS, extensionBlock: 5, extensionDeletedSlot: KEPT_SLOTS[0] },
                // Вызовы моста с негодными подписями (блок 3 — под пруф, блок 13 — замер): что
                // построено и чем кончилось. `expected` сверено с нативным отчётом хоста; в zkVM
                // блок исполнен, и публичные значения совпали с нативными, то есть каждый такой
                // элемент программа в zkVM пропустила (причину пропуска zkVM наружу не выдаёт).
                badSignatures,
                // Спайк 1: без доказательств счетов отправителей хост эти блоки отвергает.
                refusedWithoutSupplement,
                // Прежнюю отметку очереди хост сверяет с отчётом предыдущего батча.
                refusedQueueMark,
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
                constants: { forcedTxGasCap: Number(FORCED_TX_GAS_CAP), forcedTxMaxBytes: MAX_FORCED_TX_BYTES, maxBatchQueueItems: MAX_BATCH_QUEUE_ITEMS, gasLimit: Number(GAS_LIMIT) },
                // Прежние замеры отрезка из 32 элементов по 8 128 байт (15.11.2026): до предела
                // длины в программе (прежний ELF: разбор, сверка кодировки и хеш подписи каждого) и
                // с пределом в программе, но без предела в контракте (нынешний ELF: чтение входа и
                // хеш очереди). Теперь контракт такие элементы в очередь не берёт.
                beforeLengthLimit: { fullSegmentOfLongestCycles: 20757803, emptyBlockCycles: 7754015 },
                beforeContractLengthLimit: { fullSegmentOfLongestSkippedCycles: 12870157, emptyBlockCycles: 7752577 },
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
                // Он же со списком доступа, раздувающим транзакцию до предела длины.
                forcedWithdrawalLongestGas: Math.round(Number(blocks[11].payload.gasUsed) / longestIncluded.length),
                cyclesPerQueueItem: {
                    forcedWithdrawalIncluded: perItem(7),
                    forcedSkippedByRevm: perItem(8),
                    deposit: perItem(9),
                    forcedSkippedByForm: perItem(10),
                    // Вызов моста с негодной подписью (блок 13: виды по кругу, среднее).
                    forcedSkippedBadSignature: perItem(13),
                    // Мусор наибольшей длины (256 байт), блок 14.
                    forcedSkippedLongest: perItem(14),
                    // Включённый вывод наибольшей длины (со списком доступа): блок 12 за вычетом
                    // пустого блока и его мусора по цене блока 14, на один включённый.
                    forcedWithdrawalIncludedLongest: Math.round(
                        (cycles(12) - baseline - (MAX_BATCH_QUEUE_ITEMS - longestIncluded.length) * perItem(14)) / longestIncluded.length,
                    ),
                    // Годный по форме вызов наибольшей длины от счёта, которого нет (блок 15).
                    forcedRefusedLongestAbsentSender: perItem(15),
                },
                // Худший для прувера отрезок: все элементы — включённые принудительные выводы.
                fullSegmentWorstCase: { cycles: cycles(7), overEmptyBlock: cycles(7) - baseline, ratioToEmptyBlock: Number((cycles(7) / baseline).toFixed(3)) },
                // Худший ИЗМЕРЕННЫЙ отрезок из тех, что может навязать посторонний одной платой за
                // место в очереди, без монет на L2: наибольший по циклам среди блоков, где ни один
                // элемент не включён (отказ revm существующему счёту, мусор, негодные подписи,
                // мусор наибольшей длины, годные по форме от счетов, которых нет).
                fullSegmentOfRefused: (() => {
                    const candidates = [8, 10, 13, 14, 15];
                    const worst = candidates.reduce((best, number) => (cycles(number) > cycles(best) ? number : best));
                    return {
                        block: worst,
                        what: blocks[worst - 1].note,
                        comparedBlocks: candidates,
                        cycles: cycles(worst),
                        overEmptyBlock: cycles(worst) - baseline,
                        ratioToEmptyBlock: Number((cycles(worst) / baseline).toFixed(3)),
                    };
                })(),
            },
            null,
            2,
        ) + '\n',
    );
    console.log(`Записано: fixtures/evm_batches/reth/ — блоки 1–${blocks.length} (${reports.map((report) => report.zkvmCycles).join(', ')} циклов)`);
} finally {
    node.kill();
}
