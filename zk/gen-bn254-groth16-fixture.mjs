// Готовит данные для оптимизированной проверки BN254-Groth16 в TVM:
//   • константы ключа верификации — IC-точки, результат цикла Миллера для (α, β)
//     и коэффициенты линий для фиксированных точек γ и δ;
//   • свидетель (c, c⁻¹, w) для конкретного доказательства.
// Всё считается эталонной библиотекой @noble/curves. Результат:
// fixtures/<имя>/onchain.json.
//
// Запуск: node zk/gen-bn254-groth16-fixture.mjs [имя фикстуры]   (по умолчанию multiplier_bn254)
//
// Публичные входы делятся на переменные (не больше двух, для них строятся оконные
// таблицы) и постоянные — их вклад заранее складывается в IC0. Список переменных
// берётся из source.json фикстуры (поле variableInputs); по умолчанию это вход 0.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bn254 } from '@noble/curves/bn254.js';
import { finalExpWitness } from './bn254-witness.mjs';
import ton from '@ton/core';
import { affineLines, fpChain } from './bn254-hints.mjs';
import {
    buildProofHints,
    buildVerificationKeyData,
    flat12,
    flat2,
    flat6,
    parseProof,
    parseVerificationKey,
} from './bn254-onchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = process.argv[2] ?? 'multiplier_bn254';
const DIR = path.join(ROOT, 'fixtures', NAME);
if (!existsSync(path.join(DIR, 'proof.json'))) {
    console.error(`Нет фикстуры fixtures/${NAME}/proof.json`);
    process.exit(1);
}
const { Fp12 } = bn254.fields;

const read = (file) => JSON.parse(readFileSync(path.join(DIR, file), 'utf8'));
const proof = read('proof.json');
const vk = read('verification_key.json');
const publicSignals = read('public.json');

const strings = (values) => values.map(String);
const key = parseVerificationKey(vk);
const { alpha, beta, gamma, delta, ic } = key;
const points = parseProof(proof);
const { A, B, C } = points;

const inputs = publicSignals.map(BigInt);
const source = existsSync(path.join(DIR, 'source.json')) ? read('source.json') : {};
const variableInputs = source.variableInputs ?? [0];
if (variableInputs.length < 1 || variableInputs.length > 2) {
    throw new Error('Контракт поддерживает один или два переменных публичных входа');
}

// vk_x = IC0 + Σ pub_i · IC_{i+1}
const addMultiple = (acc, i) => (inputs[i] === 0n ? acc : acc.add(ic[i + 1].multiply(inputs[i])));
const vkX = inputs.reduce((acc, _, i) => addMultiple(acc, i), ic[0]);
// Постоянные входы (ключ программы, корень ключей и т. п.) складываются в IC0 заранее.
const ic0Folded = inputs.reduce((acc, _, i) => (variableInputs.includes(i) ? acc : addMultiple(acc, i)), ic[0]);

// e(−A, B) · e(α, β) · e(vk_x, γ) · e(C, δ) = 1
const miller = bn254.pairingBatch(
    [
        { g1: A.negate(), g2: B },
        { g1: alpha, g2: beta },
        { g1: vkX, g2: gamma },
        { g1: C, g2: delta },
    ],
    false,
);
const { c, w } = finalExpWitness(miller);

// Линии для фиксированной точки G2: по шагам цикла, без домножения на точку G1.
const lineCoefficients = (point) =>
    bn254.utils.calcPairingPrecomputes(point).flatMap((step) => step.map(([c0, c1, c2]) => [c0, c1, c2]));
const gammaLines = lineCoefficients(gamma);
const deltaLines = lineCoefficients(delta);
if (gammaLines.length !== deltaLines.length) throw new Error('Разное число линий у γ и δ');

const icValues = ic.flatMap((point) => [point.toAffine().x, point.toAffine().y]);
const alphaBeta = bn254.pairing(alpha, beta, false);
const fixedLineValues = gammaLines.flatMap((line, i) => [...line.flatMap(flat2), ...deltaLines[i].flatMap(flat2)]);

// --- Проверка с подсказками: константы ключа и подсказки к пруфу ---
const { Fp2 } = bn254.fields;
const affine = (point) => point.toAffine();
const prepared = buildVerificationKeyData(key, inputs, variableInputs);
const hintedVkData = prepared.vkData;
const { hints, stats, onchainInputs } = buildProofHints(key, prepared, points, inputs);
const [firstInput, secondInput] = onchainInputs;

// «Лучшая подделка»: тот же пруф, но первый переменный вход изменён. Все подсказки
// (наклоны, аккумуляторы, частные) посчитаны честно для ложного утверждения; не сходится
// только замыкающее тождество. Контракт обязан отклонить её итоговым равенством.
const forgedInputs = [...inputs];
forgedInputs[variableInputs[0]] = inputs[variableInputs[0]] ^ 1n;
const forgery = buildProofHints(key, prepared, points, forgedInputs, { forge: true });

