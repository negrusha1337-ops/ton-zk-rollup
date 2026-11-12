// Генерация Tolk-верификаторов из fixtures/<имя>/verification_key.json
// утилитой export-ton-verifier. Circom для этого не нужен.
//
//   multiplier, pubN -> contracts/generated/verifier_<имя>.tolk  (самостоятельный контракт)
//   hash4            -> contracts/generated/hash_verifier_lib.tolk (библиотека-структура,
//                       которую импортирует contracts/hashed_inputs_verifier.tolk)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CIRCUITS } from './circuits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'contracts', 'generated');
const EXPORTER = path.join(ROOT, 'node_modules', '.bin', 'export-ton-verifier');
const BANNER = '// СГЕНЕРИРОВАНО: npm run zk:verifiers. Не править руками.\n';

const LIB_CIRCUIT = 'hash4';
const LIB_STRUCT = 'HashVerifier';

function exportVerifier(vkey, dest, extraArgs = []) {
    try {
        execFileSync(EXPORTER, [vkey, dest, '--tolk', '--force', ...extraArgs], { cwd: ROOT, stdio: 'pipe' });
    } catch (err) {
        throw new Error(
            `export-ton-verifier не смог обработать ${path.relative(ROOT, vkey)}: ${err.stderr || err.message}`,
        );
    }
}

/**
 * В режиме --contract-name генератор всё равно добавляет объявление контракта
 * и точки входа (onInternalMessage + get-метод). Чтобы встроить верификатор в
 * другой контракт, их нужно убрать — иначе будет два onInternalMessage.
 */
function stripStandaloneParts(source) {
    const tailMarker = '// Convenience standalone entrypoints.';
    const tailAt = source.indexOf(tailMarker);
    const headMatch = source.match(new RegExp(`^contract ${LIB_STRUCT} \\{[\\s\\S]*?^\\}\\n`, 'm'));
    if (tailAt === -1 || !headMatch) {
        throw new Error(
            'Шаблон export-ton-verifier изменился: не найдены объявление контракта или маркер точек входа. ' +
                'Обнови stripStandaloneParts в zk/gen-verifiers.mjs.',
        );
    }
    return source.slice(0, tailAt).replace(headMatch[0], '').trimEnd() + '\n';
}

mkdirSync(OUT, { recursive: true });
let failed = false;

// Схемы на других кривых (BN254) пропускаем: генератор работает только с BLS12-381.
for (const { name } of CIRCUITS.filter((c) => !c.curve)) {
    const vkey = path.join(ROOT, 'fixtures', name, 'verification_key.json');
    if (!existsSync(vkey)) {
        console.error(`[${name}] нет ${path.relative(ROOT, vkey)} — сначала npm run zk:build`);
        failed = true;
        continue;
    }

    const isLib = name === LIB_CIRCUIT;
    const dest = path.join(OUT, isLib ? 'hash_verifier_lib.tolk' : `verifier_${name}.tolk`);
    exportVerifier(vkey, dest, isLib ? ['--contract-name', LIB_STRUCT] : []);

    const generated = readFileSync(dest, 'utf8');
    writeFileSync(dest, BANNER + (isLib ? stripStandaloneParts(generated) : generated));
    console.log(`[${name}] -> ${path.relative(ROOT, dest)}`);
}

process.exit(failed ? 1 : 0);
