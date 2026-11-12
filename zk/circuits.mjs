// Реестр схем этапа 0. Используется и сборкой (build.mjs), и генерацией
// верификаторов (gen-verifiers.mjs).
import { createHash } from 'node:crypto';

/** Числа публичных входов, для которых снимается бенчмарк газа. */
export const PUB_INPUT_COUNTS = [1, 2, 4, 8, 16, 32, 64];

/** Маска 253 бита: значение гарантированно меньше порядка скалярного поля BLS12-381. */
export const MASK_253 = (1n << 253n) - 1n;

const sha256 = (text) => BigInt('0x' + createHash('sha256').update(text).digest('hex'));

/** Детерминированное «похожее на root» значение, обрезанное до 253 бит. */
export const fieldValue = (label) => sha256(label) & MASK_253;

/** Четыре 256-битных значения rollup'а для варианта с одним входом-хешем. */
export const ROLLUP_VALUES = {
    oldStateRoot: sha256('stage0:old-state-root'),
    newStateRoot: sha256('stage0:new-state-root'),
    batchHash: sha256('stage0:batch-hash'),
    withdrawalsRoot: sha256('stage0:withdrawals-root'),
};

const toBitsBE = (value, width) =>
    Array.from({ length: width }, (_, i) => ((value >> BigInt(width - 1 - i)) & 1n).toString());

const pubCircuit = (n) => ({
    name: `pub${n}`,
    // main-файл генерируется сборкой: шаблон один, N разное.
    mainSource:
        `pragma circom 2.2.2;\n\ninclude "../../PubInputs.circom";\n\n` +
        `component main {public [pub]} = PubInputs(${n});\n`,
    input: {
        pub: Array.from({ length: n }, (_, i) => fieldValue(`stage0:pub:${n}:${i}`).toString()),
        k: '7',
    },
});

export const CIRCUITS = [
    {
        name: 'multiplier',
        sourceFile: 'circuits/Multiplier.circom',
        input: { a: '3', b: '11' },
    },
    {
        // Тот же Multiplier, но на BN254 (bn128) — кривой, на которой финализируют zkVM.
        // Верификатор для него не генерируется: export-ton-verifier умеет только BLS12-381.
        // Доказательство проверяется программным спариванием (contracts/bn254/).
        name: 'multiplier_bn254',
        sourceFile: 'circuits/Multiplier.circom',
        curve: 'bn128',
        // Публичный выход c = a · b делаем полноразмерным (253 бита), как у настоящего
        // rollup'а с хешем в публичном входе: от него зависит цена комбинации IC-точек.
        input: { a: fieldValue('stage0:bn254-public-input').toString(), b: '1' },
    },
    ...PUB_INPUT_COUNTS.map(pubCircuit),
    {
        name: 'hash4',
        sourceFile: 'circuits/HashedInputs.circom',
        input: {
            preimage: Object.values(ROLLUP_VALUES).flatMap((v) => toBitsBE(v, 256)),
        },
        // Сами значения нужны тесту, чтобы отправить их в контракт.
        extraFixture: {
            'preimage.json': Object.fromEntries(
                Object.entries(ROLLUP_VALUES).map(([k, v]) => [k, '0x' + v.toString(16).padStart(64, '0')]),
            ),
        },
    },
];
