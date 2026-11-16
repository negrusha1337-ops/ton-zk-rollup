// Спайк агрегации: ожидаемые 11 слов агрегата блоков first..last — независимо от хоста и гостя,
// из отчётов блоков цепочки Reth на маке (fixtures/evm_batches/reth/block-N.json, поле
// publicValuesBytes). Печатает 0x… для check-proof.mjs --public-values.
//
//   node zkvm-evm/spike-aggregate/ton/expected-aggregate.mjs <first> <last>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const [first, last] = process.argv.slice(2).map(Number);
if (!(first >= 1 && last >= first)) throw new Error('нужны <first> <last>');
const blocks = [];
for (let n = first; n <= last; n++) {
    const report = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/evm_batches/reth', `block-${n}.json`), 'utf8'));
    const bytes = Buffer.from(report.publicValuesBytes.replace(/^0x/, ''), 'hex');
    if (bytes.length !== 352) throw new Error(`block-${n}.json: publicValuesBytes не 352 байта`);
    blocks.push(bytes);
}
const word = (bytes, i) => bytes.subarray(i * 32, (i + 1) * 32);
for (let i = 1; i < blocks.length; i++) {
    for (const [left, right] of [[0, 0], [2, 1], [5, 4], [7, 6], [9, 8]]) {
        if (!word(blocks[i - 1], left).equals(word(blocks[i], right))) throw new Error(`блоки ${first + i - 1} и ${first + i} не сцепляются`);
    }
}
const batchHash = createHash('sha256').update(Buffer.concat(blocks.map((b) => word(b, 3)))).digest();
const [a, z] = [blocks[0], blocks[blocks.length - 1]];
const out = Buffer.concat([word(a, 0), word(a, 1), word(z, 2), batchHash, word(a, 4), word(z, 5), word(a, 6), word(z, 7), word(a, 8), word(z, 9), word(z, 10)]);
console.log('0x' + out.toString('hex'));
