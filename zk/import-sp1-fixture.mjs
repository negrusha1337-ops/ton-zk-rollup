// Импорт настоящего пруфа SP1 в формат, с которым работают остальные скрипты.
//
// Вход (скачивается вручную, см. fixtures/sp1_v6_fibonacci/source.json):
//   • Groth16Verifier.sol из succinctlabs/sp1-contracts — оттуда берётся ключ верификации;
//   • groth16-fixture.json из succinctlabs/sp1-project-template — пруф программы Фибоначчи.
// Выход: fixtures/<имя>/{verification_key,proof,public}.json в раскладке snarkjs.
//
// Запуск: node zk/import-sp1-fixture.mjs <Groth16Verifier.sol> <SP1VerifierGroth16.sol> <groth16-fixture.json> [имя]
//
// Без имени пишет fixtures/sp1_v6_fibonacci (пруф шаблона Succinct). С именем — пруф нашей
// собственной программы из zkvm/script (fixtures/zkvm_batches/proof-batch<N>.json): версия
// верификатора должна совпадать с версией схемы SDK, иначе не сойдётся selector пруфа.
// У пруфов программы EVM после номера блока допустима метка: sp1_evm_reth3_gpu — пруф блока 3,
// построенный на арендованном сервере (zkvm-evm/host/remote/), рядом с fixtures/sp1_evm_reth3.
//
// Пруф батча сервиса-секвенсора (sequencer/prover.ts) — имя sp1_evm_sequencer и два флага:
//   node zk/import-sp1-fixture.mjs <…sol> <…sol> <пруф> sp1_evm_sequencer --out-dir <каталог> --report <отчёт блока>
// Публичные значения сверяются с отчётом хоста о блоке сервиса (его report.json), фикстура пишется
// в каталог вне fixtures/ (очередь пруфов сервиса в .tools/), основные фикстуры не трогаются.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bn254 } from '@noble/curves/bn254.js';
import { loadEvmProgramKeys } from './evm-binding.mjs';
import { isInside } from './path-guard.mjs';
import { loadProgramKeys } from './program-binding.mjs';
import { g2FromParts, loadSp1Verifier, verificationKeyJson } from './sp1-verifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_FIXTURE = 'sp1_v6_fibonacci';
const SEQUENCER_FIXTURE = 'sp1_evm_sequencer';
// Флаги --out-dir и --report — только для пруфа батча сервиса (SEQUENCER_FIXTURE).
const rawArgs = process.argv.slice(2);
const flags = {};
const positional = [];
for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === '--out-dir' || arg === '--report') {
        if (!rawArgs[index + 1]) {
            console.error(`После ${arg} нужен путь`);
            process.exit(1);
        }
        flags[arg.slice(2)] = path.resolve(rawArgs[++index]);
    } else positional.push(arg);
}
const [verifierPath, wrapperPath, fixturePath, fixtureName = TEMPLATE_FIXTURE] = positional;
if (!verifierPath || !wrapperPath || !fixturePath) {
    console.error('Нужны три пути: Groth16Verifier.sol, SP1VerifierGroth16.sol, groth16-fixture.json [имя фикстуры]');
    process.exit(1);
}
if (!/^[a-z0-9_]+$/.test(fixtureName)) {
    console.error(`Недопустимое имя фикстуры: ${fixtureName} (строчные латинские буквы, цифры, подчёркивание)`);
    process.exit(1);
}
const forSequencer = fixtureName === SEQUENCER_FIXTURE;
if (forSequencer !== Boolean(flags['out-dir']) || forSequencer !== Boolean(flags.report)) {
    console.error(`Флаги --out-dir и --report нужны ровно для ${SEQUENCER_FIXTURE} (пруф батча сервиса) и только для него`);
    process.exit(1);
}
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
// По настоящим путям: симлинк и регистр (APFS) не обходят сверку (круг 21, 5г).
if (forSequencer && isInside(flags['out-dir'], FIXTURES_DIR)) {
    console.error(`Пруф батча сервиса пишется вне fixtures/: ${flags['out-dir']}`);
    process.exit(1);
}
const OUT = forSequencer ? flags['out-dir'] : path.join(ROOT, 'fixtures', fixtureName);
const SHOWN_OUT = forSequencer ? OUT : `fixtures/${fixtureName}`;

