// Ключ верификации rollup-контракта — из исходников, БЕЗ пруфа.
//
//   node zk/gen-rollup-key.mjs [каталог с Groth16Verifier.sol и SP1VerifierGroth16.sol]
//   node zk/gen-rollup-key.mjs --check     # пересчитать key.json и сравнить, ничего не записывая
//
// По умолчанию берёт файлы из ~/.sp1/circuits/groth16/v6.1.0 (их скачивает SP1 SDK).
// Результат: fixtures/zkvm_batches/key.json — части ключа для загрузки в контракт и
// хеши, которые после загрузки обязаны вернуть get-методы keyHash и exitKeyHash.
//
// Зачем отдельно от пруфов. Раньше ключ контракта собирался из фикстуры пруфа: что
// именно зафиксировано в контракте, мог проверить только тот, кто его загружал. Теперь
// ключ — функция трёх вещей, каждую из которых может проверить посторонний:
//   1) ключ Groth16-схемы SP1 (закреплён в zk/sp1-pins.json, сверен с репозиторием Succinct);
//   2) ключи двух программ zkVM (fixtures/zkvm_batches/program.json, привязаны к хешу
//      исходников — zk/program-binding.mjs);
//   3) постоянные входы верификатора SP1: exitCode = 0, vkRoot, nonce = 0.
// Режим --check пересчитывает ВСЁ содержимое key.json — части ключа, хеши, IC0 выхода — из
// сохранённого в нём ключа схемы (сверенного с закреплением по отпечатку) и program.json, и
// сравнивает. Файлы из ~/.sp1 ему не нужны. Без него сверялись бы только поля-описания, и
// файл с честными описаниями и чужими частями ключа прошёл бы все проверки, пока нет пруфов.
//
// Пять публичных входов схемы: [programVKey, дайджест, exitCode, vkRoot, nonce]. Переменный —
// только дайджест; остальные четыре свёрнуты в IC0. Ключ программы выхода отличается от
// ключа программы батчей одним IC0.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ton from '@ton/core';
import { buildVerificationKeyData, parseVerificationKey } from './bn254-onchain.mjs';
import { loadProgramKeys, ROOT } from './program-binding.mjs';
import {
    loadSp1Verifier,
    pinnedVersion,
    sp1CircuitDir,
    verificationKeyFingerprint,
    verificationKeyJson,
} from './sp1-verifier.mjs';

const CIRCUIT_VERSION = 'v6.1.0';
/** Номер дайджеста публичных значений среди входов схемы — единственный переменный вход. */
export const DIGEST_INPUT = 1;

/** Входы схемы SP1 для программы с ключом `programVKey`; на месте дайджеста — заглушка. */
export const sp1Inputs = (programVKey, vkRoot, digest = 0n) => [BigInt(programVKey), digest, 0n, BigInt(vkRoot), 0n];

/** Ключ контракта для программы: всё, кроме дайджеста, свёрнуто в IC0. */
export function rollupKeyFor(verifier, programVKey) {
    return buildVerificationKeyData(verifier.key, sp1Inputs(programVKey, verifier.vkRoot), [DIGEST_INPUT]);
}

/** Ячейка ключа программы выхода: части ключа батчей и свой IC0 (как exitVkData в контракте). */
export function exitKeyCell(batchKeyCell, exitIc0) {
    const batch = batchKeyCell.beginParse();
    batch.skip(254 + 254);
    const cell = ton.beginCell().storeUint(exitIc0[0], 254).storeUint(exitIc0[1], 254);
    for (let i = 0; i < 4; i++) cell.storeRef(batch.loadRef());
    return cell.endCell();
}

const KEY_FILE = path.join(ROOT, 'fixtures', 'zkvm_batches', 'key.json');

