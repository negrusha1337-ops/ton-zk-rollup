// Ключ верификации rollup-контракта для программы батча EVM — из исходников, БЕЗ пруфа.
//
//   node zk/gen-evm-rollup-key.mjs [каталог с Groth16Verifier.sol и SP1VerifierGroth16.sol]
//   node zk/gen-evm-rollup-key.mjs --check     # пересчитать key.json и сравнить, ничего не записывая
//
// То же, что zk/gen-rollup-key.mjs для программ zkvm/: ключ контракта — функция закреплённого
// верификатора SP1 (zk/sp1-pins.json), ключа программы (fixtures/evm_batches/program.json,
// привязан к хешу исходников — zk/evm-binding.mjs) и постоянных входов exitCode = 0, vkRoot,
// nonce = 0. Результат: fixtures/evm_batches/key.json.
//
// КЛЮЧ ВЫХОДА — ЗАГЛУШКА. Контракт не фиксирует ключи без ключа программы аварийного выхода, а
// такой программы для состояния EVM нет (находка 6-Б в REVIEW.md). Сюда подставлен ключ
// программы выхода игрушечного реестра (fixtures/zkvm_batches/program.json): пруф выхода под
// него для состояния EVM построить нельзя — слово состояния здесь хеш заголовка блока, а не
// корень реестра. То есть у контракта с этим ключом аварийный выход НЕ РАБОТАЕТ; ключ годится
// только для демонстрации приёма батча в Sandbox и testnet.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseVerificationKey } from './bn254-onchain.mjs';
import { EVM_FIXTURES, loadEvmProgramKeys } from './evm-binding.mjs';
import { exitKeyCell, rollupKeyFor } from './gen-rollup-key.mjs';
import { loadProgramKeys } from './program-binding.mjs';
import {
    loadSp1Verifier,
    pinnedVersion,
    sp1CircuitDir,
    verificationKeyFingerprint,
    verificationKeyJson,
} from './sp1-verifier.mjs';

const CIRCUIT_VERSION = 'v6.1.0';
const KEY_FILE = path.join(EVM_FIXTURES, 'key.json');

/** Ключ программы выхода игрушечного реестра — заглушка на месте ключа выхода EVM. */
const placeholderExitVKey = () => loadProgramKeys({ requireFresh: false }).exitProgramVKey;

function buildKeyFile(verifier, program, exitProgramVKey) {
    const batch = rollupKeyFor(verifier, program.programVKey);
    const exit = rollupKeyFor(verifier, exitProgramVKey);
    if (batch.upload.table1Parts.length !== 0) throw new Error('У ключа контракта не должно быть второй таблицы');
    const exitCell = exitKeyCell(batch.vkData, exit.upload.ic0);
    if (!exitCell.hash().equals(exit.vkData.hash())) {
        throw new Error('Ключ выхода, собранный из ключа батчей и своего IC0, не совпал с собранным напрямую');
    }
    const hex = (cell) => '0x' + cell.hash().toString('hex');
    const boc = (cell) => cell.toBoc().toString('base64');
    return {
        source: 'Сгенерировано zk/gen-evm-rollup-key.mjs; не редактировать вручную',
        note: 'Ключ rollup-контракта для программы батча EVM, выведенный из закреплённого верификатора SP1 и ключа программы, без пруфа. Ключ выхода — ЗАГЛУШКА (ключ программы выхода игрушечного реестра): аварийного выхода для состояния EVM нет.',
        circuitVersion: verifier.circuitVersion,
        verifierHash: verifier.verifierHash,
        vkRoot: verifier.vkRoot,
        verifierConstantsSha256: verifier.constantsSha256,
        sourcesSha256: program.sourcesSha256,
        programVKey: program.programVKey,
        exitProgramVKey,
        exitKeyIsPlaceholder: true,
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
    const out = buildKeyFile(verifier, loadEvmProgramKeys(), placeholderExitVKey());
    mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, JSON.stringify(out) + '\n');
    console.log('Записано: fixtures/evm_batches/key.json');
    console.log(`  keyHash:     ${out.keyHash}`);
    console.log(`  exitKeyHash: ${out.exitKeyHash} (заглушка)`);
    console.log(`  частей таблицы: ${out.keyUpload.table0PartsBoc.length}`);
}

/**
 * Сверка key.json: ключ схемы в нём — закреплённый, а всё остальное пересчитывается из него,
 * program.json программы EVM и ключа-заглушки и обязано совпасть. Возвращает список расхождений.
 */
export function checkEvmKeyFile() {
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
    const expected = buildKeyFile(verifier, loadEvmProgramKeys(), placeholderExitVKey());
    return Object.keys({ ...expected, ...stored })
        .filter((field) => JSON.stringify(expected[field]) !== JSON.stringify(stored[field]))
        .map((field) => `поле ${field} не совпало с пересчитанным`);
}

function main() {
    if (process.argv[2] !== '--check') return generate();
    const problems = checkEvmKeyFile();
    if (problems.length > 0) {
        console.error(`fixtures/evm_batches/key.json не сходится:\n  - ${problems.join('\n  - ')}`);
        process.exit(1);
    }
    console.log('fixtures/evm_batches/key.json сходится: ключ схемы закреплён, части ключа и хеши пересчитаны.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
    main();
}
