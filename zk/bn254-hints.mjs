// Подсказки для проверки спаривания BN254 «в случайной точке» (приём Garaga).
//
// Fp12 рассматривается как Fp[x] / P(x), P(x) = x¹² − 18x⁶ + 82. Каждое
// произведение цикла Миллера записывается как тождество многочленов
//     Π факторов(x) = Q(x) · P(x) + R(x),
// где R — следующее значение аккумулятора. Прувер присылает все R и одно
// «склеенное» частное bigQ = Σ ρ^i · Q_i; контракт проверяет сумму тождеств
// в случайной точке z. ρ зависит от всех R, z — ещё и от bigQ (Fiat–Shamir).
//
// Соответствие башни и многочленов: w ↦ x, v ↦ x², u ↦ x⁶ − 9.
import { createHash } from 'node:crypto';
import ton from '@ton/core';
import { bn254 } from '@noble/curves/bn254.js';
import { ATE_NAF } from './bn254-params.mjs';
import { finalExpWitness } from './bn254-witness.mjs';

const { beginCell } = ton;
const { Fp, Fp2, Fp12 } = bn254.fields;
const p = Fp.ORDER;
const mod = (v) => ((v % p) + p) % p;

const ZERO2 = { c0: 0n, c1: 0n };

/** Аккумулятор присылается раз в столько шагов цикла (и после последнего шага). */
export const CHECKPOINT_EVERY = 2;

/** Шесть коэффициентов Fp2 элемента башни в порядке полей структуры. */
const towerPairs = (f) => [f.c0.c0, f.c0.c1, f.c0.c2, f.c1.c0, f.c1.c1, f.c1.c2];

/** Степень x для пары с номером index: пара (i, j) стоит при v^j · w^i = x^(2j + i). */
const pairDegree = (index) => 2 * (index % 3) + Math.floor(index / 3);

/** Элемент башни → 12 коэффициентов многочлена от x (младший первым). */
export function towerToDirect(f) {
    const d = Array(12).fill(0n);
    towerPairs(f).forEach((pair, index) => {
        const k = pairDegree(index);
        d[k] = mod(d[k] + pair.c0 - 9n * pair.c1);
        d[k + 6] = mod(d[k + 6] + pair.c1);
    });
    return d;
}

/**
 * Значения элемента в порядке, удобном контракту для схемы Горнера:
 * пары (a0, a1) по убыванию степени x, от x⁵ до x⁰.
 */
export function hornerValues(f) {
    const byDegree = [];
    towerPairs(f).forEach((pair, index) => {
        byDegree[pairDegree(index)] = pair;
    });
    return [5, 4, 3, 2, 1, 0].flatMap((k) => [mod(byDegree[k].c0), mod(byDegree[k].c1)]);
}

/** Разреженный элемент Fp12 из линии (o0, o3, o4). */
export const lineElement = (o0, o3, o4) => ({
    c0: { c0: o0, c1: ZERO2, c2: ZERO2 },
    c1: { c0: o3, c1: o4, c2: ZERO2 },
});

function polyMul(a, b) {
    const out = Array(a.length + b.length - 1).fill(0n);
    for (let i = 0; i < a.length; i++) {
        if (a[i] === 0n) continue;
        for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
    }
    return out.map(mod);
}

/** Деление на P(x) = x¹² − 18x⁶ + 82: возвращает частное и остаток (12 коэффициентов). */
function divideByP(poly) {
    const rem = [...poly];
    const quotient = Array(Math.max(poly.length - 12, 0)).fill(0n);
    for (let i = rem.length - 1; i >= 12; i--) {
        const lead = rem[i];
        if (lead === 0n) continue;
        quotient[i - 12] = lead;
        rem[i] = 0n;
        rem[i - 6] = mod(rem[i - 6] + 18n * lead); // x¹² = 18x⁶ − 82
        rem[i - 12] = mod(rem[i - 12] - 82n * lead);
    }
    return { quotient, remainder: rem.slice(0, 12) };
}

