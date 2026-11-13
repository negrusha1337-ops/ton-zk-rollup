// Привязка пруфов и ключа контракта к исходникам программ zkVM.
//
// Ключ программы SP1 (programVKey) определяется её ELF, а ELF — исходниками. Если после
// правки программы оставить прежние пруфы и прежний ключ, контракт будет проверять
// утверждение СТАРОЙ программы, и ни один тест этого не заметит. Поэтому хеш исходников
// записан в fixtures/zkvm_batches/program.json (его пишет zkvm/script --vkeys) и
// сверяется с деревом исходников: здесь, при импорте пруфа, и в tests/ProgramBinding.spec.ts.
//
// Алгоритм хеша обязан совпадать с zkvm/script/src/sources.rs:
//   файлы *.rs, *.toml, *.lock из SOURCE_ROOTS; каталог target непосредственно внутри корня
//   пропускается; пути относительно zkvm/ через «/», сортировка по байтам пути;
//   sha256( для каждого файла: путь ‖ 0x00 ‖ длина (u64, big-endian) ‖ содержимое ).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ZKVM_DIR = path.join(ROOT, 'zkvm');
export const PROGRAM_KEYS_FILE = path.join(ROOT, 'fixtures', 'zkvm_batches', 'program.json');

const SOURCE_ROOTS = ['Cargo.toml', 'Cargo.lock', 'lib', 'exit-lib', 'program', 'exit-program'];
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

/** Исходники программ: [путь относительно zkvm/, путь на диске], в порядке хеширования. */
export function sourceFiles(zkvmDir = ZKVM_DIR) {
    const files = [];
    for (const root of SOURCE_ROOTS) collect(path.join(zkvmDir, root), root, true, files);
    return files.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
}

export function sourcesSha256(zkvmDir = ZKVM_DIR) {
    const hash = createHash('sha256');
    for (const [relative, absolute] of sourceFiles(zkvmDir)) {
        const content = readFileSync(absolute);
        const length = Buffer.alloc(8);
        length.writeBigUInt64BE(BigInt(content.length));
        hash.update(Buffer.from(relative)).update(Buffer.from([0])).update(length).update(content);
    }
    return hash.digest('hex');
}

/**
 * Ключи программ из program.json. С `requireFresh` отказывает, если файл описывает
 * не те исходники, что лежат в дереве: значит, ключи посчитаны для прежней программы.
 */
export function loadProgramKeys({ requireFresh = true } = {}) {
    const keys = JSON.parse(readFileSync(PROGRAM_KEYS_FILE, 'utf8'));
    for (const field of ['programVKey', 'exitProgramVKey', 'sourcesSha256']) {
        if (typeof keys[field] !== 'string') throw new Error(`В program.json нет поля ${field}: запустите zkvm/script --vkeys`);
    }
    if (requireFresh) {
        const actual = sourcesSha256();
        if (keys.sourcesSha256 !== actual) {
            throw new Error(
                `program.json описывает другие исходники программ (в файле ${keys.sourcesSha256}, в дереве ${actual}). ` +
                    'Пересоберите zkvm/script и запустите --vkeys.',
            );
        }
    }
    return keys;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    console.log(sourcesSha256());
}
