// Подготовка данных для контракта-верификатора BN254 из пруфа и ключа в раскладке
// snarkjs: ячейка констант ключа и ячейка подсказок к конкретному пруфу.
// Используется генератором фикстур и скриптом прогона на многих пруфах.
import ton from '@ton/core';
import { bn254 } from '@noble/curves/bn254.js';
import {
    affineLines,
    assembleTable,
    buildHints,
    fpChain,
    fpChainAligned,
    normalizedLineElements,
    publicInputSlopes,
    windowTable,
} from './bn254-hints.mjs';

const { Fp } = bn254.fields;

// snarkjs: точки G1 — [x, y, 1], элементы Fp2 — [c0, c1].
export const g1FromJson = ([x, y]) => bn254.G1.Point.fromAffine({ x: BigInt(x), y: BigInt(y) });
export const g2FromJson = ([x, y]) =>
    bn254.G2.Point.fromAffine({
        x: { c0: BigInt(x[0]), c1: BigInt(x[1]) },
        y: { c0: BigInt(y[0]), c1: BigInt(y[1]) },
    });

export const flat2 = (v) => [v.c0, v.c1];
export const flat6 = (v) => [v.c0, v.c1, v.c2].flatMap(flat2);
export const flat12 = (v) => [v.c0, v.c1].flatMap(flat6);
const affine = (point) => point.toAffine();

export function parseVerificationKey(vk) {
    return {
        alpha: g1FromJson(vk.vk_alpha_1),
        beta: g2FromJson(vk.vk_beta_2),
        gamma: g2FromJson(vk.vk_gamma_2),
        delta: g2FromJson(vk.vk_delta_2),
        ic: vk.IC.map(g1FromJson),
    };
}

export const parseProof = (proof) => ({
    A: g1FromJson(proof.pi_a),
    B: g2FromJson(proof.pi_b),
    C: g1FromJson(proof.pi_c),
});

/** vk_x = IC0 + Σ вход_i · IC_{i+1}, с возможностью пропустить часть входов. */
function combine(ic, inputs, include = () => true) {
    return inputs.reduce(
        (acc, value, i) => (value === 0n || !include(i) ? acc : acc.add(ic[i + 1].multiply(value))),
        ic[0],
    );
}

/**
 * Константы ключа для контракта (раскладка HintedVk в contracts/bn254/hinted.tolk).
 * Постоянные публичные входы заранее складываются в IC0; для переменных (не больше
 * двух) строятся оконные таблицы.
 */
export function buildVerificationKeyData(key, inputs, variableInputs) {
    if (variableInputs.length < 1 || variableInputs.length > 2) {
        throw new Error('Контракт поддерживает один или два переменных публичных входа');
    }
    const [firstIndex, secondIndex] = variableInputs;
    const ic0Folded = combine(key.ic, inputs, (i) => !variableInputs.includes(i));
    const alphaBeta = bn254.pairing(key.alpha, key.beta, false);
    const gammaAffine = affineLines(key.gamma);
    const deltaAffine = affineLines(key.delta);
    // По 8 чисел на шаг: λ и μ линии γ, затем λ и μ линии δ — ровно две ячейки.
    const lineValues = gammaAffine.flatMap((step, i) => [
        ...flat2(step.lambda),
        ...flat2(step.mu),
        ...flat2(deltaAffine[i].lambda),
        ...flat2(deltaAffine[i].mu),
    ]);
    const alphaBetaCell = fpChain(flat12(alphaBeta));
    const fixedLinesCell = fpChainAligned(lineValues);
    const table0 = windowTable(key.ic[firstIndex + 1]);
    const table1 = secondIndex === undefined ? { root: assembleTable([]), parts: [] } : windowTable(key.ic[secondIndex + 1]);
    const vkData = ton
        .beginCell()
        .storeUint(affine(ic0Folded).x, 254)
        .storeUint(affine(ic0Folded).y, 254)
        .storeRef(alphaBetaCell)
        .storeRef(fixedLinesCell)
        .storeRef(table0.root)
        .storeRef(table1.root)
        .endCell();
    // Части ключа в том виде, в каком их принимает контракт при загрузке по сообщениям.
    const upload = {
        ic0: [affine(ic0Folded).x, affine(ic0Folded).y],
        alphaBeta: alphaBetaCell,
        fixedLines: fixedLinesCell,
        table0Parts: table0.parts,
        table1Parts: table1.parts,
    };
    return { vkData, upload, ic0Folded, alphaBeta, gammaAffine, deltaAffine, variableInputs };
}

/**
 * Подсказки к пруфу. inputs — все публичные входы; с forge = true строится «лучшая
 * подделка» для ложного утверждения (см. buildHints), только для тестов.
 */
export function buildProofHints(key, prepared, points, inputs, { forge = false } = {}) {
    const { A, B, C } = points;
    const [firstIndex, secondIndex] = prepared.variableInputs;
    const firstInput = inputs[firstIndex];
    const secondInput = secondIndex === undefined ? 0n : inputs[secondIndex];
    const vkX = combine(key.ic, inputs);

    let msm = publicInputSlopes(affine(prepared.ic0Folded), key.ic[firstIndex + 1], firstInput);
    if (secondIndex !== undefined) {
        const second = publicInputSlopes(msm.point, key.ic[secondIndex + 1], secondInput);
        msm = { slopes: [...msm.slopes, ...second.slopes], point: second.point };
    }
    if (msm.point.x !== affine(vkX).x || msm.point.y !== affine(vkX).y) {
        throw new Error('Комбинация публичных входов по оконным таблицам не совпала с эталоном');
    }

    const bLines = affineLines(B);
    const bAffine = affine(B);
    const { hints, stats } = buildHints({
        proofInts: [
            affine(A).x,
            affine(A).y,
            affine(C).x,
            affine(C).y,
            bAffine.x.c0,
            bAffine.x.c1,
            bAffine.y.c0,
            bAffine.y.c1,
            firstInput,
        ],
        secondInput,
        slopes: bLines.map((step) => step.lambda),
        lines: [
            normalizedLineElements(bLines, A.negate()),
            normalizedLineElements(prepared.gammaAffine, vkX),
            normalizedLineElements(prepared.deltaAffine, C),
        ],
        alphaBeta: prepared.alphaBeta,
        pointHints: [Fp.inv(affine(vkX).y), Fp.inv(affine(A).y), Fp.inv(affine(C).y), ...msm.slopes],
        vkData: prepared.vkData,
        forge,
    });
    return { hints, stats, onchainInputs: [firstInput, secondInput] };
}
