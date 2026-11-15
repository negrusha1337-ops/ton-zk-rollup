import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { toNano } from '@ton/core';
import { loadRethExpected } from '../wrappers/evmProofs';
import { withdrawalLeafHash } from '../wrappers/rollupMath';
import { ESTIMATED_PRICES, trafficCosts, trafficPlan, TrafficPrices } from '../wrappers/testnetPlan';
import { withdrawalClaims, WithdrawalsMismatch } from '../sequencer/withdrawals';
import { loadL2Keys, storeL2Key } from '../sequencer/l2Keys';
import { createHash } from 'crypto';

// Доказательства выводов по отчётам блоков сервиса (sequencer/withdrawals.ts) на настоящих отчётах
// цепочки Reth (fixtures/evm_batches/reth/block-1..3.json — тот же формат, что пишет сервис в
// blocks/<N>/report.json), и план нагрузки по бюджету (trafficPlan в wrappers/testnetPlan.ts).

const expected = loadRethExpected();
const WORK = path.join(__dirname, '..', '.tools', 'sequencer-test', 'withdrawals');
const sha = (...values: bigint[]) => BigInt('0x' + createHash('sha256').update(Buffer.concat(values.map((v) => Buffer.from(v.toString(16).padStart(64, '0'), 'hex')))).digest('hex'));

