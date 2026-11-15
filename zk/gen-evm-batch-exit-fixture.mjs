// Фикстура сквозного теста «батч EVM принят по пруфу → счёт выходит по доказательству против
// того же блока»: заголовок блока 2 сценария, доказательство счёта в состоянии после блока 2 и
// подпись владельца.
//
//   node zk/gen-evm-batch-exit-fixture.mjs           # собрать и записать (на секунды поднимает anvil)
//   node zk/gen-evm-batch-exit-fixture.mjs --check   # пересобрать без anvil и сверить с файлом
//
// Цепочку сценария перезапускать нельзя (пруф станет негодным), узла с ней уже нет. Но всё нужное
// сохранено: заголовок блока 2 — первый элемент блока в данных батча
// (fixtures/evm_batches/contract/block-2.json), а состояние ПОСЛЕ блока 2 — «родительское
// состояние» во входе RSP для блока 3 (fixtures/evm_batches/honest/block-3.bin): разреженное
// дерево, в котором раскрыты счета, затронутые блоком 3. Отсюда узлы пути счёта — те же байты,
// что отдал бы eth_getProof: это проверяется цепочкой keccak до корня состояния из заголовка.
//
// Счёт — второй dev-счёт anvil. Его ключ общеизвестен, поэтому в репозитории нет ни ключа, ни
// мнемоники: подписывает свежий anvil (другая цепочка, порт 8547) через eth_sign от своего
// разблокированного счёта. Баланс этого счёта — из генезиса anvil, обеспечения на L1 у него
// нет (REVIEW.md, 9-А): фикстура показывает механизм, а не чьи-то деньги.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = process.env.EVM_TOOLS ?? path.join(ROOT, '.tools');
const ANVIL = process.env.ANVIL ?? path.join(TOOLS, 'foundry', 'bin', 'anvil');
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const REPORT = path.join('fixtures', 'evm_batches', 'contract', 'block-2.json');
const NEXT_INPUT = path.join('fixtures', 'evm_batches', 'honest', 'block-3.bin');
const OUT = path.join('fixtures', 'evm_exit', 'batch2-exit.json');
/** Второй dev-счёт anvil: отправитель в блоке 3 сценария, поэтому его лист раскрыт. */
const ACCOUNT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
/** Строка-метка согласия — как EVM_EXIT_TAG в contracts/rollup/evm_exit.tolk. */
const TAG = Buffer.from('ton-zk-rollup:evm-exit:v1');
const ETH_PREFIX = Buffer.from('\x19Ethereum Signed Message:\n32');
const EMPTY_CODE = 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
const check = process.argv.includes('--check');

const hex = (bytes) => '0x' + Buffer.from(bytes).toString('hex');
const bytes = (value) => Buffer.from(value.replace(/^0x/, ''), 'hex');
const keccak = (...parts) => Buffer.from(keccak_256(Buffer.concat(parts)));
const word = (value) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
const fail = (message) => {
    throw new Error(message);
};

// --- RLP ---
const rlpLength = (length, offset) => {
    if (length < 56) return Buffer.from([offset + length]);
    const digits = length.toString(16);
    const size = Buffer.from(digits.padStart(digits.length + (digits.length % 2), '0'), 'hex');
    return Buffer.concat([Buffer.from([offset + 55 + size.length]), size]);
};
const rlpString = (data) => (data.length === 1 && data[0] < 0x80 ? data : Buffer.concat([rlpLength(data.length, 0x80), data]));
const rlpList = (items) => {
    const payload = Buffer.concat(items);
    return Buffer.concat([rlpLength(payload.length, 0xc0), payload]);
};
/** Элементы списка RLP: каждый — { raw: элемент целиком, payload: содержимое, list }. */
function rlpItems(data) {
    const head = (offset) => {
        const b = data[offset];
        const long = (base) => [1 + b - base, Number(BigInt(hex(data.subarray(offset + 1, offset + 1 + b - base))))];
        if (b < 0x80) return [0, 1, false];
        if (b <= 0xb7) return [1, b - 0x80, false];
        if (b <= 0xbf) return [...long(0xb7), false];
        if (b <= 0xf7) return [1, b - 0xc0, true];
        return [...long(0xf7), true];
    };
    const [header, payload, list] = head(0);
    if (!list) fail('ожидался список RLP');
    const items = [];
    for (let position = header; position < header + payload; ) {
        const [itemHeader, itemPayload, itemList] = head(position);
        const end = position + itemHeader + itemPayload;
        items.push({ raw: data.subarray(position, end), payload: data.subarray(position + itemHeader, end), list: itemList });
        position = end;
    }
    return items;
}