// Чей это пруф. Пруфы наших программ привязаны к fixtures/zkvm_batches/program.json:
// ключ программы обязан совпасть с записанным там, а тот — соответствовать нынешним
// исходникам. Пруф от прежней версии программы импортировать нельзя.
const KINDS = [
    {
        prefix: 'sp1_rollup_batch',
        kind: 'batch',
        vkeyField: 'programVKey',
        elfField: 'programElfSha256',
        publicValuesBytes: 256,
    },
    {
        prefix: 'sp1_rollup_exit_',
        kind: 'exit',
        vkeyField: 'exitProgramVKey',
        elfField: 'exitProgramElfSha256',
        publicValuesBytes: 160,
    },
    // Программа батча EVM (zkvm-evm/): свой program.json (fixtures/evm_batches/); публичные
    // значения — одиннадцать слов протокола версии 2 (352 байта). Имя — sp1_evm_batch<номер
    // блока>; пруф строит zkvm-evm/host --prove.
    {
        prefix: 'sp1_evm_batch',
        kind: 'batch',
        evm: true,
        reportDirectory: 'contract',
        vkeyField: 'programVKey',
        elfField: 'programElfSha256',
        publicValuesBytes: 352,
    },
    // Та же программа на блоках узла Reth (zkvm-evm/scenario/reth-scenario.mjs): имя —
    // sp1_evm_reth<номер блока>, батч — fixtures/evm_batches/reth/block-<N>.json.
    {
        prefix: 'sp1_evm_reth',
        kind: 'batch',
        evm: true,
        reportDirectory: 'reth',
        vkeyField: 'programVKey',
        elfField: 'programElfSha256',
        publicValuesBytes: 352,
    },
    // Блок сервиса-секвенсора (sequencer/): публичные значения — из отчёта хоста о блоке (--report).
    {
        prefix: SEQUENCER_FIXTURE,
        kind: 'batch',
        evm: true,
        reportFile: true,
        vkeyField: 'programVKey',
        elfField: 'programElfSha256',
        publicValuesBytes: 352,
    },
];
/**
 * Публичные значения, которые сценарий (zkvm/native) выдаёт для этой фикстуры: пруф батча 1,
 * импортированный под именем батча 2, или пруф прежнего сценария иначе всплыли бы только в
 * сквозном тесте.
 */
function scenarioPublicValues(kind, name, evm = false, prefix = '', reportDirectory = '', reportFile = false) {
    const read = (...parts) => JSON.parse(readFileSync(path.join(ROOT, 'fixtures', ...parts), 'utf8'));
    if (reportFile) return JSON.parse(readFileSync(flags.report, 'utf8')).publicValuesBytes.replace(/^0x/, '').toLowerCase();
    if (evm) {
        // Батч для контракта: fixtures/evm_batches/<каталог>/block-<N>.json пишет хост после
        // сверки публичных значений zkVM с нативным расчётом (сценарии в zkvm-evm/scenario/).
        // После номера блока допустима метка через подчёркивание (sp1_evm_reth3_gpu): тот же
        // блок, пруф построен в другом месте и импортируется рядом, не затирая основной.
        const match = /^([0-9]+)(?:_[a-z0-9]+)?$/.exec(name.slice(prefix.length));
        if (!match) throw new Error(`В имени ${name} нет номера блока`);
        const block = match[1];
        return read('evm_batches', reportDirectory, `block-${block}.json`).publicValuesBytes.slice(2);
    }
    if (kind === 'batch') {
        const index = Number(name.slice('sp1_rollup_batch'.length));
        const batch = read('zkvm_batches', 'batches.json').batches[index - 1];
        if (!batch) throw new Error(`В сценарии нет батча «${name.slice('sp1_rollup_batch'.length)}»`);
        return batch.publicValuesHex;
    }
    const who = name.slice('sp1_rollup_exit_'.length);
    const claim = read('zkvm_exit', 'claims.json').claims.find((candidate) => candidate.name === who);
    if (!claim) throw new Error(`В сценарии нет заявки на выход «${who}»`);
    return claim.publicValuesHex;
}
const program = KINDS.find(({ prefix }) => fixtureName.startsWith(prefix));
if (!program && fixtureName !== TEMPLATE_FIXTURE) {
    console.error(
        `Имя фикстуры ${fixtureName} не говорит, чей это пруф: допустимы ${TEMPLATE_FIXTURE}, ` +
            KINDS.map(({ prefix }) => `${prefix}*`).join(', '),
    );
    process.exit(1);
}