/** Содержимое key.json для данного верификатора и ключей программ. */
function buildKeyFile(verifier, programs) {
    const batch = rollupKeyFor(verifier, programs.programVKey);
    const exit = rollupKeyFor(verifier, programs.exitProgramVKey);
    if (batch.upload.table1Parts.length !== 0) throw new Error('У ключа контракта не должно быть второй таблицы');
    const exitCell = exitKeyCell(batch.vkData, exit.upload.ic0);
    if (!exitCell.hash().equals(exit.vkData.hash())) {
        throw new Error('Ключ выхода, собранный из ключа батчей и своего IC0, не совпал с собранным напрямую');
    }
    const hex = (cell) => '0x' + cell.hash().toString('hex');
    const boc = (cell) => cell.toBoc().toString('base64');
    return {
        source: 'Сгенерировано zk/gen-rollup-key.mjs; не редактировать вручную',
        note: 'Ключ rollup-контракта, выведенный из закреплённого верификатора SP1 и ключей программ, без пруфа. После загрузки get-методы keyHash и exitKeyHash контракта обязаны вернуть эти хеши',
        circuitVersion: verifier.circuitVersion,
        verifierHash: verifier.verifierHash,
        vkRoot: verifier.vkRoot,
        verifierConstantsSha256: verifier.constantsSha256,
        sourcesSha256: programs.sourcesSha256,
        programVKey: programs.programVKey,
        exitProgramVKey: programs.exitProgramVKey,
        keyHash: hex(batch.vkData),
        exitKeyHash: hex(exitCell),
        exitIc0: exit.upload.ic0.map(String),
        keyUpload: {
            ic0: batch.upload.ic0.map(String),
            alphaBetaBoc: boc(batch.upload.alphaBeta),
            fixedLinesBoc: boc(batch.upload.fixedLines),
            table0PartsBoc: batch.upload.table0Parts.map(boc),
            table1PartsBoc: [],
        },
        verificationKey: verificationKeyJson(verifier.key),
    };
}

function generate() {
    const dir = process.argv[2] ?? sp1CircuitDir(CIRCUIT_VERSION);
    const verifier = loadSp1Verifier(path.join(dir, 'Groth16Verifier.sol'), path.join(dir, 'SP1VerifierGroth16.sol'));
    if (verifier.circuitVersion !== CIRCUIT_VERSION) {
        throw new Error(`Ожидался верификатор ${CIRCUIT_VERSION}, в каталоге ${verifier.circuitVersion}`);
    }
    const out = buildKeyFile(verifier, loadProgramKeys());
    mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, JSON.stringify(out) + '\n');
    console.log(`Записано: fixtures/zkvm_batches/key.json`);
    console.log(`  keyHash:     ${out.keyHash}`);
    console.log(`  exitKeyHash: ${out.exitKeyHash}`);
    console.log(`  частей таблицы: ${out.keyUpload.table0PartsBoc.length}`);
}

/**
 * Сверка key.json: ключ схемы в нём — закреплённый, а всё остальное пересчитывается из него
 * и program.json и обязано совпасть. Возвращает список расхождений.
 */
export function checkKeyFile() {
    const stored = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
    const pin = pinnedVersion(stored.circuitVersion);
    if (!pin) return [`версия схемы ${stored.circuitVersion} не закреплена в zk/sp1-pins.json`];
    if (verificationKeyFingerprint(stored.verificationKey) !== pin.verificationKeySha256) {
        return ['ключ схемы в key.json не тот, что закреплён в zk/sp1-pins.json'];
    }
    const verifier = {
        key: parseVerificationKey(stored.verificationKey),
        circuitVersion: stored.circuitVersion,
        verifierHash: pin.verifierHash,
        vkRoot: pin.vkRoot,
        constantsSha256: pin.constantsSha256,
    };
    const expected = buildKeyFile(verifier, loadProgramKeys());
    return Object.keys({ ...expected, ...stored })
        .filter((field) => JSON.stringify(expected[field]) !== JSON.stringify(stored[field]))
        .map((field) => `поле ${field} не совпало с пересчитанным`);
}

function main() {
    if (process.argv[2] !== '--check') return generate();
    const problems = checkKeyFile();
    if (problems.length > 0) {
        console.error(`key.json не сходится:\n  - ${problems.join('\n  - ')}`);
        process.exit(1);
    }
    console.log('key.json сходится: ключ схемы закреплён, части ключа и хеши пересчитаны из него и program.json.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    main();
}