// Подделка утверждения для пруфов наших программ zkVM: настоящий пруф предъявляется под
// ЧУЖИЕ публичные значения — те, что посчитает rollup-контракт, если в сообщении подменить
// одно поле. Подсказки построены честно для этого ложного утверждения, так что контракт
// доходит до замыкающего равенства и обязан отказать именно на нём (код WrongProof).
//   • батч: слово 2 публичных значений (новый корень состояния) с перевёрнутым младшим битом;
//   • выход: слово 3 (сумма) на единицу больше.
function statementForgery() {
    if (source.kind !== 'batch' && source.kind !== 'exit') return undefined;
    const values = Buffer.from(source.publicValues.slice(2), 'hex');
    const wordIndex = source.kind === 'batch' ? 2 : 3;
    const original = BigInt('0x' + values.subarray(wordIndex * 32, (wordIndex + 1) * 32).toString('hex'));
    const altered = source.kind === 'batch' ? original ^ 1n : original + 1n;
    const forgedValues = Buffer.from(values);
    Buffer.from(altered.toString(16).padStart(64, '0'), 'hex').copy(forgedValues, wordIndex * 32);
    const digest = BigInt('0x' + createHash('sha256').update(forgedValues).digest('hex')) & ((1n << 253n) - 1n);
    const statementInputs = [...inputs];
    statementInputs[variableInputs[0]] = digest;
    const forged = buildProofHints(key, prepared, points, statementInputs, { forge: true });
    return {
        note:
            source.kind === 'batch'
                ? 'Настоящий пруф под батч с другим новым корнем состояния (младший бит перевёрнут)'
                : 'Настоящий пруф под заявку на выход с суммой на единицу больше',
        alteredWord: wordIndex,
        alteredValue: String(altered),
        input: String(digest),
        hintsBoc: forged.hints.toBoc().toString('base64'),
    };
}
const forgedStatement = statementForgery();

// Точка на скрученной кривой, но вне подгруппы G2 — для теста проверки подгруппы.
// Наклоны для неё честные, остальные подсказки взяты от настоящего пруфа: контракт
// обязан остановиться на проверке подгруппы, а не дойти до итогового равенства.
function pointOutsideSubgroup() {
    const twistB = Fp2.div(Fp2.fromBigTuple([3n, 0n]), Fp2.NONRESIDUE);
    for (let i = 1n; i < 1000n; i++) {
        const x = Fp2.fromBigTuple([i, 1n]);
        const rhs = Fp2.add(Fp2.mul(Fp2.sqr(x), x), twistB);
        let y;
        try {
            y = Fp2.sqrt(rhs);
        } catch {
            continue;
        }
        if (!Fp2.eql(Fp2.sqr(y), rhs)) continue;
        const point = bn254.G2.Point.fromAffine({ x, y });
        if (!point.isTorsionFree()) return point;
    }
    throw new Error('Не нашлась точка вне подгруппы G2');
}
const rogue = pointOutsideSubgroup();
const rogueHints = ton
    .beginCell()
    .storeRef(hints.refs[0])
    .storeRef(fpChain(affineLines(rogue).flatMap((step) => [step.lambda.c0, step.lambda.c1])))
    .storeRef(hints.refs[2])
    .storeRef(hints.refs[3])
    .endCell();

const fixture = {
    source: 'Сгенерировано zk/gen-bn254-groth16-fixture.mjs из @noble/curves; не редактировать вручную',
    lineCount: gammaLines.length,
    vk: {
        ic: strings(icValues),
        // Результат цикла Миллера для пары (α, β) — константа ключа.
        alphaBetaMiller: strings(flat12(alphaBeta)),
        // По 12 чисел на шаг: c0, c1, c2 линии γ, затем c0, c1, c2 линии δ.
        lines: strings(fixedLineValues),
    },
    witness: {
        c: strings(flat12(c)),
        cInv: strings(flat12(Fp12.inv(c))),
        w: strings(flat6(w.c0)),
    },
    // Готовые ячейки для проверки с подсказками (хеш vkData входит в транскрипт).
    // Свидетель для неё свой: линии нормированы иначе, чем в разделе witness.
    hinted: {
        vkDataBoc: hintedVkData.toBoc().toString('base64'),
        // Тот же ключ частями — для загрузки в контракт сообщениями (каждая часть < 64 КБ).
        keyUpload: {
            ic0: strings(prepared.upload.ic0),
            alphaBetaBoc: prepared.upload.alphaBeta.toBoc().toString('base64'),
            fixedLinesBoc: prepared.upload.fixedLines.toBoc().toString('base64'),
            table0PartsBoc: prepared.upload.table0Parts.map((part) => part.toBoc().toString('base64')),
            table1PartsBoc: prepared.upload.table1Parts.map((part) => part.toBoc().toString('base64')),
        },
        hintsBoc: hints.toBoc().toString('base64'),
        // Переменные публичные входы в том порядке, в каком их ждёт контракт.
        inputs: strings([firstInput, secondInput]),
        forgery: {
            inputs: strings(forgery.onchainInputs),
            hintsBoc: forgery.hints.toBoc().toString('base64'),
        },
        ...(forgedStatement ? { statementForgery: forgedStatement } : {}),
        outsideSubgroup: {
            b: strings([affine(rogue).x.c0, affine(rogue).x.c1, affine(rogue).y.c0, affine(rogue).y.c1]),
            hintsBoc: rogueHints.toBoc().toString('base64'),
        },
        ...stats,
    },
};
writeFileSync(path.join(DIR, 'onchain.json'), JSON.stringify(fixture) + '\n');
console.log(
    `Записано: fixtures/${NAME}/onchain.json (линий на точку: ${fixture.lineCount}, ` +
        `тождеств: ${stats.relations}, аккумуляторов: ${stats.accumulators}, коэффициентов bigQ: ${stats.bigQCoefficients})`,
);