const G1 = bn254.G1.Point;
const g1 = (x, y) => G1.fromAffine({ x, y });

// --- ключ схемы: константы Solidity-верификатора, сверенные с zk/sp1-pins.json ---
// Для пруфов наших программ закрепление обязательно; для пруфа шаблона Succinct (другая
// версия схемы) — нет: он нужен только тестам самого верификатора.
const verifier = loadSp1Verifier(verifierPath, wrapperPath, { requirePin: Boolean(program) });
const { alpha, beta, gamma, delta, ic } = verifier.key;
const { verifierHash, circuitVersion } = verifier;
const contractsUrl = `https://github.com/succinctlabs/sp1-contracts/blob/main/contracts/src/${circuitVersion}`;
const expectedVkRoot = BigInt(verifier.vkRoot);

// --- пруф: selector ‖ abi(exitCode, vkRoot, nonce, uint256[8]) ---
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
for (const field of ['vkey', 'publicValues', 'proof']) {
    if (typeof fixture[field] !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(fixture[field])) {
        throw new Error(`Поле ${field} файла пруфа — не шестнадцатеричная строка`);
    }
}
const proofBytes = Buffer.from(fixture.proof.slice(2), 'hex');
if (proofBytes.length !== 4 + 11 * 32) {
    throw new Error(`Длина пруфа ${proofBytes.length} байт, ожидалось ${4 + 11 * 32}`);
}
const publicValuesBytes = Buffer.from(fixture.publicValues.slice(2), 'hex');
if (program) {
    const programs = program.evm ? loadEvmProgramKeys() : loadProgramKeys();
    if (BigInt(fixture.vkey) !== BigInt(programs[program.vkeyField])) {
        throw new Error(
            `Пруф построен для другой программы: его ключ ${fixture.vkey}, а в program.json ` +
                `${program.vkeyField} = ${programs[program.vkeyField]}. Это пруф прежней версии программы.`,
        );
    }
    // Привязка — по ключу программы (он проверяется спариванием ниже) и по хешу ELF. Хеш
    // исходников в файле пруфа — справочная запись: он меняется и от правки тестов, при
    // которой ELF и ключ остаются прежними, и пруф остаётся годным.
    if (typeof fixture.elfSha256 !== 'string' || fixture.elfSha256 !== programs[program.elfField]) {
        throw new Error(
            `Пруф построен для другого ELF (${fixture.elfSha256}), чем записан в program.json ` +
                `(${program.elfField} = ${programs[program.elfField]})`,
        );
    }
    if (publicValuesBytes.length !== program.publicValuesBytes) {
        throw new Error(
            `Публичные значения: ${publicValuesBytes.length} байт, у программы «${program.kind}» их ${program.publicValuesBytes}`,
        );
    }
    if (publicValuesBytes.toString('hex') !== scenarioPublicValues(program.kind, fixtureName, program.evm, program.prefix, program.reportDirectory, program.reportFile)) {
        throw new Error(
            `Публичные значения пруфа не те, что сценарий выдаёт для ${fixtureName}: пруф построен для другого ` +
                'батча, другой заявки или прежнего сценария',
        );
    }
}
const selector = '0x' + proofBytes.subarray(0, 4).toString('hex');
if (selector !== verifierHash.slice(0, 10)) {
    throw new Error(`Пруф для другой версии верификатора: selector ${selector}, ожидался ${verifierHash.slice(0, 10)}`);
}
const words = [];
for (let offset = 4; offset < proofBytes.length; offset += 32) {
    words.push(BigInt('0x' + proofBytes.subarray(offset, offset + 32).toString('hex')));
}
const [exitCode, vkRoot, nonce, ax, ay, bx1, bx0, by1, by0, cx, cy] = words;
if (exitCode !== 0n) throw new Error('exitCode пруфа не равен 0');
if (vkRoot !== expectedVkRoot) throw new Error('vkRoot пруфа не совпал с VK_ROOT верификатора');
// У rollup-контракта нонс свёрнут в ключ как ноль: пруф с другим нонсом он не примет.
if (program && nonce !== 0n) throw new Error(`Нонс пруфа ${nonce}, а rollup-контракт принимает только 0`);

