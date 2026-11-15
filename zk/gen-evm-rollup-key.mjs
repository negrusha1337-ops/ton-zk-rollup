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
// Протокол версии 2 (PROTOCOL-V2.md): ключ у контракта ОДИН — программы батча. Ключа программы
// аварийного выхода нет: контракт v2 его не хранит и не требует при фиксации (шага SetExitKey
// нет), баланс счёта после заморозки выходит без пруфа (ForceExitEvm). Прежняя заглушка — ключ
// программы выхода игрушечного реестра — убрана вместе с зависимостью от fixtures/zkvm_batches;
// полей exitKeyHash и exitIc0 в key.json нет.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseVerificationKey } from './bn254-onchain.mjs';
import { EVM_FIXTURES, loadEvmProgramKeys } from './evm-binding.mjs';
import { rollupKeyFor } from './gen-rollup-key.mjs';
import {
    loadSp1Verifier,
    pinnedVersion,
    sp1CircuitDir,
    verificationKeyFingerprint,
    verificationKeyJson,
} from './sp1-verifier.mjs';

const CIRCUIT_VERSION = 'v6.1.0';
const KEY_FILE = path.join(EVM_FIXTURES, 'key.json');

function buildKeyFile(verifier, program) {
    const batch = rollupKeyFor(verifier, program.programVKey);
    if (batch.upload.table1Parts.length !== 0) throw new Error('У ключа контракта не должно быть второй таблицы');
    const hex = (cell) => '0x' + cell.hash().toString('hex');
    const boc = (cell) => cell.toBoc().toString('base64');
    return {
        source: 'Сгенерировано zk/gen-evm-rollup-key.mjs; не редактировать вручную',
        note: 'Ключ rollup-контракта (протокол версии 2) для программы батча EVM, выведенный из закреплённого верификатора SP1 и ключа программы, без пруфа. Ключа программы выхода в протоколе нет.',
        protocolVersion: 2,
        circuitVersion: verifier.circuitVersion,
        verifierHash: verifier.verifierHash,
        vkRoot: verifier.vkRoot,
        verifierConstantsSha256: verifier.constantsSha256,
        sourcesSha256: program.sourcesSha256,
        programVKey: program.programVKey,
        programElfSha256: program.programElfSha256,
        keyHash: hex(batch.vkData),
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
    const out = buildKeyFile(verifier, loadEvmProgramKeys());
    mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    writeFileSync(KEY_FILE, JSON.stringify(out) + '\n');
    console.log('Записано: fixtures/evm_batches/key.json');
    console.log(`  keyHash:     ${out.keyHash}`);
    console.log(`  частей таблицы: ${out.keyUpload.table0PartsBoc.length}`);
}

/**
 * Сверка key.json: ключ схемы в нём — закреплённый, а всё остальное пересчитывается из него,
 * program.json программы EVM и обязано совпасть. Возвращает список расхождений.
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
    const expected = buildKeyFile(verifier, loadEvmProgramKeys());
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
