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
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bn254 } from '@noble/curves/bn254.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_FIXTURE = 'sp1_v6_fibonacci';
const [verifierPath, wrapperPath, fixturePath, fixtureName = TEMPLATE_FIXTURE] = process.argv.slice(2);
if (!verifierPath || !wrapperPath || !fixturePath) {
    console.error('Нужны три пути: Groth16Verifier.sol, SP1VerifierGroth16.sol, groth16-fixture.json [имя фикстуры]');
    process.exit(1);
}
if (!/^[a-z0-9_]+$/.test(fixtureName)) {
    console.error(`Недопустимое имя фикстуры: ${fixtureName} (строчные латинские буквы, цифры, подчёркивание)`);
    process.exit(1);
}
const OUT = path.join(ROOT, 'fixtures', fixtureName);

const { Fp, Fp2 } = bn254.fields;
const p = Fp.ORDER;
const G1 = bn254.G1.Point;
const G2 = bn254.G2.Point;

// --- ключ: константы Solidity-верификатора (шаблон gnark) ---
const solidity = readFileSync(verifierPath, 'utf8');
const constant = (name) => {
    const match = new RegExp(`uint256 constant ${name} = (\\d+);`).exec(solidity);
    if (!match) throw new Error(`В ${path.basename(verifierPath)} нет константы ${name}`);
    return BigInt(match[1]);
};
const g1 = (x, y) => G1.fromAffine({ x, y });
/**
 * Точка G2 из двух пар чисел. Порядок частей (вещественная/мнимая) в разных местах
 * шаблона gnark разный, поэтому не гадаем: берём тот, при котором точка лежит на
 * кривой и в подгруппе. Если подходят оба или ни один — это ошибка импорта.
 */
function g2FromParts(xParts, yParts, label) {
    const candidates = [
        { x: { c0: xParts[0], c1: xParts[1] }, y: { c0: yParts[0], c1: yParts[1] } },
        { x: { c0: xParts[1], c1: xParts[0] }, y: { c0: yParts[1], c1: yParts[0] } },
    ].flatMap((coordinates) => {
        try {
            const point = G2.fromAffine(coordinates);
            point.assertValidity();
            return [point];
        } catch {
            return [];
        }
    });
    if (candidates.length !== 1) {
        throw new Error(
            `${label}: порядок координат G2 не определился однозначно (подошло вариантов: ${candidates.length})`,
        );
    }
    return candidates[0];
}
const g2 = (prefix) =>
    g2FromParts(
        [constant(`${prefix}_X_0`), constant(`${prefix}_X_1`)],
        [constant(`${prefix}_Y_0`), constant(`${prefix}_Y_1`)],
        prefix,
    );

const alpha = g1(constant('ALPHA_X'), constant('ALPHA_Y'));
// В контракте лежат отрицания β, γ, δ — возвращаем исходные точки.
const beta = g2('BETA_NEG').negate();
const gamma = g2('GAMMA_NEG').negate();
const delta = g2('DELTA_NEG').negate();
const ic = [g1(constant('CONSTANT_X'), constant('CONSTANT_Y'))];
for (let i = 0; ; i++) {
    if (!solidity.includes(`uint256 constant PUB_${i}_X`)) break;
    ic.push(g1(constant(`PUB_${i}_X`), constant(`PUB_${i}_Y`)));
}
for (const point of [alpha, ...ic]) point.assertValidity();

// --- пруф: selector ‖ abi(exitCode, vkRoot, nonce, uint256[8]) ---
const wrapper = readFileSync(wrapperPath, 'utf8');
const wrapperConstant = (name) => {
    const match = new RegExp(`function ${name}\\(\\)[^{]*\\{\\s*return (0x[0-9a-fA-F]+);`).exec(wrapper);
    if (!match) throw new Error(`В ${path.basename(wrapperPath)} нет ${name}()`);
    return match[1].toLowerCase();
};
const verifierHash = wrapperConstant('VERIFIER_HASH');
const versionMatch = /function VERSION\(\)[^{]*\{\s*return "([^"]+)";/.exec(wrapper);
if (!versionMatch) throw new Error(`В ${path.basename(wrapperPath)} нет VERSION()`);
const circuitVersion = versionMatch[1];
const contractsUrl = `https://github.com/succinctlabs/sp1-contracts/blob/main/contracts/src/${circuitVersion}`;
const expectedVkRoot = BigInt(wrapperConstant('VK_ROOT'));

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const proofBytes = Buffer.from(fixture.proof.slice(2), 'hex');
const selector = '0x' + proofBytes.subarray(0, 4).toString('hex');
if (selector !== verifierHash.slice(0, 10)) {
    throw new Error(`Пруф для другой версии верификатора: selector ${selector}, ожидался ${verifierHash.slice(0, 10)}`);
}
const words = [];
for (let offset = 4; offset < proofBytes.length; offset += 32) {
    words.push(BigInt('0x' + proofBytes.subarray(offset, offset + 32).toString('hex')));
}
if (words.length !== 11) throw new Error(`Ожидалось 11 слов в пруфе, получено ${words.length}`);
const [exitCode, vkRoot, nonce, ax, ay, bx1, bx0, by1, by0, cx, cy] = words;
if (exitCode !== 0n) throw new Error('exitCode пруфа не равен 0');
if (vkRoot !== expectedVkRoot) throw new Error('vkRoot пруфа не совпал с VK_ROOT верификатора');

const A = g1(ax, ay);
const B = g2FromParts([bx1, bx0], [by1, by0], 'B');
const C = g1(cx, cy);
A.assertValidity();
C.assertValidity();

// --- публичные входы: как в SP1VerifierGroth16.verifyProof ---
const digest =
    BigInt(
        '0x' +
            createHash('sha256')
                .update(Buffer.from(fixture.publicValues.slice(2), 'hex'))
                .digest('hex'),
    ) &
    ((1n << 253n) - 1n);
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
write('verification_key.json', {
    protocol: 'groth16',
    curve: 'bn128',
    nPublic: inputs.length,
    vk_alpha_1: g1Json(alpha),
    vk_beta_2: g2Json(beta),
    vk_gamma_2: g2Json(gamma),
    vk_delta_2: g2Json(delta),
    IC: ic.map(g1Json),
});
write('proof.json', { pi_a: g1Json(A), pi_b: g2Json(B), pi_c: g1Json(C), protocol: 'groth16', curve: 'bn128' });
write('public.json', inputs.map(s));
write('source.json', {
    description:
        fixtureName === TEMPLATE_FIXTURE
            ? 'Настоящий пруф SP1 (программа Фибоначчи, n = 20) и ключ его Groth16-верификатора'
            : `Настоящий пруф SP1 нашей программы перехода состояния и ключ Groth16-верификатора ${circuitVersion}`,
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
    inputNames: ['programVKey', 'publicValuesDigest', 'exitCode', 'vkRoot', 'nonce'],
    variableInputs: [1, 4],
});
console.log(
    `Пруф SP1 (${circuitVersion}) проверен эталонной библиотекой и записан в fixtures/${fixtureName} (входов: ${inputs.length}).`,
);
console.log('Публичные входы:', inputs.map((v) => '0x' + v.toString(16)).join(', '));
