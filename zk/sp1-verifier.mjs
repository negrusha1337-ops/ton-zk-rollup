// Ключ Groth16-верификатора SP1 из его Solidity-контрактов и сверка с закреплёнными значениями.
//
// Ключ схемы SP1 — корень доверия всей проверки: с подменённым ключом контракт на TON
// принимал бы «пруфы» чего угодно. Берётся он из файлов, которые SP1 SDK скачивает вместе
// с артефактами схемы (~/.sp1/circuits/groth16/<версия>/), поэтому их содержимое
// закреплено в zk/sp1-pins.json и сверено с репозиторием succinctlabs/sp1-contracts
// (как именно — поле `checked` в файле закреплений и PROVING.md).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bn254 } from '@noble/curves/bn254.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PINS = JSON.parse(readFileSync(path.join(HERE, 'sp1-pins.json'), 'utf8'));
const G1 = bn254.G1.Point;
const G2 = bn254.G2.Point;

/**
 * Точка G2 из двух пар чисел. Порядок частей (вещественная/мнимая) в разных местах
 * шаблона gnark разный, поэтому не гадаем: берём тот, при котором точка лежит на
 * кривой и в подгруппе. Если подходят оба или ни один — это ошибка импорта.
 */
export function g2FromParts(xParts, yParts, label) {
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

/** Все числовые константы Solidity-верификатора: имя → значение. */
function verifierConstants(solidity) {
    const constants = new Map();
    for (const [, name, value] of solidity.matchAll(/uint256 constant ([A-Z0-9_]+) = (\d+);/g)) {
        if (constants.has(name)) throw new Error(`Константа ${name} объявлена дважды`);
        constants.set(name, BigInt(value));
    }
    return constants;
}

/**
 * Отпечаток ключа: sha256 от строк «ИМЯ=значение», отсортированных по имени. От
 * оформления файла (версия pragma, пробелы) не зависит — только от чисел ключа.
 */
export function constantsFingerprint(constants) {
    const lines = [...constants.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => `${name}=${value}\n`);
    return createHash('sha256').update(lines.join('')).digest('hex');
}

/**
 * Читает ключ схемы и константы обёртки SP1. С `requirePin` (по умолчанию) отказывает,
 * если версия не закреплена или любое из значений разошлось с закреплённым.
 */
export function loadSp1Verifier(verifierPath, wrapperPath, { requirePin = true } = {}) {
    const constants = verifierConstants(readFileSync(verifierPath, 'utf8'));
    const constant = (name) => {
        if (!constants.has(name)) throw new Error(`В ${path.basename(verifierPath)} нет константы ${name}`);
        return constants.get(name);
    };
    const g1 = (x, y) => G1.fromAffine({ x, y });
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
    for (let i = 0; constants.has(`PUB_${i}_X`); i++) ic.push(g1(constant(`PUB_${i}_X`), constant(`PUB_${i}_Y`)));
    for (const point of [alpha, ...ic]) point.assertValidity();

    const wrapper = readFileSync(wrapperPath, 'utf8');
    const wrapperConstant = (name) => {
        const match = new RegExp(`function ${name}\\(\\)[^{]*\\{\\s*return (0x[0-9a-fA-F]+);`).exec(wrapper);
        if (!match) throw new Error(`В ${path.basename(wrapperPath)} нет ${name}()`);
        return match[1].toLowerCase();
    };
    const versionMatch = /function VERSION\(\)[^{]*\{\s*return "([^"]+)";/.exec(wrapper);
    if (!versionMatch) throw new Error(`В ${path.basename(wrapperPath)} нет VERSION()`);
    const key = { alpha, beta, gamma, delta, ic };
    const verifier = {
        key,
        circuitVersion: versionMatch[1],
        verifierHash: wrapperConstant('VERIFIER_HASH'),
        vkRoot: wrapperConstant('VK_ROOT'),
        constantsSha256: constantsFingerprint(constants),
        verificationKeySha256: verificationKeyFingerprint(verificationKeyJson(key)),
        pinned: false,
    };

    const pin = pinnedVersion(verifier.circuitVersion);
    if (pin) {
        for (const field of ['verifierHash', 'vkRoot', 'constantsSha256', 'verificationKeySha256']) {
            if (pin[field] !== verifier[field]) {
                throw new Error(
                    `Верификатор SP1 ${verifier.circuitVersion}: ${field} не совпал с закреплённым в zk/sp1-pins.json ` +
                        `(в файле ${verifier[field]}, закреплено ${pin[field]}). Ключ схемы подменён или обновлён.`,
                );
            }
        }
        verifier.pinned = true;
    } else if (requirePin) {
        throw new Error(`Верификатор SP1 ${verifier.circuitVersion} не закреплён в zk/sp1-pins.json`);
    }
    return verifier;
}

/** Закреплённые значения версии схемы; undefined, если версия не закреплена. */
export const pinnedVersion = (version) =>
    Object.prototype.hasOwnProperty.call(PINS.versions, version) ? PINS.versions[version] : undefined;

/**
 * Отпечаток ключа схемы в раскладке snarkjs: sha256 от его JSON. Закреплён рядом с
 * отпечатком констант Solidity; по нему ключ, сохранённый в fixtures/zkvm_batches/key.json,
 * сверяется с закреплённым без файлов из ~/.sp1.
 */
export const verificationKeyFingerprint = (verificationKey) =>
    createHash('sha256').update(JSON.stringify(verificationKey)).digest('hex');

/** Ключ схемы в раскладке snarkjs (так его читают остальные скрипты). */
export function verificationKeyJson(key) {
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
    return {
        protocol: 'groth16',
        curve: 'bn128',
        nPublic: key.ic.length - 1,
        vk_alpha_1: g1Json(key.alpha),
        vk_beta_2: g2Json(key.beta),
        vk_gamma_2: g2Json(key.gamma),
        vk_delta_2: g2Json(key.delta),
        IC: key.ic.map(g1Json),
    };
}

/** Каталог с артефактами схемы, которые скачал SP1 SDK. */
export const sp1CircuitDir = (version) =>
    path.join(process.env.SP1_CIRCUITS_DIR ?? path.join(process.env.HOME ?? '', '.sp1', 'circuits'), 'groth16', version);