const evaluate = (poly, z) => poly.reduceRight((acc, coefficient) => mod(acc * z + coefficient), 0n);

/** Цепочка ячеек: по 4 элемента поля (254 бита) на ячейку, продолжение по ссылке. */
export function fpChain(values) {
    if (values.length === 0) throw new Error('fpChain: пустой список');
    let tail = null;
    for (let end = values.length; end > 0; end -= 4) {
        const builder = beginCell();
        for (const value of values.slice(Math.max(0, end - 4), end)) builder.storeUint(mod(value), 254);
        if (tail) builder.storeRef(tail);
        tail = builder.endCell();
    }
    return tail;
}

/** Длина частного bigQ. Определяется структурой цикла; контракт читает ровно столько (HINT_BIGQ_CELLS · 4). */
export const BIG_Q_COEFFICIENTS = 220;

/** Окно оконной таблицы публичного входа, бит. Должно совпадать с HINT_WINDOW_BITS в hinted.tolk. */
export const WINDOW_BITS = 6;

const XI_FOR_FROBENIUS = Fp2.NONRESIDUE;
/** Коэффициент Fp2 как многочлен от x: a0 + a1·(x⁶ − 9). */
const fp2Poly = (value) => [mod(value.c0 - 9n * value.c1), 0n, 0n, 0n, 0n, 0n, mod(value.c1)];

/**
 * Многочлен, сравнимый по модулю P(x) с Фробениусом степени power от элемента f:
 *   Σ_k x^k · conj^power(t_k)(x⁶) · γ_k(x⁶),  γ_k = ξ^(k·(p^power − 1)/6).
 * Произведение коэффициентов НЕ редуцируется: контракт считает его в точке z
 * двумя-тремя умножениями на член, без арифметики башни.
 */
export function frobeniusPolynomial(f, power) {
    const byDegree = [];
    towerPairs(f).forEach((pair, index) => {
        byDegree[pairDegree(index)] = power % 2 === 1 ? { c0: pair.c0, c1: mod(-pair.c1) } : pair;
    });
    let result = [0n];
    byDegree.forEach((pair, k) => {
        const gamma = Fp2.pow(XI_FOR_FROBENIUS, (BigInt(k) * (p ** BigInt(power) - 1n)) / 6n);
        const term = polyMul(fp2Poly(pair), fp2Poly(gamma));
        const shifted = [...Array(k).fill(0n), ...term];
        const length = Math.max(result.length, shifted.length);
        result = Array.from({ length }, (_, i) => mod((result[i] ?? 0n) + (shifted[i] ?? 0n)));
    });
    return result;
}

/**
 * Цепочка с ровно четырьмя значениями в каждой ячейке и пустой ячейкой в конце:
 * контракт читает её без проверок «не кончились ли биты».
 */
export function fpChainAligned(values) {
    if (values.length === 0 || values.length % 4 !== 0) {
        throw new Error(`fpChainAligned: длина ${values.length} не кратна 4`);
    }
    let tail = beginCell().endCell();
    for (let end = values.length; end > 0; end -= 4) {
        const builder = beginCell();
        for (const value of values.slice(end - 4, end)) builder.storeUint(mod(value), 254);
        tail = builder.storeRef(tail).endCell();
    }
    return tail;
}

const XI = Fp2.NONRESIDUE;
const PSI_X = Fp2.pow(XI, (p - 1n) / 3n);
const PSI_Y = Fp2.pow(XI, (p - 1n) / 2n);
/** Эндоморфизм psi на скрученной кривой (как в @noble/curves). */
const psi = ({ x, y }) => ({
    x: Fp2.mul(Fp2.frobeniusMap(x, 1), PSI_X),
    y: Fp2.mul(Fp2.frobeniusMap(y, 1), PSI_Y),
});