// --- дерево rsp-mpt в bincode (zkvm-evm/vendor/rsp-mpt/src/mpt.rs, enum MptNodeData) ---
// Номер варианта — u32 LE: 0 Null, 1 Branch (16 × признак и узел), 2 Leaf (путь, значение),
// 3 Extension (путь, узел), 4 Digest (32 байта). Vec<u8> и B256 — u64 LE длина и байты.
function readNode(data, at) {
    const need = (count) => (at + count <= data.length ? undefined : fail('вход кончился посреди узла'));
    const u32 = () => (need(4), (at += 4), data.readUInt32LE(at - 4));
    const vec = (limit) => {
        need(8);
        const length = Number(data.readBigUInt64LE(at));
        if (length > limit) fail('строка длиннее допустимого');
        at += 8;
        need(length);
        at += length;
        return data.subarray(at - length, at);
    };
    const node = (depth) => {
        if (depth > 70) fail('дерево глубже ключа');
        const variant = u32();
        if (variant === 0) return { kind: 'null' };
        if (variant === 1) {
            const children = [];
            for (let i = 0; i < 16; i++) {
                need(1);
                const present = data[at++];
                if (present > 1) fail('признак потомка не 0 и не 1');
                children.push(present ? node(depth + 1) : null);
            }
            return { kind: 'branch', children };
        }
        if (variant === 2) return { kind: 'leaf', path: vec(33), value: vec(4096) };
        if (variant === 3) return { kind: 'extension', path: vec(33), child: node(depth + 1) };
        if (variant === 4) {
            const digest = vec(32);
            if (digest.length !== 32) fail('дайджест не 32 байта');
            return { kind: 'digest', digest };
        }
        return fail('неизвестный вариант узла');
    };
    return node(0);
}
/** Канонический RLP узла — как impl Encodable for MptNode (mpt.rs). */
function encodeNode(node) {
    // Ссылка на потомка: дайджест как есть; раскрытый узел — его хеш, а короче 32 байт — сам узел.
    const reference = (child) => {
        if (child === null || child.kind === 'null') return rlpString(Buffer.alloc(0));
        if (child.kind === 'digest') return rlpString(child.digest);
        const encoded = encodeNode(child);
        return encoded.length < 32 ? encoded : rlpString(keccak(encoded));
    };
    if (node.kind === 'branch') return rlpList([...node.children.map(reference), rlpString(Buffer.alloc(0))]);
    if (node.kind === 'leaf') return rlpList([rlpString(node.path), rlpString(node.value)]);
    if (node.kind === 'extension') return rlpList([rlpString(node.path), reference(node.child)]);
    return fail('у корня дерева нет своего RLP');
}
/** Полубайты пути в кодировке hex-prefix и признак листа. */
function pathNibbles(encoded) {
    const flags = encoded[0] >> 4;
    const all = [...encoded].flatMap((byte) => [byte >> 4, byte & 15]);
    return { leaf: (flags & 2) === 2, nibbles: flags & 1 ? all.slice(1) : all.slice(2) };
}

const consentHash = (chainId, blockHash, recipientHash) => keccak(TAG, word(chainId), blockHash, recipientHash);
/** Адрес, которому принадлежит подпись сообщения Ethereum под 32 байтами `consent`. */
function signerOf(signature, consent) {
    const raw = bytes(signature);
    const point = secp256k1.Signature.fromBytes(raw.subarray(0, 64), 'compact')
        .addRecoveryBit(raw[64] - 27)
        .recoverPublicKey(keccak(ETH_PREFIX, consent))
        .toBytes(false);
    return hex(keccak(Buffer.from(point).subarray(1)).subarray(12));
}

// --- заголовок блока 2: первый элемент блока в данных батча ---
const report = JSON.parse(readFileSync(path.join(ROOT, REPORT), 'utf8'));
const chainId = BigInt(report.publicValues.chainId);
const header = rlpItems(bytes(report.dataChunksHex.join('')))[0].raw;
const blockHash = keccak(header);
if (hex(blockHash) !== report.publicValues.newStateRoot) fail('хеш заголовка из данных батча — не слово состояния из пруфа');
const stateRoot = rlpItems(header)[3].payload;
if (stateRoot.length !== 32) fail('четвёртое поле заголовка — не корень состояния');

