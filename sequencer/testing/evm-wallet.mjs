// Подпись транзакций EVM для тестов сборщика блоков (tests/SequencerReth.spec.ts). Отдельным
// процессом, потому что jest не импортирует @noble/curves (только ESM).
//
//   echo '{"secret":"<hex>","transactions":[…]}' | node sequencer/testing/evm-wallet.mjs
//
// Ключ приходит на stdin (не в аргументах командной строки) и никуда не пишется: тест создаёт
// его в памяти на каждый запуск. Ответ — адрес счёта и байты EIP-2718 каждой транзакции.
// Поле `signature: "sZero"` — подпись с s = 0 (не восстанавливается), для случая «негодная подпись».
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const bytes = (value) => Buffer.from(String(value).replace(/^0x/, ''), 'hex');
const int = (value) => {
    const big = BigInt(value);
    if (big === 0n) return Buffer.alloc(0);
    const text = big.toString(16);
    return Buffer.from(text.length % 2 ? '0' + text : text, 'hex');
};
const lengthPrefix = (length, offset) => {
    if (length < 56) return Buffer.from([offset + length]);
    const size = int(length);
    return Buffer.concat([Buffer.from([offset + 55 + size.length]), size]);
};
const rlp = (item) => {
    if (Array.isArray(item)) {
        const payload = Buffer.concat(item.map(rlp));
        return Buffer.concat([lengthPrefix(payload.length, 0xc0), payload]);
    }
    if (item.length === 1 && item[0] < 0x80) return item;
    return Buffer.concat([lengthPrefix(item.length, 0x80), item]);
};
const keccak = (data) => Buffer.from(keccak_256(data));

function sign(secret, fields) {
    const { type = 2, chainId, nonce, gas, to = null, value = 0, data = '0x', gasPrice = 2_000_000_000, maxFee = 2_000_000_000, maxPriority = 1_000_000_000 } = fields;
    const target = to === null ? Buffer.alloc(0) : bytes(to);
    const signature = (hash) => {
        const s = secp256k1.Signature.fromBytes(secp256k1.sign(hash, secret, { prehash: false, format: 'recovered' }), 'recovered');
        return fields.signature === 'sZero' ? { r: s.r, s: 0n, recovery: s.recovery } : s;
    };
    if (type === 0) {
        const base = [int(nonce), int(gasPrice), int(gas), target, int(value), bytes(data)];
        const { r, s, recovery } = signature(keccak(rlp([...base, int(chainId), int(0), int(0)])));
        return rlp([...base, int(BigInt(chainId) * 2n + 35n + BigInt(recovery)), int(r), int(s)]);
    }
    const payload =
        type === 1
            ? [int(chainId), int(nonce), int(gasPrice), int(gas), target, int(value), bytes(data), []]
            : [int(chainId), int(nonce), int(maxPriority), int(maxFee), int(gas), target, int(value), bytes(data), []];
    const prefix = Buffer.from([type]);
    const { r, s, recovery } = signature(keccak(Buffer.concat([prefix, rlp(payload)])));
    return Buffer.concat([prefix, rlp([...payload, int(recovery), int(r), int(s)])]);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const secret = bytes(request.secret);
const address = '0x' + keccak(Buffer.from(secp256k1.getPublicKey(secret, false)).subarray(1)).subarray(12).toString('hex');
const raw = (request.transactions ?? []).map((fields) => '0x' + sign(secret, fields).toString('hex'));
process.stdout.write(JSON.stringify({ address, raw }));