/**
 * Линии цикла Миллера для точки G2 в аффинных координатах.
 * Для каждого шага — наклон λ и свободный член μ = λ·x_T − y_T. Такая линия
 * отличается от линии noble множителем из Fp2, который исчезает при финальном
 * возведении в степень. Порядок шагов тот же: удвоение, затем (для ненулевой
 * цифры) сложение с ±Q, в конце два сложения с psi(Q) и −psi²(Q).
 */
export function affineLines(point) {
    const q = point.toAffine();
    let t = { x: q.x, y: q.y };
    const steps = [];
    const emit = (lambda, next) => {
        steps.push({ lambda, mu: Fp2.sub(Fp2.mul(lambda, t.x), t.y) });
        t = next(lambda);
    };
    const double = () =>
        emit(Fp2.div(Fp2.mul(Fp2.sqr(t.x), 3n), Fp2.mul(t.y, 2n)), (lambda) => {
            const x3 = Fp2.sub(Fp2.sqr(lambda), Fp2.mul(t.x, 2n));
            return { x: x3, y: Fp2.sub(Fp2.mul(lambda, Fp2.sub(t.x, x3)), t.y) };
        });
    const add = (other) =>
        emit(Fp2.div(Fp2.sub(other.y, t.y), Fp2.sub(other.x, t.x)), (lambda) => {
            const x3 = Fp2.sub(Fp2.sub(Fp2.sqr(lambda), t.x), other.x);
            return { x: x3, y: Fp2.sub(Fp2.mul(lambda, Fp2.sub(t.x, x3)), t.y) };
        });

    const negQ = { x: q.x, y: Fp2.neg(q.y) };
    for (const digit of ATE_NAF) {
        double();
        if (digit !== 0) add(digit < 0 ? negQ : q);
    }
    const q1 = psi(q);
    add(q1);
    const q2 = psi(q1);
    add({ x: q2.x, y: Fp2.neg(q2.y) });
    return steps;
}

/**
 * Линии в точке P ∈ G1, нормированные делением на y_P:
 *   1 − λ·(x_P / y_P)·w + μ·(1 / y_P)·w³.
 */
export function normalizedLineElements(steps, point) {
    const { x, y } = point.toAffine();
    const invY = Fp.inv(y);
    const ratio = Fp.mul(x, invY);
    return steps.map(({ lambda, mu }) =>
        lineElement({ c0: 1n, c1: 0n }, Fp2.neg(Fp2.mul(lambda, ratio)), Fp2.mul(mu, invY)),
    );
}

/**
 * Таблица кратных точки для окон по WINDOW_BITS бит — дерево ячеек с прямой
 * адресацией (дешевле словаря).
 *
 * Окно: ссылки [группа0, группа1]. Группа — четыре ссылки на узлы, узел — четыре
 * ссылки на листья. Лист с номером L = цифра >> 1 хранит две точки — для цифр 2L и
 * 2L+1, каждая как x, y по 254 бита (место цифры 0 заполнено нулями). Путь к листу:
 * группа L >> 4, узел (L >> 2) & 3, лист L & 3.
 *
 * Окна собраны в дерево с ветвлением 4: корень → узлы первого уровня → «части» →
 * окна. Часть (до четырёх окон, около 17 КБ) — единица загрузки ключа в сеть:
 * внешнее сообщение кошелька ограничено 64 КБ, целиком таблица не пролезает.
 * Контракт собирает корень из частей тем же способом (assembleTable).
 *
 * @returns {{ root: Cell, parts: Cell[] }}
 */
