// Фикстура аварийного выхода счёта EVM: настоящие заголовок блока, доказательство счёта и
// подпись владельца — от локального узла anvil.
//
//   node zk/gen-evm-exit-fixture.mjs [адрес получателя для прогона в testnet]
//
// С адресом в файл добавляется раздел testnet: ещё один счёт той же цепочки с маленьким балансом
// и согласие на выход ЭТОМУ получателю — для scripts/runEvmExitTestnet.ts (адрес кошелька
// печатает сам скрипт прогона в режиме address). Без адреса раздел не пишется.
//
// Поднимает anvil, создаёт счёт с ОДНОРАЗОВЫМ ключом (cast wallet new; ключ живёт только в
// памяти этого скрипта и в файл не попадает), пополняет его, наполняет дерево счетов
// переводами, берёт у узла заголовок блока и eth_getProof, подписывает согласие на выход.
// Перед записью проверяет независимо от контракта: keccak собранного заголовка равен хешу
// блока со слов узла, а подпись восстанавливается в адрес счёта (@noble/curves).
// Результат: fixtures/evm_exit/exit.json. Инструменты — anvil и cast (Foundry) в .tools/.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import tonCore from '@ton/core';
import { keccak_256 } from '@noble/hashes/sha3.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = process.env.EVM_TOOLS ?? path.join(ROOT, '.tools');
const ANVIL = process.env.ANVIL ?? path.join(TOOLS, 'foundry', 'bin', 'anvil');
const CAST = process.env.CAST ?? path.join(TOOLS, 'foundry', 'bin', 'cast');
const CHAIN_ID = 362107787851n;
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
/** Строка-метка согласия — как EVM_EXIT_TAG в contracts/rollup/evm_exit.tolk. */
const TAG = Buffer.from('ton-zk-rollup:evm-exit:v1');
const ETH_PREFIX = Buffer.from('\x19Ethereum Signed Message:\n32');
/** Баланс выходящего счёта: 1,5 монеты и хвост меньше 1 gwei, который при выходе теряется. */
const BALANCE_WEI = 1_500_000_000_123_456_789n;
const DEV = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
/** Баланс счёта для прогона в testnet: 0,02 монеты и хвост — выплату покрывает запас развёртывания. */
const TESTNET_BALANCE_WEI = 20_000_000_987_654_321n;
/** Получатель выхода в прогоне testnet: кошелёк, которым идёт прогон (basechain). */
const testnetRecipient = process.argv[2] ? tonCore.Address.parse(process.argv[2]) : null;
if (testnetRecipient && testnetRecipient.workChain !== 0) throw new Error('получатель для testnet обязан быть в basechain');