// --- дерево состояния после блока 2 во входе блока 3 ---
// Вход — bincode EvmBatchInput: chain_id (u64), затем блок 3 и остальное. Смещение дерева не
// зашито: берётся единственное место, где разбор даёт узел с хешем, равным корню состояния.
const input = readFileSync(path.join(ROOT, NEXT_INPUT));
if (input.readBigUInt64LE(0) !== chainId) fail('вход блока 3 — от цепочки с другим chainId');
if (!input.includes(blockHash)) fail('вход блока 3 не ссылается на блок 2: это вход другой цепочки');
const roots = [];
for (let offset = 8; offset + 4 <= input.length; offset++) {
    if (input.readUInt32LE(offset) !== 1) continue;
    try {
        const candidate = readNode(input, offset);
        if (keccak(encodeNode(candidate)).equals(stateRoot)) roots.push({ offset, node: candidate });
    } catch (error) {
        // Не узел: ищем дальше.
    }
}
if (roots.length !== 1) fail(`дерево состояния блока 2 во входе блока 3 найдено ${roots.length} раз`);

// --- путь счёта: от корня к листу ---
const key = keccak(bytes(ACCOUNT));
const keyNibbles = [...key].flatMap((byte) => [byte >> 4, byte & 15]);
const proof = [];
let depth = 0;
let leaf = null;
for (let node = roots[0].node; leaf === null; ) {
    proof.push(encodeNode(node));
    if (node.kind === 'branch') {
        const child = node.children[keyNibbles[depth]];
        if (child === null || child.kind === 'null') fail('счёта нет в дереве');
        if (child.kind === 'digest') fail('счёт не раскрыт во входе блока 3');
        depth += 1;
        node = child;
    } else {
        const { leaf: isLeaf, nibbles } = pathNibbles(node.path);
        if (nibbles.some((nibble, i) => nibble !== keyNibbles[depth + i])) fail('путь узла расходится с ключом счёта');
        depth += nibbles.length;
        if (isLeaf !== (node.kind === 'leaf')) fail('признак листа в пути не соответствует виду узла');
        if (node.kind === 'leaf') leaf = node;
        else if (node.child.kind === 'digest') fail('счёт не раскрыт во входе блока 3');
        else node = node.child;
    }
}
if (depth !== 64) fail('путь к листу не покрывает ключ целиком');

// --- самопроверки, независимые от контракта ---
if (!keccak(proof[0]).equals(stateRoot)) fail('корневой узел не сходится с корнем состояния из заголовка');
for (let index = 0, at = 0; index + 1 < proof.length; index++) {
    const items = rlpItems(proof[index]);
    const next = items.length === 17 ? items[keyNibbles[at]] : items[1];
    at += items.length === 17 ? 1 : pathNibbles(items[0].payload).nibbles.length;
    if (!keccak(proof[index + 1]).equals(next.payload)) fail(`узел ${index + 1} — не тот, на который ссылается узел ${index}`);
    if (items.length === 17) {
        // Контракт ждёт у ветки только хеши и пустые потомки, семнадцатый элемент пуст.
        if (items.slice(0, 16).some((item) => item.raw.length !== 1 && item.raw.length !== 33)) fail('у ветки встроенный потомок');
        if (items[16].raw.length !== 1 || items[16].raw[0] !== 0x80) fail('семнадцатый элемент ветки не пуст');
    }
}
const account = rlpItems(leaf.value);
if (account.length !== 4 || account[2].payload.length !== 32) fail('значение листа — не счёт');
if (account[3].payload.toString('hex') !== EMPTY_CODE) fail('у счёта есть код: это не обычный счёт');
const balanceWei = BigInt(hex(account[1].payload));
const nonce = account[0].payload.length ? BigInt(hex(account[0].payload)) : 0n;
if (balanceWei / 1_000_000_000n === 0n) fail('баланс счёта меньше нанотона');