describe('Выводы через мост по отчётам блоков сервиса', () => {
    let dir: string;
    const contract = (overrides = {}) => ({
        batchIndex: 3,
        stateRoot: BigInt(expected.blocks[2].hash),
        withdrawalsRoot: BigInt(expected.blocks[2].withdrawalsRoot),
        withdrawalsCount: BigInt(expected.blocks[2].withdrawalsCount),
        ...overrides,
    });
    beforeEach(() => {
        dir = path.join(WORK, randomBytes(4).toString('hex'));
        for (const block of [1, 2, 3]) {
            mkdirSync(path.join(dir, 'blocks', String(block)), { recursive: true });
            copyFileSync(path.join(__dirname, '..', 'fixtures', 'evm_batches', 'reth', `block-${block}.json`), path.join(dir, 'blocks', String(block), 'report.json'));
        }
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('листья блоков 1–3 сходятся с контрактом; каждое доказательство ведёт к корню', () => {
        const claims = withdrawalClaims(dir, contract());
        const upTo3 = expected.withdrawals.filter((leaf) => leaf.block <= 3);
        expect(upTo3.length).toBeGreaterThan(0);
        expect(claims.map((claim) => [claim.leafIndex, claim.block, claim.amount])).toEqual(upTo3.map((leaf) => [leaf.leafIndex, leaf.block, BigInt(leaf.amount)]));
        for (const claim of claims) {
            let node = withdrawalLeafHash(claim);
            claim.proof.forEach((sibling, depth) => {
                node = Math.floor(claim.leafIndex / 2 ** depth) % 2 === 0 ? sha(node, sibling) : sha(sibling, node);
            });
            expect(node).toBe(BigInt(expected.blocks[2].withdrawalsRoot));
        }
        // Батчей принято меньше — листья только их блоков.
        expect(withdrawalClaims(dir, contract({ batchIndex: 1, stateRoot: BigInt(expected.blocks[0].hash), withdrawalsRoot: BigInt(expected.blocks[0].withdrawalsRoot), withdrawalsCount: BigInt(expected.blocks[0].withdrawalsCount) }))).toHaveLength(expected.blocks[0].withdrawalsCount);
    });

    it('отказ, если отчёты не сходятся с контрактом: корень, слово состояния, нет отчёта, разрыв цепочки', () => {
        const fails = (overrides = {}) => {
            try {
                withdrawalClaims(dir, contract(overrides));
            } catch (error) {
                expect(error).toBeInstanceOf(WithdrawalsMismatch);
                return (error as Error).message;
            }
            throw new Error('не отказал');
        };
        expect(fails({ withdrawalsRoot: 1n })).toMatch(/дерево выводов по отчётам \(5 листьев, корень 0x[0-9a-f]+\) не то, что у контракта \(5, 0x1\)/);
        expect(fails({ withdrawalsCount: 4n })).toMatch(/не то, что у контракта \(4,/);
        expect(fails({ stateRoot: 7n })).toMatch(/слово состояния после блока 3 по отчётам 0x[0-9a-f]+, а у контракта 0x7/);
        expect(fails({ batchIndex: 4 })).toMatch(/blocks\/4\/report\.json: контракт принял батч 4, а отчёта блока в каталоге сервиса нет/);
        writeFileSync(path.join(dir, 'blocks', '2', 'report.json'), JSON.stringify({ ...require(path.join(__dirname, '..', 'fixtures', 'evm_batches', 'reth', 'block-3.json')), blockNumber: 2 }));
        expect(fails()).toMatch(/блок 2 не продолжает блок 1: prevStateRoot/);
    });
});

describe('План нагрузки по бюджету', () => {
    const prices: TrafficPrices = {
        depositAmount: toNano('0.06'),
        depositFee: ESTIMATED_PRICES.depositFee,
        withdrawAmount: toNano('0.05'),
        forceValue: toNano('0.055'),
        withdrawValue: toNano('0.011'),
        walletFee: toNano('0.004'),
    };
    const costs = trafficCosts(prices);

    it('сутки по действию в полчаса: депозиты и выводы по очереди, стоимость и возврат', () => {
        const plan = trafficPlan({ interval: 1800, duration: 86400, budget: toNano('10'), withdrawEvery: 1, prices });
        expect(plan).toMatchObject({ ticks: 48, deposits: 24, withdrawals: 24, truncated: false, problems: [] });
        expect(plan.spend).toBe(24n * costs.deposit + 24n * costs.withdrawal);
        expect(plan.returns).toBe(24n * toNano('0.05'));
        expect(costs.deposit).toBe(toNano('0.074'));
        expect(costs.withdrawal).toBe(toNano('0.074'));
    });

    it('бюджет кончается раньше срока — действия отбрасываются; меньше пары — отказ', () => {
        const short = trafficPlan({ interval: 1800, duration: 86400, budget: toNano('1'), withdrawEvery: 1, prices });
        expect(short.truncated).toBe(true);
        expect(short.spend).toBeLessThanOrEqual(toNano('1'));
        expect(short.deposits + short.withdrawals).toBe(13);
        expect(trafficPlan({ interval: 1800, duration: 86400, budget: toNano('0.1'), withdrawEvery: 1, prices }).problems).toEqual([
            'бюджет 0.1000 TON меньше одного депозита и одного вывода (0.1480 TON)',
        ]);
        // Без выводов (withdrawEvery=0) — только депозиты.
        expect(trafficPlan({ interval: 3600, duration: 86400, budget: toNano('10'), withdrawEvery: 0, prices })).toMatchObject({ deposits: 24, withdrawals: 0 });
        expect(trafficPlan({ interval: 30, duration: 86400, budget: toNano('10'), withdrawEvery: 1, prices }).problems[0]).toMatch(/не чаще раза в минуту/);
    });
});

describe('Ключи счетов L2 нагрузки (keys.json)', () => {
    it('файл — права 600 с первой записи; права шире — отказ чтения', () => {
        const dir = path.join(WORK, randomBytes(4).toString('hex'));
        const file = path.join(dir, 'keys.json');
        try {
            storeL2Key(file, { address: '0x' + '11'.repeat(20), secret: '22'.repeat(32), rollup: 'EQ…', createdAt: '' });
            storeL2Key(file, { address: '0x' + '33'.repeat(20), secret: '44'.repeat(32), rollup: 'EQ…', createdAt: '' });
            expect(statSync(file).mode & 0o777).toBe(0o600);
            expect(loadL2Keys(file).map((key) => key.address)).toEqual(['0x' + '11'.repeat(20), '0x' + '33'.repeat(20)]);
            chmodSync(file, 0o644);
            expect(() => loadL2Keys(file)).toThrow(/keys\.json: права 644, а должны быть 600/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
