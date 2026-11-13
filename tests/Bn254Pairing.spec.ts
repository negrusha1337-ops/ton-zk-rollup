import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { Blockchain } from '@ton/sandbox';
import { Address, beginCell, Cell, contractAddress, toNano, TupleItem } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';

type Vectors = {
    fp12: { a: string[]; b: string[]; mul: string[]; sqr: string[]; inv: string[]; frobenius: string[][] };
    pairing: { g1: string[]; g2: string[]; millerLoop: string[]; finalExp: string[]; gtSquared: string[] };
    bilinear: { g1: string[]; g2: string[] }[];
};

const vectors: Vectors = JSON.parse(
    readFileSync(path.join(__dirname, '..', 'fixtures', 'bn254', 'vectors.json'), 'utf8'),
);

// Компиляция стенда и вызовы на миллионы gas не укладываются в стандартные 5 с Jest,
// особенно когда наборы тестов идут параллельно.
jest.setTimeout(120_000);

// Get-методы в Sandbox ограничены по газу; спариванию нужно намного больше 1M.
const GET_GAS_LIMIT = 100_000_000n;

const ints = (values: (string | number | bigint)[]): TupleItem[] =>
    values.map((value) => ({ type: 'int', value: BigInt(value) }));

// Программное спаривание BN254 в TVM: каждая ступень сверяется с @noble/curves.
describe('BN254: программное спаривание в TVM', () => {
    let blockchain: Blockchain;
    let bench: Address;
    const gasLog: Record<string, number> = {};
    let hintedProfile: Record<string, number> = {};

    const call = async (method: string, args: TupleItem[], outputs = 12) => {
        const result = await blockchain.runGetMethod(bench, method, args, { gasLimit: GET_GAS_LIMIT });
        gasLog[method] = Number(result.gasUsed);
        return Array.from({ length: outputs }, () => result.stackReader.readBigNumber().toString());
    };

    beforeAll(async () => {
        const code = await compile('Bn254Bench');
        blockchain = await Blockchain.create();
        const deployer = await blockchain.treasury('deployer');
        const init = { code, data: beginCell().endCell() };
        bench = contractAddress(0, init);
        await deployer.send({ to: bench, init, value: toNano('1') });
    });

    afterAll(() => {
        console.table(gasLog);
        const file = path.join(__dirname, '..', 'bench', 'bn254-software-pairing.json');
        // Неполный прогон (упавшие или отфильтрованные тесты) не должен затирать замеры:
        // пишем, только если есть всё, что было в прежнем файле, и профиль по стадиям.
        const previous: Record<string, number> = existsSync(file)
            ? (JSON.parse(readFileSync(file, 'utf8')).gas ?? {})
            : {};
        const missing = Object.keys(previous).filter((name) => !(gasLog[name] > 0));
        if (missing.length > 0 || Object.keys(hintedProfile).length === 0) {
            console.warn(`bench/bn254-software-pairing.json не обновлён: нет измерений ${missing.join(', ') || 'профиля'}`);
            return;
        }
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
            file,
            JSON.stringify(
                {
                    source: 'Измерено в @ton/sandbox тестом tests/Bn254Pairing.spec.ts; не редактировать вручную',
                    note: 'Газ get-методов стенда contracts/bn254_bench.tolk: наивная реализация без подсказок и предвычислений',
                    gas: gasLog,
                    hintedProfile,
                },
                null,
                2,
            ) + '\n',
        );
    });

    it('Fp12: умножение', async () => {
        expect(await call('fp12Mul', ints([...vectors.fp12.a, ...vectors.fp12.b]))).toEqual(vectors.fp12.mul);
    });

    it('Fp12: квадрат', async () => {
        expect(await call('fp12Sqr', ints(vectors.fp12.a))).toEqual(vectors.fp12.sqr);
    });

    it('Fp12: обращение', async () => {
        expect(await call('fp12Inv', ints(vectors.fp12.a))).toEqual(vectors.fp12.inv);
    });

    it.each([1, 2, 3])('Fp12: Фробениус степени %i', async (power) => {
        expect(await call('fp12Frobenius', ints([...vectors.fp12.a, power]))).toEqual(
            vectors.fp12.frobenius[power - 1],
        );
    });

    it('цикл Миллера совпадает с эталоном', async () => {
        const { g1, g2, millerLoop } = vectors.pairing;
        expect(await call('millerLoop', ints([...g1, ...g2]))).toEqual(millerLoop);
    });

    it('финальное возведение в степень совпадает с эталоном', async () => {
        expect(await call('finalExp', ints(vectors.pairing.millerLoop))).toEqual(vectors.pairing.finalExp);
    });

    it('циклотомический квадрат совпадает с обычным на элементе GT', async () => {
        expect(await call('fp12CyclotomicSquare', ints(vectors.pairing.finalExp))).toEqual(vectors.pairing.gtSquared);
    });

    it('полное спаривание совпадает с эталоном', async () => {
        const { g1, g2, finalExp } = vectors.pairing;
        expect(await call('pairing', ints([...g1, ...g2]))).toEqual(finalExp);
    });

    it('билинейность: e(sP, Q) · e(−P, sQ) = 1', async () => {
        const [first, second] = vectors.bilinear;
        const args = ints([...first.g1, ...first.g2, ...second.g1, ...second.g2]);
        const result = await blockchain.runGetMethod(bench, 'pairingCheck2', args, { gasLimit: GET_GAS_LIMIT });
        gasLog.pairingCheck2 = Number(result.gasUsed);
        expect(result.stackReader.readBoolean()).toBe(true);

        // Испорченная вторая пара: то же, но с P вместо −P.
        const broken = ints([...first.g1, ...first.g2, ...vectors.pairing.g1, ...second.g2]);
        const bad = await blockchain.runGetMethod(bench, 'pairingCheck2', broken, { gasLimit: GET_GAS_LIMIT });
        expect(bad.stackReader.readBoolean()).toBe(false);
    });

    describe('Groth16 на BN254 (доказательство snarkjs для Multiplier)', () => {
        const fixture = (file: string) =>
            JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'multiplier_bn254', file), 'utf8'));
        const proof = fixture('proof.json');
        const vk = fixture('verification_key.json');
        const publicSignals: string[] = fixture('public.json');

        // snarkjs хранит точки как [x, y, 1], а элементы Fp2 — как [c0, c1].
        const g1 = (point: string[]) => [point[0], point[1]];
        const g2 = (point: string[][]) => [point[0][0], point[0][1], point[1][0], point[1][1]];
        const buildArgs = (pi: { a: string[]; b: string[][]; c: string[] }, publicInput: string) =>
            ints([
                ...g1(pi.a),
                ...g2(pi.b),
                ...g1(pi.c),
                ...g1(vk.vk_alpha_1),
                ...g2(vk.vk_beta_2),
                ...g2(vk.vk_gamma_2),
                ...g2(vk.vk_delta_2),
                ...g1(vk.IC[0]),
                ...g1(vk.IC[1]),
                publicInput,
            ]);
        const verify = async (args: TupleItem[]) => {
            const result = await blockchain.runGetMethod(bench, 'groth16Verify', args, { gasLimit: GET_GAS_LIMIT });
            return { ok: result.stackReader.readBoolean(), gas: Number(result.gasUsed) };
        };
        const original = { a: proof.pi_a, b: proof.pi_b, c: proof.pi_c };
        const otherInput = (BigInt(publicSignals[0]) + 1n).toString();

        it('фикстура на кривой bn128', () => {
            expect(vk.curve).toBe('bn128');
            // Публичный вход полноразмерный: от него зависит цена комбинации IC-точек.
            expect(BigInt(publicSignals[0])).toBeGreaterThan(1n << 240n);
        });

        it('валидное доказательство проходит', async () => {
            const { ok, gas } = await verify(buildArgs(original, publicSignals[0]));
            gasLog.groth16Verify = gas;
            expect(ok).toBe(true);
        });

        it('отклоняет чужой публичный вход', async () => {
            expect((await verify(buildArgs(original, otherInput))).ok).toBe(false);
        });

        it('отклоняет подменённую точку доказательства', async () => {
            expect((await verify(buildArgs({ ...original, c: proof.pi_a }, publicSignals[0]))).ok).toBe(false);
        });

        describe('оптимизированная проверка: константы ключа + свидетель', () => {
            const onchain = fixture('onchain.json') as {
                vk: { ic: string[]; alphaBetaMiller: string[]; lines: string[] };
                witness: { c: string[]; cInv: string[]; w: string[] };
            };

            /** Цепочка ячеек: по 4 элемента поля (254 бита) на ячейку. */
            const fpChain = (values: string[]): Cell => {
                let tail: Cell | null = null;
                for (let end = values.length; end > 0; end -= 4) {
                    const builder = beginCell();
                    for (const value of values.slice(Math.max(0, end - 4), end)) {
                        builder.storeUint(BigInt(value), 254);
                    }
                    if (tail) builder.storeRef(tail);
                    tail = builder.endCell();
                }
                if (!tail) throw new Error('fpChain: пустой список');
                return tail;
            };

            const vkData = beginCell()
                .storeSlice(fpChain(onchain.vk.ic).beginParse())
                .storeRef(fpChain(onchain.vk.alphaBetaMiller))
                .storeRef(fpChain(onchain.vk.lines))
                .endCell();

            const witnessArgs = (
                publicInput: string,
                witness: { c: string[]; cInv: string[]; w: string[] },
            ): TupleItem[] => [
                ...ints([...g1(proof.pi_a), ...g2(proof.pi_b), ...g1(proof.pi_c), publicInput]),
                ...ints([...witness.c, ...witness.cInv, ...witness.w]),
                { type: 'cell', cell: vkData },
            ];
            const verifyWitness = async (args: TupleItem[]) => {
                const result = await blockchain.runGetMethod(bench, 'groth16VerifyWitness', args, {
                    gasLimit: GET_GAS_LIMIT,
                });
                return { ok: result.stackReader.readBoolean(), gas: Number(result.gasUsed) };
            };

            it('ключ укладывается в цепочки по 4 значения', () => {
                expect(onchain.vk.ic).toHaveLength(4);
                expect(onchain.vk.alphaBetaMiller).toHaveLength(12);
                expect(onchain.vk.lines.length % 12).toBe(0);
            });

            it('валидное доказательство проходит', async () => {
                const { ok, gas } = await verifyWitness(witnessArgs(publicSignals[0], onchain.witness));
                gasLog.groth16VerifyWitness = gas;
                expect(ok).toBe(true);
            });

            it('отклоняет чужой публичный вход при том же свидетеле', async () => {
                expect((await verifyWitness(witnessArgs(otherInput, onchain.witness))).ok).toBe(false);
            });

            it('отклоняет испорченный свидетель c', async () => {
                const c = [...onchain.witness.c];
                c[0] = (BigInt(c[0]) + 1n).toString();
                expect((await verifyWitness(witnessArgs(publicSignals[0], { ...onchain.witness, c }))).ok).toBe(false);
            });

            it('отклоняет испорченный множитель w', async () => {
                const w = [...onchain.witness.w];
                w[0] = (BigInt(w[0]) + 1n).toString();
                expect((await verifyWitness(witnessArgs(publicSignals[0], { ...onchain.witness, w }))).ok).toBe(false);
            });

            it('отклоняет согласованную, но чужую пару (c, c⁻¹)', async () => {
                // c = 1, c⁻¹ = 1: проверка c · c⁻¹ = 1 проходит, но равенство со спариванием — нет.
                const one = ['1', ...Array(11).fill('0')];
                const forged = { c: one, cInv: one, w: onchain.witness.w };
                expect((await verifyWitness(witnessArgs(publicSignals[0], forged))).ok).toBe(false);
            });
        });

        describe('проверка с подсказками: тождества в случайной точке', () => {
            const hinted = (
                fixture('onchain.json') as {
                    hinted: {
                        vkDataBoc: string;
                        hintsBoc: string;
                        outsideSubgroup: { b: string[]; hintsBoc: string };
                    };
                }
            ).hinted;
            const vkData = Cell.fromBase64(hinted.vkDataBoc);
            const hints = Cell.fromBase64(hinted.hintsBoc);

            const hintedArgs = (
                pi: { a: string[]; b: string[][]; c: string[] },
                publicInput: string,
                hintsCell: Cell,
            ): TupleItem[] => [
                // Второй переменный вход у этой схемы отсутствует — передаём 0.
                ...ints([...g1(pi.a), ...g2(pi.b), ...g1(pi.c), publicInput, 0]),
                { type: 'cell', cell: vkData },
                { type: 'cell', cell: hintsCell },
            ];
            // Поддельные данные отклоняются двумя способами: итоговое равенство не
            // сходится (false) либо срабатывает промежуточная проверка (исключение 7002–7010).
            const verifyHinted = async (args: TupleItem[]) => {
                try {
                    const result = await blockchain.runGetMethod(bench, 'groth16VerifyHinted', args, {
                        gasLimit: GET_GAS_LIMIT,
                    });
                    return { ok: result.stackReader.readBoolean(), gas: Number(result.gasUsed), exitCode: 0 };
                } catch (err) {
                    const exitCode = Number(/exit_code: (\d+)/.exec(String(err))?.[1] ?? -1);
                    if (exitCode < 7002 || exitCode > 7010) throw err;
                    return { ok: false, gas: 0, exitCode };
                }
            };

            /** Копия подсказок, в которой первое число цепочки с номером ref увеличено на 1. */
            const tamperHints = (ref: number): Cell => {
                const refs = [...hints.refs];
                const chain = refs[ref].beginParse();
                const first = chain.loadUintBig(254);
                refs[ref] = beginCell()
                    .storeUint(first + 1n, 254)
                    .storeSlice(chain)
                    .endCell();
                return refs.reduce((builder, cell) => builder.storeRef(cell), beginCell()).endCell();
            };

            it('валидное доказательство проходит', async () => {
                const { ok, gas } = await verifyHinted(hintedArgs(original, publicSignals[0], hints));
                gasLog.groth16VerifyHinted = gas;
                expect(ok).toBe(true);
            });

            it('отклоняет чужой публичный вход', async () => {
                expect((await verifyHinted(hintedArgs(original, otherInput, hints))).ok).toBe(false);
            });

            it('отклоняет подменённую точку доказательства', async () => {
                const forged = { ...original, c: proof.pi_a };
                expect((await verifyHinted(hintedArgs(forged, publicSignals[0], hints))).ok).toBe(false);
            });

            it.each([
                [0, 'свидетель и подсказки точек'],
                [1, 'наклон линии точки B'],
                [2, 'аккумулятор цикла'],
                [3, 'частное bigQ'],
            ])('отклоняет испорченную подсказку: ссылка %i — %s', async (ref) => {
                const forged = tamperHints(ref as number);
                expect((await verifyHinted(hintedArgs(original, publicSignals[0], forged))).ok).toBe(false);
            });

            it('испорченный наклон ловится уравнением касательной, а не итоговым равенством', async () => {
                const result = await verifyHinted(hintedArgs(original, publicSignals[0], tamperHints(1)));
                expect(result.exitCode).toBe(7006);
            });

            it('отклоняет удлинённое частное', async () => {
                // Лишняя нулевая ячейка в начале bigQ не меняет его значения как многочлена,
                // но длина частного зафиксирована: иначе прувер мог бы поднимать степень.
                const refs = [...hints.refs];
                refs[3] = beginCell()
                    .storeUint(0, 254)
                    .storeUint(0, 254)
                    .storeUint(0, 254)
                    .storeUint(0, 254)
                    .storeRef(refs[3])
                    .endCell();
                const longer = refs.reduce((builder, cell) => builder.storeRef(cell), beginCell()).endCell();
                const result = await verifyHinted(hintedArgs(original, publicSignals[0], longer));
                expect(result.exitCode).toBe(7004);
            });

            it('отклоняет лишние данные в корне подсказок', async () => {
                const padded = hints.refs
                    .reduce((builder, cell) => builder.storeRef(cell), beginCell().storeUint(1, 8))
                    .endCell();
                const result = await verifyHinted(hintedArgs(original, publicSignals[0], padded));
                expect(result.exitCode).toBe(7004);
            });

            it('отклоняет точку A вне кривой', async () => {
                const offCurve = { ...original, a: [proof.pi_a[0], (BigInt(proof.pi_a[1]) + 1n).toString()] };
                const result = await verifyHinted(hintedArgs(offCurve, publicSignals[0], hints));
                expect(result.exitCode).toBe(7010);
            });

            it('отклоняет точку B вне скрученной кривой', async () => {
                const [x, y] = proof.pi_b as string[][];
                const offCurve = { ...original, b: [x, [y[0], (BigInt(y[1]) + 1n).toString()]] };
                const result = await verifyHinted(hintedArgs(offCurve, publicSignals[0], hints));
                expect(result.exitCode).toBe(7010);
            });

            it('отклоняет точку B на кривой, но вне подгруппы G2', async () => {
                const rogue = hinted.outsideSubgroup;
                const args: TupleItem[] = [
                    ...ints([...g1(proof.pi_a), ...rogue.b, ...g1(proof.pi_c), publicSignals[0], 0]),
                    { type: 'cell', cell: vkData },
                    { type: 'cell', cell: Cell.fromBase64(rogue.hintsBoc) },
                ];
                const result = await verifyHinted(args);
                expect(result.exitCode).toBe(7009);
            });

            it('отклоняет «лучшую подделку»: честные подсказки к ложному утверждению', async () => {
                // Все наклоны, аккумуляторы и частные посчитаны честно для изменённого входа;
                // не сходится только замыкающее тождество. Промежуточные проверки пройдены,
                // поэтому отказ обязан прийти от итогового равенства (false), а не исключением.
                const forgery = (
                    fixture('onchain.json') as { hinted: { forgery: { inputs: string[]; hintsBoc: string } } }
                ).hinted.forgery;
                const result = await verifyHinted(
                    hintedArgs(original, forgery.inputs[0], Cell.fromBase64(forgery.hintsBoc)),
                );
                expect(result).toMatchObject({ ok: false, exitCode: 0 });
            });

            describe('разные пруфы одной схемы', () => {
                const { cases } = fixture('cases.json') as {
                    cases: { label: string; proof: string[]; inputs: string[]; hintsBoc: string }[];
                };
                const gasByCase: Record<string, number> = {};

                afterAll(() => {
                    const values = Object.values(gasByCase);
                    gasLog.hintedCasesMin = Math.min(...values);
                    gasLog.hintedCasesMax = Math.max(...values);
                    console.table(gasByCase);
                });

                it.each(cases.map((testCase) => [testCase.label, testCase] as const))(
                    'публичный вход «%s»: пруф проходит',
                    async (label, testCase) => {
                        const args: TupleItem[] = [
                            ...ints([...testCase.proof, ...testCase.inputs]),
                            { type: 'cell', cell: vkData },
                            { type: 'cell', cell: Cell.fromBase64(testCase.hintsBoc) },
                        ];
                        const result = await verifyHinted(args);
                        gasByCase[label] = result.gas;
                        expect(result).toMatchObject({ ok: true, exitCode: 0 });
                    },
                );

                it('подсказки от одного пруфа не подходят к другому', async () => {
                    const [first, second] = [cases[4], cases[5]];
                    const args: TupleItem[] = [
                        ...ints([...first.proof, ...first.inputs]),
                        { type: 'cell', cell: vkData },
                        { type: 'cell', cell: Cell.fromBase64(second.hintsBoc) },
                    ];
                    expect((await verifyHinted(args)).ok).toBe(false);
                });
            });

            it('профиль газа по стадиям', async () => {
                const result = await blockchain.runGetMethod(
                    bench,
                    'groth16VerifyHintedProfile',
                    hintedArgs(original, publicSignals[0], hints),
                    { gasLimit: GET_GAS_LIMIT },
                );
                const marks = result.stackReader.readTuple();
                const values: number[] = [];
                while (marks.remaining > 0) values.push(marks.readNumber());
                const stages = [
                    'транскрипт, свидетель, vk_x по оконной таблице',
                    'цикл: 65 тождеств, линии B по наклонам',
                    'замыкающее тождество и c · c⁻¹',
                    'частное bigQ',
                ];
                const profile = Object.fromEntries(stages.map((name, i) => [name, values[i + 1] - values[i]]));
                console.table(profile);
                hintedProfile = profile;
                expect(values).toHaveLength(stages.length + 1);
            });

            it('стоимость линий переменной точки B', async () => {
                const args = ints([proof.pi_a[0], proof.pi_a[1], ...g2(proof.pi_b)]);
                const result = await blockchain.runGetMethod(bench, 'linesOnly', args, { gasLimit: GET_GAS_LIMIT });
                gasLog.linesOnly = Number(result.gasUsed);
                expect(result.stackReader.readNumber()).toBe(88);
            });
        });

        it('стоимость одной линейной комбинации публичного входа', async () => {
            const args = ints([...g1(vk.IC[0]), ...g1(vk.IC[1]), publicSignals[0]]);
            const result = await blockchain.runGetMethod(bench, 'g1PublicInputCombination', args, {
                gasLimit: GET_GAS_LIMIT,
            });
            gasLog.g1PublicInputCombination = Number(result.gasUsed);
            expect(result.stackReader.readBigNumber()).toBeGreaterThan(0n);
        });
    });

    // Настоящие пруфы zkVM. Происхождение файлов — source.json в каталоге фикстуры.
    describe.each([
        {
            name: 'SP1 v6 (программа Фибоначчи)',
            directory: 'sp1_v6_fibonacci',
            variable: ['publicValuesDigest', 'nonce'],
        },
        {
            name: 'RISC Zero (тестовая квитанция)',
            directory: 'risc0_v3_test_receipt',
            variable: ['claimDigest0', 'claimDigest1'],
        },
    ])('Groth16 на BN254: настоящий пруф $name', ({ directory, variable }) => {
        const fixture = (file: string) =>
            JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', directory, file), 'utf8'));
        const proof = fixture('proof.json');
        const source = fixture('source.json') as { inputNames: string[]; variableInputs: number[] };
        const publicSignals: string[] = fixture('public.json');
        const hinted = (
            fixture('onchain.json') as {
                hinted: {
                    vkDataBoc: string;
                    hintsBoc: string;
                    inputs: string[];
                    forgery: { inputs: string[]; hintsBoc: string };
                };
            }
        ).hinted;
        const vkData = Cell.fromBase64(hinted.vkDataBoc);
        const hints = Cell.fromBase64(hinted.hintsBoc);

        const args = (inputs: string[], hintsCell: Cell): TupleItem[] => [
            ...ints([
                proof.pi_a[0],
                proof.pi_a[1],
                proof.pi_b[0][0],
                proof.pi_b[0][1],
                proof.pi_b[1][0],
                proof.pi_b[1][1],
                proof.pi_c[0],
                proof.pi_c[1],
                ...inputs,
            ]),
            { type: 'cell', cell: vkData },
            { type: 'cell', cell: hintsCell },
        ];
        const verify = async (callArgs: TupleItem[]) => {
            const result = await blockchain.runGetMethod(bench, 'groth16VerifyHinted', callArgs, {
                gasLimit: GET_GAS_LIMIT,
            });
            return { ok: result.stackReader.readBoolean(), gas: Number(result.gasUsed) };
        };

        it('у пруфа пять публичных входов, два из них переменные', () => {
            expect(publicSignals).toHaveLength(5);
            expect(source.variableInputs.map((i) => source.inputNames[i])).toEqual(variable);
            expect(hinted.inputs).toEqual(source.variableInputs.map((i) => publicSignals[i]));
        });

        it('пруф проходит проверку в TVM', async () => {
            const { ok, gas } = await verify(args(hinted.inputs, hints));
            gasLog[`${directory}:groth16VerifyHinted`] = gas;
            expect(ok).toBe(true);
        });

        it('отклоняет «лучшую подделку» для другого первого входа', async () => {
            const forged = await verify(args(hinted.forgery.inputs, Cell.fromBase64(hinted.forgery.hintsBoc)));
            expect(forged.ok).toBe(false);
        });

        it('отклоняет другой первый вход с подсказками от настоящего', async () => {
            // Наклоны сложений посчитаны для настоящего входа: подмена ловится исключением 7006.
            const forged = [(BigInt(hinted.inputs[0]) ^ 1n).toString(), hinted.inputs[1]];
            await expect(verify(args(forged, hints))).rejects.toThrow(/exit_code: 7006/);
        });
    });
});