const A = g1(ax, ay);
const B = g2FromParts([bx1, bx0], [by1, by0], 'B');
const C = g1(cx, cy);
A.assertValidity();
C.assertValidity();

// --- публичные входы: как в SP1VerifierGroth16.verifyProof ---
const digest = BigInt('0x' + createHash('sha256').update(publicValuesBytes).digest('hex')) & ((1n << 253n) - 1n);
const inputs = [BigInt(fixture.vkey), digest, exitCode, vkRoot, nonce];
if (inputs.length + 1 !== ic.length) throw new Error('Число публичных входов не совпало с числом IC-точек');

// --- проверка эталонной библиотекой: e(A, B) = e(α, β) · e(vk_x, γ) · e(C, δ) ---
const vkX = inputs.reduce((acc, value, i) => (value === 0n ? acc : acc.add(ic[i + 1].multiply(value))), ic[0]);
const check = bn254.pairingBatch([
    { g1: A.negate(), g2: B },
    { g1: alpha, g2: beta },
    { g1: vkX, g2: gamma },
    { g1: C, g2: delta },
]);
if (!bn254.fields.Fp12.eql(check, bn254.fields.Fp12.ONE)) {
    throw new Error('Пруф SP1 не прошёл проверку эталонной библиотекой — импорт неверен');
}

// --- запись в раскладке snarkjs ---
const s = (v) => v.toString();
const g1Json = (point) => [s(point.toAffine().x), s(point.toAffine().y), '1'];
const g2Json = (point) => {
    const { x, y } = point.toAffine();
    return [
        [s(x.c0), s(x.c1)],
        [s(y.c0), s(y.c1)],
        ['1', '0'],
    ];
};
mkdirSync(OUT, { recursive: true });
const write = (file, data) => writeFileSync(path.join(OUT, file), JSON.stringify(data, null, 1) + '\n');
write('verification_key.json', verificationKeyJson(verifier.key));
write('proof.json', { pi_a: g1Json(A), pi_b: g2Json(B), pi_c: g1Json(C), protocol: 'groth16', curve: 'bn128' });
write('public.json', inputs.map(s));
write('source.json', {
    description:
        fixtureName === TEMPLATE_FIXTURE
            ? 'Настоящий пруф SP1 (программа Фибоначчи, n = 20) и ключ его Groth16-верификатора'
            : `Настоящий пруф SP1 нашей программы (${program.kind === 'batch' ? 'перехода состояния' : 'аварийного выхода'}) и ключ Groth16-верификатора ${circuitVersion}`,
    verifier: `${contractsUrl}/Groth16Verifier.sol`,
    wrapper: `${contractsUrl}/SP1VerifierGroth16.sol`,
    proof:
        fixtureName === TEMPLATE_FIXTURE
            ? 'https://github.com/succinctlabs/sp1-project-template/blob/main/contracts/src/fixtures/groth16-fixture.json'
            : path.relative(ROOT, path.resolve(fixturePath)),
    verifierHash,
    programVKey: fixture.vkey,
    publicValues: fixture.publicValues,
    // Какие из пяти входов меняются от пруфа к пруфу; остальные — константы программы и версии.
    // У наших программ переменный вход один — дайджест: нонс всегда 0 и свёрнут в ключ
    // (так его ждёт rollup-контракт). У пруфа шаблона нонс оставлен переменным: на нём
    // проверяется вторая оконная таблица отдельного верификатора.
    inputNames: ['programVKey', 'publicValuesDigest', 'exitCode', 'vkRoot', 'nonce'],
    variableInputs: program ? [1] : [1, 4],
    ...(program
        ? {
              kind: program.kind,
              ...(program.evm ? { program: 'evm' } : {}),
              sourcesSha256: fixture.sourcesSha256,
              elfSha256: fixture.elfSha256,
              verifierConstantsSha256: verifier.constantsSha256,
          }
        : {}),
});
console.log(
    `Пруф SP1 (${circuitVersion}) проверен эталонной библиотекой и записан в ${SHOWN_OUT} (входов: ${inputs.length}).`,
);
console.log('Публичные входы:', inputs.map((v) => '0x' + v.toString(16)).join(', '));
