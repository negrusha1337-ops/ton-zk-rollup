// Общее для импорта пруфов zkVM (SP1, RISC Zero) в раскладку snarkjs.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bn254 } from '@noble/curves/bn254.js';

const G1 = bn254.G1.Point;
const G2 = bn254.G2.Point;
const { Fp12 } = bn254.fields;

/** Константа `uint256 constant NAME = 123;` из исходника Solidity. */
export function solidityConstant(source, name, fileLabel) {
    const match = new RegExp(`uint256\\s+constant\\s+${name}\\s*=\\s*(\\d+)\\s*;`).exec(source);
    if (!match) throw new Error(`В ${fileLabel} нет константы ${name}`);
    return BigInt(match[1]);
}

export function g1Point(x, y) {
    const point = G1.fromAffine({ x, y });
    point.assertValidity();
    return point;
}

/**
 * Точка G2 из двух пар чисел. Порядок частей (вещественная/мнимая) в шаблонах
 * верификаторов разный, поэтому не гадаем: берём тот, при котором точка лежит на
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

/** 32-байтовые слова из шестнадцатеричной строки (без префикса 0x). */
export function words32(hex) {
    if (hex.length % 64 !== 0) throw new Error(`Длина данных не кратна 32 байтам: ${hex.length / 2} байт`);
    return hex.match(/.{64}/g).map((word) => BigInt('0x' + word));
}

/** Проверка эталонной библиотекой: e(A, B) = e(α, β) · e(vk_x, γ) · e(C, δ). */
export function assertGroth16(key, proof, inputs, label) {
    if (inputs.length + 1 !== key.ic.length)
        throw new Error(`${label}: число публичных входов не совпало с числом IC-точек`);
    const vkX = inputs.reduce(
        (acc, value, i) => (value === 0n ? acc : acc.add(key.ic[i + 1].multiply(value))),
        key.ic[0],
    );
    const check = bn254.pairingBatch([
        { g1: proof.A.negate(), g2: proof.B },
        { g1: key.alpha, g2: key.beta },
        { g1: vkX, g2: key.gamma },
        { g1: proof.C, g2: key.delta },
    ]);
    if (!Fp12.eql(check, Fp12.ONE)) {
        throw new Error(`${label}: пруф не прошёл проверку эталонной библиотекой — импорт неверен`);
    }
}

/** Записывает ключ, пруф, публичные входы и сведения о происхождении в раскладке snarkjs. */
export function writeFixture(directory, key, proof, inputs, source) {
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
    mkdirSync(directory, { recursive: true });
    const write = (file, data) => writeFileSync(path.join(directory, file), JSON.stringify(data, null, 1) + '\n');
    write('verification_key.json', {
        protocol: 'groth16',
        curve: 'bn128',
        nPublic: inputs.length,
        vk_alpha_1: g1Json(key.alpha),
        vk_beta_2: g2Json(key.beta),
        vk_gamma_2: g2Json(key.gamma),
        vk_delta_2: g2Json(key.delta),
        IC: key.ic.map(g1Json),
    });
    write('proof.json', {
        pi_a: g1Json(proof.A),
        pi_b: g2Json(proof.B),
        pi_c: g1Json(proof.C),
        protocol: 'groth16',
        curve: 'bn128',
    });
    write('public.json', inputs.map(s));
    write('source.json', source);
}
