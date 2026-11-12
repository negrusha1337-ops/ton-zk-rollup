import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { Blockchain } from '@ton/sandbox';
import { beginCell, contractAddress, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';

const ITERATIONS = 1000;
const SEED = 123456789n;
const BABYBEAR_P = 2013265921n;
const BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

const METHODS = [
    'benchEmptyLoop',
    'benchSha256Merkle',
    'benchKeccak256Merkle',
    'benchBabyBearMulAdd',
    'benchBabyBearExt4Mul',
    'benchBn254FpMul',
    'benchBn254FpMulConstModulus',
    'benchBn254FpAdd',
    'benchCallDictionary',
    'benchCallRef',
    'benchPushBigConstant',
    'benchReadGlobal',
    'benchMaskOnly',
] as const;

// Цена примитивов TVM, из которых состоит верификатор STARK (FRI):
// хеш пары узлов Merkle-дерева и арифметика малого поля.
describe('Микробенчмарк примитивов TVM', () => {
    it('измеряет газ на операцию и сверяет результаты с эталоном', async () => {
        const code = await compile('TvmPrimitivesBench');
        const blockchain = await Blockchain.create();
        const deployer = await blockchain.treasury('deployer');
        const init = { code, data: beginCell().endCell() };
        const address = contractAddress(0, init);
        await deployer.send({ to: address, init, value: toNano('1') });

        const run = async (method: string, n: number) => {
            const result = await blockchain.runGetMethod(address, method, [
                { type: 'int', value: BigInt(n) },
                { type: 'int', value: SEED },
            ]);
            return { gas: Number(result.gasUsed), value: result.stackReader.readBigNumber() };
        };

        // Эталоны вне блокчейна: убеждаемся, что меряем именно то, что думаем.
        let sha = SEED;
        const seedBytes = SEED.toString(16).padStart(64, '0');
        for (let i = 0; i < 3; i++) {
            const input = Buffer.from(sha.toString(16).padStart(64, '0') + seedBytes, 'hex');
            sha = BigInt('0x' + createHash('sha256').update(input).digest('hex'));
        }
        expect((await run('benchSha256Merkle', 3)).value).toBe(sha);

        let field = SEED;
        for (let i = 0; i < 5; i++) field = (field * field + SEED) % BABYBEAR_P;
        expect((await run('benchBabyBearMulAdd', 5)).value).toBe(field);

        let fp = SEED;
        for (let i = 0; i < 7; i++) fp = (fp * fp) % BN254_P;
        expect((await run('benchBn254FpMul', 7)).value).toBe(fp);

        const baseline = await run('benchEmptyLoop', ITERATIONS);
        const perOperation: Record<string, number> = {};
        for (const method of METHODS) {
            const { gas } = await run(method, ITERATIONS);
            perOperation[method] = Number(((gas - baseline.gas) / ITERATIONS).toFixed(2));
        }

        const report = {
            source: 'Измерено в @ton/sandbox тестом tests/TvmPrimitives.spec.ts; не редактировать вручную',
            iterations: ITERATIONS,
            emptyLoopTotalGas: baseline.gas,
            note: 'Газ на одну операцию сверх пустого цикла (включая сборку builder и работу со стеком)',
            gasPerOperation: perOperation,
        };
        const file = path.join(__dirname, '..', 'bench', 'tvm-primitives.json');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
        console.table(perOperation);

        expect(perOperation.benchSha256Merkle).toBeGreaterThan(0);
        expect(perOperation.benchBabyBearExt4Mul).toBeGreaterThan(perOperation.benchBabyBearMulAdd);
    });
});