export function windowTable(point) {
    const radix = 1 << WINDOW_BITS;
    const windowCount = Math.ceil(254 / WINDOW_BITS);
    const quad = (items) => items.reduce((builder, item) => builder.storeRef(item), beginCell()).endCell();
    const leaf = (first, second) =>
        [first, second]
            .reduce((builder, pt) => builder.storeUint(pt ? pt.x : 0n, 254).storeUint(pt ? pt.y : 0n, 254), beginCell())
            .endCell();
    const node = (multiples, firstLeaf) =>
        quad([0, 1, 2, 3].map((i) => leaf(multiples[2 * (firstLeaf + i)], multiples[2 * (firstLeaf + i) + 1])));
    const group = (multiples, firstLeaf) => quad([0, 1, 2, 3].map((i) => node(multiples, firstLeaf + 4 * i)));

    const windows = [];
    let base = point;
    for (let window = 0; window < windowCount; window++) {
        const multiples = [null];
        let multiple = base;
        for (let digit = 1; digit < radix; digit++) {
            multiples.push(multiple.toAffine());
            multiple = multiple.add(base);
        }
        windows.push(quad([group(multiples, 0), group(multiples, 16)]));
        base = multiple; // radix · base
    }

    const parts = [];
    for (let i = 0; i < windows.length; i += 4) parts.push(quad(windows.slice(i, i + 4)));
    return { root: assembleTable(parts), parts };
}

/** Корень таблицы из частей: части по четыре в узлы первого уровня, узлы — в корень. */
export function assembleTable(parts) {
    if (parts.length === 0) return beginCell().endCell();
    if (parts.length > 16) throw new Error('assembleTable: больше 16 частей не помещается в двухуровневый корень');
    const level1 = [];
    for (let i = 0; i < parts.length; i += 4) {
        level1.push(
            parts
                .slice(i, i + 4)
                .reduce((builder, part) => builder.storeRef(part), beginCell())
                .endCell(),
        );
    }
    return level1.reduce((builder, node) => builder.storeRef(node), beginCell()).endCell();
}

/**
 * Прибавляет к точке start кратное scalar · base сложениями по оконной таблице,
 * как это делает контракт: по одному сложению на ненулевую цифру окна.
 * Возвращает наклоны секущих — контракт проверяет их уравнением
 * λ·(x₂ − x₁) = y₂ − y₁ и не тратит газ на деление.
 */
export function publicInputSlopes(start, base, scalar) {
    let acc = { x: start.x, y: start.y };
    let current = base;
    const slopes = [];
    const radix = 1n << BigInt(WINDOW_BITS);
    for (let rest = scalar; rest > 0n; rest >>= BigInt(WINDOW_BITS)) {
        const digit = rest & (radix - 1n);
        if (digit !== 0n) {
            const other = current.multiply(digit).toAffine();
            if (other.x === acc.x)
                throw new Error('publicInputSlopes: совпали абсциссы, нужен другой порядок сложений');
            const lambda = Fp.div(Fp.sub(other.y, acc.y), Fp.sub(other.x, acc.x));
            const x3 = Fp.sub(Fp.sub(Fp.sqr(lambda), acc.x), other.x);
            acc = { x: x3, y: Fp.sub(Fp.mul(lambda, Fp.sub(acc.x, x3)), acc.y) };
            slopes.push(lambda);
        }
        current = current.multiply(radix);
    }
    return { slopes, point: acc };
}

const bytes32 = (value) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
const sha256Int = (...parts) => BigInt('0x' + createHash('sha256').update(Buffer.concat(parts)).digest('hex'));
const cellHashInt = (cell) => BigInt('0x' + cell.hash().toString('hex'));

/**
 * Строит ячейку подсказок для контракта (contracts/bn254/hinted.tolk).
 *
 * @param input.proofInts   девять чисел в порядке хеширования: ax, ay, cx, cy, bx0, bx1, by0, by1, первый вход
 * @param input.secondInput второй переменный публичный вход (0, если его нет)
 * @param input.slopes      наклоны λ для 88 шагов точки B
 * @param input.lines       три массива линий (B, γ, δ) как элементы Fp12 в своих точках G1
 * @param input.alphaBeta   результат цикла Миллера для (α, β)
 * @param input.pointHints  [1/vkY, 1/ay, 1/cy, ...наклоны сложений для vk_x]
 * @param input.vkData      ячейка с константами ключа (её хеш входит в транскрипт)
 * @param input.forge       true — строить «лучшую подделку» для ЛОЖНОГО утверждения (только для тестов):
 *                          свидетеля не существует, поэтому c берётся произвольным, а все остальные
 *                          подсказки считаются честно. Контракт обязан такое отклонить.
 */