const recipientHash = keccak(Buffer.from('evm-exit-recipient-batch2'));
const otherRecipientHash = keccak(Buffer.from('evm-exit-recipient-batch2-other'));
const consent = consentHash(chainId, blockHash, recipientHash);
const built = {
    chainId: chainId.toString(),
    blockNumber: String(report.blockNumber),
    blockHash: hex(blockHash),
    stateRoot: hex(stateRoot),
    headerRlp: hex(header),
    account: ACCOUNT,
    accountKey: hex(key),
    nonce: nonce.toString(),
    balanceWei: balanceWei.toString(),
    accountProof: proof.map(hex),
    recipientHash: hex(recipientHash),
    consentHash: hex(consent),
};
const origin = {
    header: REPORT,
    state: NEXT_INPUT,
    stateSha256: createHash('sha256').update(input).digest('hex'),
    stateTrieOffset: roots[0].offset,
};

if (check) {
    const file = path.join(ROOT, OUT);
    if (!existsSync(file)) fail(`${OUT} нет: запусти генератор без --check`);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    for (const [name, value] of Object.entries(built)) {
        if (JSON.stringify(stored[name]) !== JSON.stringify(value)) fail(`${OUT}: поле ${name} не то, что получается из исходных файлов`);
    }
    if (stored.origin.stateSha256 !== origin.stateSha256) fail(`${OUT}: собран из другого входа блока 3`);
    if (signerOf(stored.signature, consent) !== ACCOUNT) fail(`${OUT}: подпись не восстанавливается в адрес счёта`);
    console.log(`${OUT} сходится с исходными файлами; подпись принадлежит счёту ${ACCOUNT}.`);
} else {
    // --- подпись: свежий anvil подписывает своим разблокированным dev-счётом ---
    const call = async (method, params) => {
        const response = await fetch(RPC, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const answer = await response.json();
        if (answer.error) fail(`${method}: ${answer.error.message}`);
        return answer.result;
    };
    let portBusy = true;
    try {
        await call('eth_blockNumber', []);
    } catch (error) {
        portBusy = false;
    }
    if (portBusy) fail(`порт ${PORT} занят: на нём уже отвечает какой-то узел`);
    const foundry = execFileSync(ANVIL, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
    const anvil = spawn(ANVIL, ['--port', String(PORT)], { stdio: 'ignore' });
    process.on('exit', () => anvil.kill());
    let signature;
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                await call('eth_blockNumber', []);
                break;
            } catch (error) {
                if (attempt > 50) fail('anvil не поднялся');
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
        }
        if (!(await call('eth_accounts', [])).map((address) => address.toLowerCase()).includes(ACCOUNT)) {
            fail('у этого anvil нет нужного dev-счёта');
        }
        // eth_sign подписывает сообщение Ethereum (с префиксом) под сырыми 32 байтами согласия.
        signature = await call('eth_sign', [ACCOUNT, hex(consent)]);
    } finally {
        anvil.kill();
    }
    if (bytes(signature).length !== 65 || ![27, 28].includes(bytes(signature)[64])) fail('подпись не в формате r ‖ s ‖ v');
    if (signerOf(signature, consent) !== ACCOUNT) fail('подпись не восстанавливается в адрес счёта: формат согласия не тот');
    if (signerOf(signature, consentHash(chainId, blockHash, otherRecipientHash)) === ACCOUNT) fail('подпись годится и для другого получателя');
    const out = {
        source: `Сгенерировано zk/gen-evm-batch-exit-fixture.mjs (подпись — ${foundry}); не редактировать вручную`,
        note: 'Выход счёта против блока 2 сценария EVM — того, что контракт принимает по пруфу fixtures/sp1_evm_batch2. Заголовок — из данных батча, узлы — из состояния после блока 2 во входе RSP блока 3. Счёт — dev-счёт anvil: ключ общеизвестен (в репозитории его нет), баланс из генезиса без обеспечения на L1 (REVIEW.md, 9-А). Только для теста.',
        ...built,
        otherRecipientHash: hex(otherRecipientHash),
        signature,
        origin,
    };
    writeFileSync(path.join(ROOT, OUT), JSON.stringify(out, null, 1) + '\n');
    console.log(`Записано: ${OUT} (счёт ${ACCOUNT}, узлов: ${proof.length} — ${proof.map((node) => node.length).join(', ')} байт, баланс ${balanceWei} wei, nonce ${nonce})`);
}