const hex = (bytes) => '0x' + Buffer.from(bytes).toString('hex');
const bytes = (value) => Buffer.from(value.replace(/^0x/, ''), 'hex');
const keccak = (...parts) => Buffer.from(keccak_256(Buffer.concat(parts)));
const word = (value) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
const cast = (...args) => execFileSync(CAST, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
/** cast 1.9 часть ответов заворачивает в конверт {schema_version, success, data}. */
const unwrap = (answer) => (answer && typeof answer === 'object' && 'schema_version' in answer ? answer.data : answer);
const rpc = (...args) => cast(...args, '--rpc-url', RPC);
const json = (...args) => unwrap(JSON.parse(rpc(...args, '--json')));

// --- RLP: ровно то, что нужно для заголовка блока ---
const rlpLength = (length, offset) => {
    if (length < 56) return Buffer.from([offset + length]);
    const size = Buffer.from(length.toString(16).padStart(length.toString(16).length + (length.toString(16).length % 2), '0'), 'hex');
    return Buffer.concat([Buffer.from([offset + 55 + size.length]), size]);
};
const rlpString = (data) => (data.length === 1 && data[0] < 0x80 ? data : Buffer.concat([rlpLength(data.length, 0x80), data]));
const rlpList = (items) => {
    const payload = Buffer.concat(items);
    return Buffer.concat([rlpLength(payload.length, 0xc0), payload]);
};
/** Число: минимальная запись без ведущих нулей, ноль — пустая строка. */
const quantity = (value) => {
    const n = BigInt(value);
    if (n === 0n) return Buffer.alloc(0);
    const digits = n.toString(16);
    return Buffer.from(digits.padStart(digits.length + (digits.length % 2), '0'), 'hex');
};
function headerRlp(block) {
    const h = block.header ?? block;
    return rlpList(
        [
            bytes(h.parentHash),
            bytes(h.sha3Uncles),
            bytes(h.miner),
            bytes(h.stateRoot),
            bytes(h.transactionsRoot),
            bytes(h.receiptsRoot),
            bytes(h.logsBloom),
            quantity(h.difficulty),
            quantity(h.number),
            quantity(h.gasLimit),
            quantity(h.gasUsed),
            quantity(h.timestamp),
            bytes(h.extraData),
            bytes(h.mixHash),
            bytes(h.nonce),
            quantity(h.baseFeePerGas),
            bytes(h.withdrawalsRoot),
            quantity(h.blobGasUsed),
            quantity(h.excessBlobGas),
            bytes(h.parentBeaconBlockRoot),
        ].map(rlpString),
    );
}

const consentHash = (blockHash, recipientHash) => keccak(TAG, word(CHAIN_ID), bytes(blockHash), bytes(recipientHash));
/** Адрес, которому принадлежит подпись сообщения Ethereum под 32 байтами `consent`. */
function signerOf(signature, consent) {
    const raw = bytes(signature);
    const digest = keccak(ETH_PREFIX, consent);
    const point = secp256k1.Signature.fromBytes(raw.subarray(0, 64), 'compact')
        .addRecoveryBit(raw[64] - 27)
        .recoverPublicKey(digest)
        .toBytes(false);
    return hex(keccak(Buffer.from(point).subarray(1)).subarray(12));
}

/** Содержимое элементов списка RLP (узла дерева). */
function rlpItems(node) {
    const head = (offset) => {
        const b = node[offset];
        const long = (base) => [1 + b - base, Number(BigInt(hex(node.subarray(offset + 1, offset + 1 + b - base))))];
        if (b < 0x80) return [0, 1];
        if (b <= 0xb7) return [1, b - 0x80];
        if (b <= 0xbf) return long(0xb7);
        if (b <= 0xf7) return [1, b - 0xc0];
        return long(0xf7);
    };
    const [header, payload] = head(0);
    const items = [];
    for (let position = header; position < header + payload; ) {
        const [itemHeader, itemPayload] = head(position);
        items.push(node.subarray(position + itemHeader, position + itemHeader + itemPayload));
        position += itemHeader + itemPayload;
    }
    return items;
}
/**
 * Чем кончится проход по настоящему доказательству `proofNodes` для ЧУЖОГО адреса: пустой
 * потомок ветки или чужой лист — «ключа нет в дереве», иначе следующий узел не тот, на который
 * ссылается ветка. Считается по правилам дерева, независимо от контракта.
 */
function outcomeFor(address, proofNodes) {
    const nibbles = [...keccak(bytes(address))].flatMap((byte) => [byte >> 4, byte & 15]);
    for (let index = 0; index < proofNodes.length; index++) {
        const items = rlpItems(bytes(proofNodes[index]));
        // До первого узла с путём глубина равна номеру узла. Лист чужого ключа — «ключа нет»;
        // расширение эта функция не разбирает: пусть генератор откажет, а не угадает.
        if (items.length !== 17) {
            if ((items[0][0] & 0x20) === 0) throw new Error('в настоящем доказательстве расширение: outcomeFor его не разбирает');
            return 'keyNotInTrie';
        }
        const child = items[nibbles[index]];
        if (child.length === 0 || index + 1 === proofNodes.length) return 'keyNotInTrie';
        if (!keccak(bytes(proofNodes[index + 1])).equals(child)) return 'wrongNodeHash';
    }
    throw new Error('доказательство не кончается листом');
}

const FOUNDRY = execFileSync(ANVIL, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
// Чужой узел на этом порту дал бы фикстуру не от нашей цепочки.
let portBusy = true;
try {
    rpc('block-number');
} catch (error) {
    portBusy = false;
}
if (portBusy) throw new Error(`порт ${PORT} занят: на нём уже отвечает какой-то узел`);

const anvil = spawn(ANVIL, ['--chain-id', CHAIN_ID.toString(), '--port', String(PORT), '--hardfork', 'cancun', '--no-mining'], {
    stdio: 'ignore',
});
const stop = () => anvil.kill();
process.on('exit', stop);
try {
    for (let attempt = 0; ; attempt++) {
        try {
            rpc('block-number');
            break;
        } catch (error) {
            if (attempt > 50) throw new Error('anvil не поднялся');
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
    if (BigInt(rpc('chain-id')) !== CHAIN_ID) throw new Error('на порту отвечает узел другой цепочки');
    // Одноразовый ключ выходящего счёта.
    const wallet = unwrap(JSON.parse(cast('wallet', 'new', '--json')))[0];
    const key = wallet.private_key ?? wallet.privateKey;
    const account = wallet.address;
    if (!key || !account) throw new Error('cast wallet new не выдал ключ и адрес');
    // Второй одноразовый счёт — для прогона в testnet.
    const testnetWallet = testnetRecipient ? unwrap(JSON.parse(cast('wallet', 'new', '--json')))[0] : null;
    const testnetKey = testnetWallet && (testnetWallet.private_key ?? testnetWallet.privateKey);

    let nonce = 0;
    const send = (to, value) =>
        rpc('send', '--async', '--unlocked', '--from', DEV, '--nonce', String(nonce++), '--gas-limit', '21000', '--value', value.toString(), to);
    send(account, BALANCE_WEI);
    if (testnetWallet) send(testnetWallet.address, TESTNET_BALANCE_WEI);
    // Наполняем дерево счетов: с несколькими десятками счетов путь к листу идёт через ветки.
    for (let i = 0; i < 60; i++) send(hex(keccak(Buffer.from(`filler-${i}`)).subarray(12)), 1_000_000_000n + BigInt(i));
    rpc('rpc', 'evm_mine');

    const block = json('block', 'latest');
    const header = headerRlp(block);
    const blockHash = (block.header ?? block).hash;
    if (hex(keccak(header)) !== blockHash.toLowerCase()) throw new Error('заголовок собран неверно: keccak не равен хешу блока');
    const number = BigInt((block.header ?? block).number).toString();
    const proofOf = (address) => json('proof', address, '--block', number);
    const proof = proofOf(account);
    if (BigInt(proof.balance) !== BALANCE_WEI) throw new Error('баланс счёта не тот, что отправляли');
    const otherProof = proofOf(DEV);

    // Получатели в TON — хеши адресов basechain; второй нужен для отрицательных тестов.
    const recipientHash = hex(keccak(Buffer.from('evm-exit-recipient-1')));
    const otherRecipientHash = hex(keccak(Buffer.from('evm-exit-recipient-2')));
    const signWith = (secretKey, recipient) => cast('wallet', 'sign', '--private-key', secretKey, hex(consentHash(blockHash, recipient)));
    const sign = (recipient) => signWith(key, recipient);
    const signature = sign(recipientHash);
    const signatureForOtherRecipient = sign(otherRecipientHash);
    for (const [signed, recipient] of [[signature, recipientHash], [signatureForOtherRecipient, otherRecipientHash]]) {
        if (signerOf(signed, consentHash(blockHash, recipient)) !== account.toLowerCase()) {
            throw new Error('подпись не восстанавливается в адрес счёта: формат согласия не тот');
        }
    }

    // --- счёт для прогона в testnet: та же цепочка, тот же блок, получатель — кошелёк прогона ---
    let testnet = null;
    if (testnetWallet) {
        const testnetProof = proofOf(testnetWallet.address);
        if (BigInt(testnetProof.balance) !== TESTNET_BALANCE_WEI) throw new Error('баланс счёта для testnet не тот, что отправляли');
        const testnetRecipientHash = hex(testnetRecipient.hash);
        const testnetSignature = signWith(testnetKey, testnetRecipientHash);
        if (signerOf(testnetSignature, consentHash(blockHash, testnetRecipientHash)) !== testnetWallet.address.toLowerCase()) {
            throw new Error('подпись для testnet не восстанавливается в адрес счёта');
        }
        testnet = {
            note: 'Счёт той же цепочки для прогона в testnet (scripts/runEvmExitTestnet.ts): согласие подписано под кошелёк прогона. Ключ одноразовый.',
            account: testnetWallet.address.toLowerCase(),
            balanceWei: TESTNET_BALANCE_WEI.toString(),
            accountProof: testnetProof.accountProof,
            recipient: testnetRecipient.toString({ testOnly: true }),
            recipientHash: testnetRecipientHash,
            consentHash: hex(consentHash(blockHash, testnetRecipientHash)),
            signature: testnetSignature,
        };
    }

    // Какой адрес восстановится, если подпись под другого получателя предъявить этому, и чем
    // для него кончится проход по доказательству: тест ждёт точный код, а не «какой-нибудь».
    const otherConsentSigner = signerOf(signatureForOtherRecipient, consentHash(blockHash, recipientHash));
    const otherConsentExpect = outcomeFor(otherConsentSigner, proof.accountProof);

    // --- формы дерева, которых в маленькой цепочке не встретить: собраны по правилам Ethereum ---
    // Подписывает ещё один одноразовый ключ; подпись зависит от хеша «блока», а он — от дерева.
    // Узлы с верным хешем и неверной формой тоже здесь: настоящий узел их не выдаст, но каждая
    // проверка разбора в контракте обязана иметь случай, на котором видно, что она работает.
    const secret = secp256k1.utils.randomSecretKey();
    const owned = keccak(Buffer.from(secp256k1.getPublicKey(secret, false)).subarray(1)).subarray(12);
    const keyPath = [...keccak(owned)].flatMap((byte) => [byte >> 4, byte & 15]);
    const syntheticRecipient = keccak(Buffer.from('evm-exit-recipient-3'));
    const syntheticBalance = 2_000_000_000_000_000_000n;
    /** Больше 2^64 wei: баланс занимает девять байт. */
    const bigBalance = 25_000_000_000_987_654_321n;
    const hexPrefix = (nibbles, leaf) => {
        const flags = (leaf ? 2 : 0) + (nibbles.length % 2);
        const padded = nibbles.length % 2 ? [flags, ...nibbles] : [flags, 0, ...nibbles];
        return Buffer.from(Array.from({ length: padded.length / 2 }, (_, i) => (padded[2 * i] << 4) | padded[2 * i + 1]));
    };
    const EMPTY = rlpString(Buffer.alloc(0));
    const EMPTY_ROOT = bytes('56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421');
    const EMPTY_CODE = bytes('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    const hashRef = (node) => rlpString(keccak(node));
    const pathItem = (nibbles, leaf) => rlpString(hexPrefix(nibbles, leaf));
    /** Список счёта; поля можно подменить уже закодированными элементами. */
    const accountRlp = (balance, { nonce = rlpString(quantity(1n)), storage = rlpString(EMPTY_ROOT), code = rlpString(EMPTY_CODE) } = {}) =>
        rlpList([nonce, rlpString(quantity(balance)), storage, code]);
    const leafNode = (nibbles, balance, leaf = true, fields = {}) =>
        rlpList([pathItem(nibbles, leaf), rlpString(accountRlp(balance, fields))]);
    const extensionNode = (nibbles, child, leaf = false) => rlpList([pathItem(nibbles, leaf), hashRef(child)]);
    // Ветка: под полубайтом `at` — узел `child`, под соседним — посторонний хеш.
    const branchItems = (at, child) =>
        Array.from({ length: 16 }, (_, index) =>
            index === at ? hashRef(child) : index === (at + 1) % 16 ? rlpString(Buffer.alloc(32, 0x55)) : EMPTY,
        );
    const branchNode = (at, child) => rlpList([...branchItems(at, child), EMPTY]);
    // Полная ветка, как в большом дереве: все шестнадцать потомков заняты.
    const fullBranch = (at, child, label) =>
        rlpList([
            ...Array.from({ length: 16 }, (_, index) =>
                index === at ? hashRef(child) : rlpString(keccak(Buffer.from(`sibling-${label}-${index}`))),
            ),
            EMPTY,
        ]);
    // Заголовок с этим корнем состояния; остальные поля контракт не читает. `replace` подменяет
    // поля по номеру уже закодированными элементами.
    const headerWith = (stateRoot, replace = {}) =>
        rlpList(
            [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(20, 3), stateRoot, Buffer.alloc(32, 4), Buffer.alloc(256, 0), quantity(7n)]
                .map(rlpString)
                .map((item, index) => replace[index] ?? item),
        );
    const cases = [];
    /**
     * `hints` — вид каждого узла, если его надо подсказать не так, как он выглядит; `header` —
     * подмена полей заголовка; `balanceWei` — баланс листа, если он не обычный; `underfunded` —
     * у контракта денег меньше суммы выхода; `gas` — имя замера газа.
     */
    const addCase = (name, proofNodes, expect, { hints, header: replace, balanceWei = syntheticBalance, underfunded, gas } = {}) => {
        const header = headerWith(keccak(proofNodes[0]), replace);
        const hash = keccak(header);
        const consent = consentHash(hex(hash), hex(syntheticRecipient));
        const signed = secp256k1.sign(keccak(ETH_PREFIX, consent), secret, { prehash: false, format: 'recovered' });
        // noble отдаёт recovery ‖ r ‖ s; кошельки — r ‖ s ‖ v, где v = 27 + recovery.
        const signature = hex(Buffer.concat([Buffer.from(signed.subarray(1)), Buffer.from([27 + signed[0]])]));
        if (signerOf(signature, consent) !== hex(owned)) throw new Error('подпись собранного случая не восстанавливается в адрес');
        if (cases.some((existing) => existing.name === name)) throw new Error(`случай «${name}» уже есть`);
        cases.push({
            name,
            expect,
            balanceWei: balanceWei.toString(),
            ...(hints ? { hints } : {}),
            ...(underfunded ? { underfunded } : {}),
            ...(gas ? { gas } : {}),
            blockHash: hex(hash),
            headerRlp: hex(header),
            proof: proofNodes.map(hex),
            signature,
        });
    };
    {
        const fullLeaf = leafNode(keyPath, syntheticBalance);
        const deepLeaf = leafNode(keyPath.slice(4), syntheticBalance);
        const deepBranch = branchNode(keyPath[3], deepLeaf);
        const oddLeaf = leafNode(keyPath.slice(3), syntheticBalance);
        const oddBranch = branchNode(keyPath[2], oddLeaf);
        const foreign = [...keyPath];
        foreign[63] ^= 1;
        const shallowLeaf = leafNode(keyPath.slice(1), syntheticBalance);

        // --- выход проходит ---
        addCase('единственный счёт: лист в корне с путём во весь ключ', [fullLeaf], 'paid');
        addCase('расширение с нечётным путём, ветка и лист', [extensionNode(keyPath.slice(0, 3), deepBranch), deepBranch, deepLeaf], 'paid');
        addCase('расширение с чётным путём, ветка и лист с нечётным путём', [extensionNode(keyPath.slice(0, 2), oddBranch), oddBranch, oddLeaf], 'paid');
        {
            // Путь из одного байта (меньше 0x80 — в RLP он сам себе строка): самая частая форма расширения.
            const leaf = leafNode(keyPath.slice(2), syntheticBalance);
            const branch = branchNode(keyPath[1], leaf);
            addCase('расширение на один полубайт, ветка и лист', [extensionNode(keyPath.slice(0, 1), branch), branch, leaf], 'paid');
        }
        {
            const leaf = leafNode([], syntheticBalance);
            const branch = branchNode(keyPath[63], leaf);
            addCase('расширение на 63 полубайта, ветка на последнем полубайте и лист с пустым путём', [extensionNode(keyPath.slice(0, 63), branch), branch, leaf], 'paid');
        }
        {
            const leaf = leafNode(keyPath.slice(63), syntheticBalance);
            const branch = branchNode(keyPath[62], leaf);
            addCase('расширение на 62 полубайта, ветка и лист с путём в один полубайт', [extensionNode(keyPath.slice(0, 62), branch), branch, leaf], 'paid');
        }
        const bigNonce = { nonce: rlpString(quantity(0x1234n)) };
        addCase('большой nonce и баланс больше 2^64 wei', [leafNode(keyPath, bigBalance, true, bigNonce)], 'paid', { balanceWei: bigBalance });
        {
            // Десять полных веток и лист: глубина дерева с триллионом счетов. Замер газа.
            const nodes = [leafNode(keyPath.slice(10), syntheticBalance)];
            for (let depth = 9; depth >= 0; depth--) nodes.unshift(fullBranch(keyPath[depth], nodes[0], depth));
            addCase('глубокое дерево: десять полных веток и лист', nodes, 'paid', { gas: 'forceExitEvmDeep' });
        }

        // --- путь и вид узла ---
        addCase('лист с признаком расширения в пути листом не считается', [leafNode(keyPath, syntheticBalance, false)], 'badRlp');
        addCase('расширение с признаком листа в пути расширением не считается', [extensionNode(keyPath.slice(0, 3), deepBranch, true), deepBranch, deepLeaf], 'keyNotInTrie');
        addCase('лист с путём не до конца ключа', [leafNode(keyPath.slice(0, 62), syntheticBalance)], 'keyNotInTrie');
        addCase('лист чужого ключа', [leafNode(foreign, syntheticBalance)], 'keyNotInTrie');
        addCase('расширение, чей путь расходится с ключом', [extensionNode([keyPath[0], keyPath[1], keyPath[2] ^ 1], deepBranch), deepBranch, deepLeaf], 'keyNotInTrie');
        addCase('пустой потомок ветки на пути ключа', [branchNode((keyPath[0] + 2) % 16, shallowLeaf), shallowLeaf], 'keyNotInTrie');
        addCase('лист с путём в 65 полубайтов', [leafNode([keyPath[0], ...keyPath], syntheticBalance)], 'keyNotInTrie');
        {
            // Две ветки и лист с путём в 63 полубайта: 2 + 63 > 64 при любом ключе (у случая выше
            // исход без проверки зависит от первого полубайта ключа).
            const leaf = leafNode(keyPath.slice(1), syntheticBalance);
            const second = branchNode(keyPath[1], leaf);
            addCase('под двумя ветками лист, чей путь выходит за конец ключа', [branchNode(keyPath[0], second), second, leaf], 'keyNotInTrie');
        }
        {
            const branch = branchNode(0, fullLeaf);
            addCase('расширение на 64 полубайта и ветка под ним', [extensionNode(keyPath, branch), branch], 'keyNotInTrie', { hints: [false, true] });
        }
        {
            // Ветка, первый потомок которой похож на путь листа (признак 2, 62 полубайта), стоит на
            // глубине 2: первой её останавливает сравнение пути с ключом (без него — разбор значения).
            const fake = rlpList([rlpString(Buffer.concat([Buffer.from([0x20]), Buffer.alloc(31, 0x77)])), ...Array(15).fill(EMPTY), EMPTY]);
            const second = branchNode(keyPath[1], fake);
            addCase('ветка, выданная за лист, расходится с ключом', [branchNode(keyPath[0], second), second, fake], 'keyNotInTrie', { hints: [true, true, false] });
        }
        const rawPath = (first) => rlpString(Buffer.from([first, (keyPath[0] << 4) | keyPath[1]]));
        addCase('путь с неизвестным признаком', [rlpList([rawPath(0x40), hashRef(oddBranch)]), oddBranch, oddLeaf], 'badNode', { hints: [false, true, false] });
        addCase('чётный путь с ненулевым добавочным полубайтом', [rlpList([rawPath(0x0f), hashRef(oddBranch)]), oddBranch, oddLeaf], 'badNode', { hints: [false, true, false] });
        addCase('узел с пустой строкой вместо пути', [rlpList([EMPTY, rlpString(accountRlp(syntheticBalance))])], 'badRlp', { hints: [false] });

        // --- узел разобран не до конца или собран не по форме ---
        addCase('расширение с пустым путём', [extensionNode([], fullLeaf), fullLeaf], 'badNode');
        addCase('расширение без потомка', [rlpList([pathItem(keyPath.slice(0, 3), false), EMPTY])], 'badNode');
        addCase('расширение с третьим элементом', [rlpList([pathItem(keyPath.slice(0, 3), false), hashRef(deepBranch), EMPTY]), deepBranch, deepLeaf], 'badNode', { hints: [false, true, false] });
        addCase('лист с третьим элементом', [rlpList([pathItem(keyPath, true), rlpString(accountRlp(syntheticBalance)), EMPTY])], 'badNode', { hints: [false] });
        addCase('ветка с восемнадцатью элементами', [rlpList([...branchItems(keyPath[0], shallowLeaf), EMPTY, EMPTY]), shallowLeaf], 'badNode', { hints: [true, false] });
        addCase('ветка с непустым семнадцатым элементом', [rlpList([...branchItems(keyPath[0], shallowLeaf), Buffer.from([0x01])]), shallowLeaf], 'badNode', { hints: [true, false] });
        addCase('ветка из двух элементов', [rlpList([hashRef(shallowLeaf), hashRef(fullLeaf)])], 'badNode', { hints: [true] });
        addCase('узел начинается не с признака списка', [Buffer.concat([Buffer.from([0x05]), pathItem(keyPath, true), rlpString(accountRlp(syntheticBalance))])], 'badRlp', { hints: [false] });

        // --- значение счёта ---
        addCase('баланс меньше нанотона', [leafNode(keyPath, 999_999_999n)], 'nothingToExit', { balanceWei: 999_999_999n });
        addCase('большой nonce и нулевой баланс', [leafNode(keyPath, 0n, true, bigNonce)], 'nothingToExit', { balanceWei: 0n });
        addCase('баланс больше денег контракта', [leafNode(keyPath, bigBalance, true, bigNonce)], 'insufficientFunds', { balanceWei: bigBalance, underfunded: true });
        addCase('nonce длиной 33 байта', [leafNode(keyPath, syntheticBalance, true, { nonce: rlpString(Buffer.alloc(33, 1)) })], 'badRlp');
        addCase('корень хранилища счёта пуст', [leafNode(keyPath, syntheticBalance, true, { storage: EMPTY })], 'badRlp');
        addCase('хеш кода счёта пуст', [leafNode(keyPath, syntheticBalance, true, { code: EMPTY })], 'badRlp');
        addCase('перед списком счёта лишний байт вместо признака строки', [rlpList([pathItem(keyPath, true), Buffer.from([0x7f]), accountRlp(syntheticBalance)])], 'badRlp', { hints: [false] });

        // --- заголовок с верным хешем и неверной формой ---
        addCase('заголовок без хеша родителя', [fullLeaf], 'badRlp', { header: { 0: EMPTY } });
        addCase('заголовок без хеша «дядей»', [fullLeaf], 'badRlp', { header: { 1: EMPTY } });
        addCase('заголовок со списком на месте получателя наград', [fullLeaf], 'badRlp', { header: { 2: rlpList([Buffer.alloc(20, 3)]) } });
        addCase('заголовок без корня состояния', [fullLeaf], 'badRlp', { header: { 3: EMPTY } });
    }

    const out = {
        source: `Сгенерировано zk/gen-evm-exit-fixture.mjs (${FOUNDRY}); не редактировать вручную`,
        note: 'Настоящие заголовок блока EVM, доказательство счёта (eth_getProof) и подпись согласия на аварийный выход. Ключ счёта одноразовый и в файл не попадает.',
        chainId: CHAIN_ID.toString(),
        blockNumber: number,
        blockHash,
        stateRoot: (block.header ?? block).stateRoot,
        headerRlp: hex(header),
        account: account.toLowerCase(),
        balanceWei: BALANCE_WEI.toString(),
        accountProof: proof.accountProof,
        recipientHash,
        consentHash: hex(consentHash(blockHash, recipientHash)),
        signature,
        otherRecipientHash,
        signatureForOtherRecipient,
        otherConsentSigner,
        otherConsentExpect,
        otherAccount: DEV.toLowerCase(),
        otherAccountProof: otherProof.accountProof,
        ...(testnet ? { testnet } : {}),
        synthetic: {
            note: 'Формы дерева, собранные по правилам Ethereum, и узлы с верным хешем, но неверной формой — по случаю на каждую проверку разбора в контракте. Ключ одноразовый.',
            account: hex(owned),
            recipientHash: hex(syntheticRecipient),
            cases,
        },
    };
    const dir = path.join(ROOT, 'fixtures', 'evm_exit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'exit.json'), JSON.stringify(out, null, 1) + '\n');
    console.log(`Записано: fixtures/evm_exit/exit.json (блок ${number}, узлов в доказательстве: ${proof.accountProof.length}, заголовок ${header.length} байт)`);
} finally {
    stop();
}