export function buildHints({ proofInts, secondInput, slopes, lines, alphaBeta, pointHints, vkData, forge = false }) {
    const [linesB, linesGamma, linesDelta] = lines;
    const product = (factors) => factors.reduce((acc, factor) => Fp12.mul(acc, factor), Fp12.ONE);
    const stepLines = (i) => [linesB[i], linesGamma[i], linesDelta[i]];
    const polyOf = (factors) => factors.map(towerToDirect).reduce(polyMul);

    /**
     * Цикл Миллера как последовательность тождеств. Внутри группы из
     * CHECKPOINT_EVERY шагов значение не редуцируется по модулю P(x): многочлен
     * просто растёт, а на контрольной точке делится на P(x) с остатком R.
     */
    const runLoop = (start, onPositive, onNegative) => {
        const relations = [];
        let value = start; // значение в башне (для сверки)
        let poly = towerToDirect(start); // нередуцированный многочлен левой части
        let index = 0;
        let sinceCheckpoint = 0;
        ATE_NAF.forEach((digit, position) => {
            const factors = [...stepLines(index)];
            index += 1;
            if (digit !== 0) {
                factors.push(...stepLines(index));
                const extra = digit < 0 ? onNegative : onPositive;
                if (extra) factors.push(extra);
                index += 1;
            }
            value = product([value, value, ...factors]);
            poly = polyMul(polyMul(poly, poly), polyOf(factors));
            sinceCheckpoint += 1;
            if (sinceCheckpoint === CHECKPOINT_EVERY || position === ATE_NAF.length - 1) {
                relations.push({ poly, result: value });
                poly = towerToDirect(value);
                sinceCheckpoint = 0;
            }
        });
        if (index + 2 !== linesB.length) throw new Error('Число линий не совпало с длиной цикла');
        return { relations, current: value, tail: [...stepLines(index), ...stepLines(index + 1)] };
    };

    // 0. Свидетель: f — выход цикла Миллера с теми же (нормированными) линиями.
    const plain = runLoop(Fp12.ONE, null, null);
    const miller = product([plain.current, ...plain.tail, alphaBeta]);
    // При подделке свидетеля нет: берём произвольный обратимый c и w = 1.
    const { c, w } = forge ? { c: alphaBeta, w: Fp12.ONE } : finalExpWitness(miller);
    const cInv = Fp12.inv(c);

    // 1. Все тождества: многочлен левой части и ожидаемый результат.
    const { relations, current, tail } = runLoop(cInv, cInv, c);
    const accumulators = relations.map((relation) => relation.result);
    const frobenius = [
        { value: Fp12.frobeniusMap(cInv, 1), poly: frobeniusPolynomial(cInv, 1) },
        { value: Fp12.frobeniusMap(c, 2), poly: frobeniusPolynomial(c, 2) },
        { value: Fp12.frobeniusMap(cInv, 3), poly: frobeniusPolynomial(cInv, 3) },
    ];
    frobenius.forEach(({ value, poly }, i) => {
        const expected = towerToDirect(value);
        if (divideByP(poly).remainder.some((coefficient, k) => coefficient !== expected[k])) {
            throw new Error(`Многочлен Фробениуса ${i + 1} не сравним с эталоном по модулю P(x)`);
        }
    });
    const closing = [current, ...tail, alphaBeta, w];
    const closes = Fp12.eql(product([...closing, ...frobenius.map((f) => f.value)]), Fp12.ONE);
    if (forge && closes) throw new Error('Подделка не получилась: утверждение оказалось верным');
    if (!forge && !closes) throw new Error('Итоговое произведение не равно 1: пруф или свидетель неверны');
    const closingIndex = relations.length;
    relations.push({
        poly: frobenius.reduce((acc, f) => polyMul(acc, f.poly), polyOf(closing)),
        result: Fp12.ONE,
    });
    relations.push({ poly: polyOf([c, cInv]), result: Fp12.ONE });

    // 2. Частные каждого тождества (остаток обязан совпасть с результатом).
    const quotients = relations.map(({ poly, result }, number) => {
        const { quotient, remainder } = divideByP(poly);
        const expected = towerToDirect(result);
        // У подделки не сходится только замыкающее тождество: его остаток отбрасывается —
        // это лучшее, что может сделать нечестный прувер, и именно это должен поймать контракт.
        const mismatch = remainder.some((value, i) => value !== expected[i]);
        if (mismatch && !(forge && number === closingIndex)) {
            throw new Error(`Тождество ${number}: остаток не совпал с результатом`);
        }
        return quotient;
    });

    // 3. Транскрипт: сначала всё, от чего зависят тождества, потом bigQ.
    const committed = fpChain([
        ...towerPairs(c).flatMap((pair) => [pair.c0, pair.c1]),
        ...towerPairs(cInv).flatMap((pair) => [pair.c0, pair.c1]),
        ...[w.c0.c0, w.c0.c1, w.c0.c2].flatMap((pair) => [pair.c0, pair.c1]),
        ...pointHints,
    ]);
    const slopeChain = fpChain(slopes.flatMap((lambda) => [lambda.c0, lambda.c1]));
    // Аккумуляторы — коэффициенты многочлена от x, старший первым (схема Горнера).
    const accumulatorChain = fpChainAligned(accumulators.flatMap((value) => [...towerToDirect(value)].reverse()));
    const seed = sha256Int(
        ...proofInts.map(bytes32),
        bytes32(cellHashInt(vkData)),
        bytes32(cellHashInt(committed)),
        bytes32(secondInput),
        bytes32(cellHashInt(slopeChain)),
        bytes32(cellHashInt(accumulatorChain)),
    );
    const rho = seed % p;

    // 4. bigQ = Σ ρ^(N−1−j) · Q_j (контракт сворачивает тождества схемой Горнера по ρ).
    //    Длина дополняется нулями до кратной 4 — цепочка читается целыми ячейками.
    const length = Math.ceil(Math.max(...quotients.map((q) => q.length)) / 4) * 4;
    if (length !== BIG_Q_COEFFICIENTS) {
        throw new Error(`Длина bigQ ${length} не равна ожидаемой ${BIG_Q_COEFFICIENTS}: изменилась структура тождеств`);
    }
    const bigQ = Array(length).fill(0n);
    quotients.forEach((quotient, j) => {
        const weight = Fp.pow(rho, BigInt(quotients.length - 1 - j));
        quotient.forEach((coefficient, i) => {
            bigQ[i] = mod(bigQ[i] + weight * coefficient);
        });
    });
    const bigQChain = fpChainAligned([...bigQ].reverse()); // старший коэффициент первым
    const z = sha256Int(bytes32(seed), bytes32(cellHashInt(bigQChain))) % p;

    // 5. Самопроверка: то же равенство, что проверит контракт.
    let acc = 0n;
    relations.forEach(({ poly, result }) => {
        acc = mod(acc * rho + evaluate(poly, z) - evaluate(towerToDirect(result), z));
    });
    const pAtZ = mod(z ** 12n - 18n * z ** 6n + 82n);
    const holds = acc === mod(evaluate(bigQ, z) * pAtZ);
    if (forge && holds) throw new Error('Подделка прошла самопроверку — так быть не должно');
    if (!forge && !holds) throw new Error('Самопроверка подсказок не прошла');

    const hints = beginCell()
        .storeRef(committed)
        .storeRef(slopeChain)
        .storeRef(accumulatorChain)
        .storeRef(bigQChain)
        .endCell();
    return {
        hints,
        stats: { relations: relations.length, accumulators: accumulators.length, bigQCoefficients: bigQ.length },
    };
}
