// Привязка пруфов и ключа контракта к исходникам программы батча EVM (zkvm-evm/).
//
// То же, что zk/program-binding.mjs для программ zkvm/, с другим набором корней. Хеш исходников
// записан в fixtures/evm_batches/program.json (его пишет zkvm-evm/host --vkeys) и сверяется с
// деревом исходников: при выводе ключа контракта, при импорте пруфа и в тестах.
//
// Алгоритм обязан совпадать с zkvm-evm/host/src/sources.rs:
//   файлы *.rs, *.toml, *.lock из SOURCE_ROOTS; каталог target непосредственно внутри корня
//   пропускается; пути относительно корня репозитория через «/», сортировка по байтам пути;
//   sha256( для каждого файла: путь ‖ 0x00 ‖ длина (u64, big-endian) ‖ содержимое ).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVM_FIXTURES = path.join(ROOT, 'fixtures', 'evm_batches');
export const EVM_PROGRAM_KEYS_FILE = path.join(EVM_FIXTURES, 'program.json');

const SOURCE_ROOTS = [
    'zkvm-evm/Cargo.toml',
    'zkvm-evm/lib/Cargo.toml',
    'zkvm-evm/lib/src',
    'zkvm-evm/program',
    'zkvm-evm/vendor/rsp-mpt',
];
const SOURCE_EXTENSIONS = ['.rs', '.toml', '.lock'];

function collect(absolute, relative, isRoot, out) {
    if (statSync(absolute).isDirectory()) {
        for (const name of readdirSync(absolute)) {
            const child = path.join(absolute, name);
            // Каталог сборки cargo лежит прямо в корне крейта; target глубже — обычные исходники.
            if (isRoot && name === 'target' && statSync(child).isDirectory()) continue;
            collect(child, `${relative}/${name}`, false, out);
        }
    } else if (SOURCE_EXTENSIONS.includes(path.extname(absolute))) {
        out.push([relative, absolute]);
    }
}

export function evmSourcesSha256(root = ROOT) {
    const files = [];
    for (const sourceRoot of SOURCE_ROOTS) collect(path.join(root, sourceRoot), sourceRoot, true, files);
    files.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
    const hash = createHash('sha256');
    for (const [relative, absolute] of files) {
        const content = readFileSync(absolute);
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(content.length));
        hash.update(Buffer.from(relative)).update(Buffer.from([0])).update(length).update(content);
    }
    return hash.digest('hex');
}

/**
 * Ключ программы батча EVM из program.json. С `requireFresh` отказывает, если файл описывает
 * не те исходники, что лежат в дереве: значит, ключ посчитан для прежней программы.
 */
export function loadEvmProgramKeys({ requireFresh = true } = {}) {
    const keys = JSON.parse(readFileSync(EVM_PROGRAM_KEYS_FILE, 'utf8'));
    for (const field of ['programVKey', 'programElfSha256', 'sourcesSha256']) {
        if (typeof keys[field] !== 'string') {
            throw new Error(`В fixtures/evm_batches/program.json нет поля ${field}: запустите zkvm-evm/host --vkeys`);
        }
    }
    if (requireFresh) {
        const actual = evmSourcesSha256();
        if (keys.sourcesSha256 !== actual) {
            throw new Error(
                `fixtures/evm_batches/program.json описывает другие исходники (в файле ${keys.sourcesSha256}, в дереве ` +
                    `${actual}). Пересоберите zkvm-evm/host и запустите --vkeys.`,
            );
        }
    }
    return keys;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log(evmSourcesSha256());
}
