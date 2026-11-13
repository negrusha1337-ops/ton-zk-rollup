import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, contractAddress, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';
import { BASE_DEPOSIT_FEE, Rollup, RollupConfig, RollupErrors, RollupOpcodes } from '../wrappers/Rollup';
import { depositHash, forcedTransactionCell, sha256Int } from '../wrappers/rollupMath';
import { withGasPrice } from './helpers/gasPrice';
import { finalizeDummyKeys } from './helpers/rollupSetup';

// Плата за место в очереди L1 растёт с длиной очереди (находка К-4, REVIEW.md).
//
// Всё, что стоит в окне очереди (между отметками «цель» и «поставлено»), обязан обработать
// батч после следующего. Раньше окно можно было раздуть депозитами по 0,01 TON комиссии и
// сделать батч недоказуемым в срок — остановить rollup за копейки. Жёсткий предел окна был
// бы хуже: заполнив его, можно вытеснять чужие принудительные транзакции. Поэтому предела
// нет, а плата удваивается на каждые 64 элемента окна: место есть всегда, но раздувать
// очередь экспоненциально дорого.
const GENESIS_ROOT = sha256Int(1n);
const CHAIN_ID = 4242n;
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;
const BASE_FORCE_FEE = toNano('0.05');
const mockProof: Bn254Proof = {
    a: [1n, 0n],
    b: [
        [0n, 0n],
        [0n, 0n],
    ],
    c: [0n, 0n],
};

describe('Rollup: плата за место в очереди L1', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let ready: BlockchainSnapshot;
    let step: number;
    let config: RollupConfig;
    let code: Cell;

    const deposit = (value = toNano('1'), maxFee?: bigint) =>
        rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value, maxFee });
    const force = (value: bigint) =>
        rollup.sendForceTransaction(user.getSender(), {
            l2Transaction: forcedTransactionCell(Buffer.alloc(110, 7)),
            value,
        });
    const submit = (newStateRoot: bigint) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof,
            hints: beginCell().endCell(),
            roots: { newStateRoot, withdrawalsRoot: 0n },
            value: toNano('0.2'),
        });
    /** Ставит в очередь `count` депозитов, каждый — с комиссией, действующей на его момент. */
    const fill = async (count: number) => {
        for (let index = 0; index < count; index++) {
            const { depositFee } = await rollup.getQueueFees();
            const result = await deposit(toNano('1'), depositFee);
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
    };

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        user = await blockchain.treasury('user');
        config = {
            owner: owner.address,
            sequencer: sequencer.address,
            nullifierCode: await compile('RollupNullifier'),
            genesisStateRoot: GENESIS_ROOT,
            chainId: CHAIN_ID,
            escapeTimeout: 3600,
        };
        code = await compile('RollupMock');
        rollup = blockchain.openContract(Rollup.createFromConfig(config, code));
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
        await finalizeDummyKeys(rollup, owner);
        step = (await rollup.getQueueFees()).step;
        // Окно заполнено ровно до первого удвоения: дальше каждый тест идёт от этого снимка.
        await fill(step);
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
    });

    it('пока окно короче шага, плата базовая; на шаге — удваивается', async () => {
        expect(step).toBe(64);
        // До шага все депозиты снимка прошли по базовой комиссии: в очереди ровно `step`
        // элементов, и хеш очереди — как у депозитов с суммой «значение − 0,01 TON».
        let hash = 0n;
        for (let index = 0; index < step; index++) hash = depositHash(hash, L2_RECIPIENT, toNano('1') - BASE_DEPOSIT_FEE);
        expect(await rollup.getDepositQueue()).toMatchObject({ head: { count: BigInt(step), hash } });

        expect(await rollup.getQueueFees()).toEqual({
            depositFee: 2n * BASE_DEPOSIT_FEE,
            forceTransactionFee: 2n * BASE_FORCE_FEE,
            pending: step,
            step,
        });
    });

    it('депозит не уменьшается молча: без согласия на новую комиссию он возвращается целиком', async () => {
        // Вноситель согласен на базовую комиссию (значение по умолчанию), а она уже вдвое выше.
        const before = (await rollup.getDepositQueue()).head;
        const rejected = await deposit(toNano('1'));
        expect(rejected.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.queueFeeAboveLimit,
        });
        expect(rejected.transactions).toHaveTransaction({ from: rollup.address, to: user.address, inMessageBounced: true });
        expect((await rollup.getDepositQueue()).head).toEqual(before);

        // Согласие на нанотону меньше текущей комиссии — тоже отказ; ровно на текущую — депозит
        // принят, и на L2 зачтена сумма за вычетом именно её.
        const { depositFee } = await rollup.getQueueFees();
        expect((await deposit(toNano('1'), depositFee - 1n)).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.queueFeeAboveLimit,
        });
        expect((await deposit(toNano('1'), depositFee)).transactions).toHaveTransaction({
            to: rollup.address,
            success: true,
        });
        const amount = toNano('1') - depositFee;
        expect((await rollup.getDepositQueue()).head).toEqual({
            count: before.count + 1n,
            hash: depositHash(before.hash, L2_RECIPIENT, amount),
        });
        expect((await rollup.getDepositReceipt(Number(before.count) + 1))?.amount).toBe(amount);
        // Согласие «с запасом» лишнего не берёт: удерживается текущая комиссия, а не maxFee.
        expect((await deposit(toNano('1'), toNano('0.5'))).transactions).toHaveTransaction({
            to: rollup.address,
            success: true,
        });
        expect((await rollup.getDepositReceipt(Number(before.count) + 2))?.amount).toBe(amount);
    });

    it('минимальная сумма депозита считается после комиссии', async () => {
        // 0,06 TON при базовой комиссии — допустимый депозит (0,05 на L2); при удвоенной — уже нет.
        const { depositFee } = await rollup.getQueueFees();
        expect((await deposit(toNano('0.06'), depositFee)).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.depositTooSmall,
        });
        expect((await deposit(toNano('0.05') + depositFee, depositFee)).transactions).toHaveTransaction({
            to: rollup.address,
            success: true,
        });
    });

    it('принудительную транзакцию очередь не вытесняет: она только дорожает', async () => {
        const before = (await rollup.getDepositQueue()).head.count;
        const { forceTransactionFee } = await rollup.getQueueFees();
        expect(forceTransactionFee).toBe(2n * BASE_FORCE_FEE);
        // Базовой платы и платы на нанотону меньше текущей мало; ровно текущей — достаточно.
        for (const value of [BASE_FORCE_FEE, forceTransactionFee - 1n]) {
            expect((await force(value)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notEnoughValue,
            });
        }
        expect((await force(forceTransactionFee)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect((await rollup.getDepositQueue()).head.count).toBe(before + 1n);
        // Принудительные транзакции считаются в том же окне, что и депозиты.
        expect((await rollup.getQueueFees()).pending).toBe(step + 1);
    });

    it('раздувать окно экспоненциально дорого: второй шаг стоит вдвое дороже первого, третий — вчетверо', async () => {
        // Второй шаг окна: ещё `step` депозитов по удвоенной комиссии.
        await fill(step);
        expect(await rollup.getQueueFees()).toMatchObject({
            depositFee: 4n * BASE_DEPOSIT_FEE,
            forceTransactionFee: 4n * BASE_FORCE_FEE,
            pending: 2 * step,
        });
        // Третий шаг: комиссия вчетверо выше базовой. Сумма комиссий трёх шагов —
        // базовая × шаг × (1 + 2 + 4); столько атакующий теряет безвозвратно: на L2 ему
        // зачтено меньше внесённого ровно на комиссию (это видно по квитанциям).
        await fill(step);
        expect((await rollup.getQueueFees()).depositFee).toBe(8n * BASE_DEPOSIT_FEE);
        expect((await rollup.getQueueFees()).pending).toBe(3 * step);
        const creditedAt = async (index: number) => (await rollup.getDepositReceipt(index))!.amount;
        expect(await creditedAt(step)).toBe(toNano('1') - BASE_DEPOSIT_FEE);
        expect(await creditedAt(step + 1)).toBe(toNano('1') - 2n * BASE_DEPOSIT_FEE);
        expect(await creditedAt(2 * step)).toBe(toNano('1') - 2n * BASE_DEPOSIT_FEE);
        expect(await creditedAt(2 * step + 1)).toBe(toNano('1') - 4n * BASE_DEPOSIT_FEE);
        expect(await creditedAt(3 * step)).toBe(toNano('1') - 4n * BASE_DEPOSIT_FEE);

        // Принудительная транзакция дорожает так же: на третьем удвоении — 0,4 TON, и на
        // нанотону меньше её не поставить.
        const { forceTransactionFee } = await rollup.getQueueFees();
        expect(forceTransactionFee).toBe(8n * BASE_FORCE_FEE);
        expect((await force(forceTransactionFee - 1n)).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.notEnoughValue,
        });
        expect((await force(forceTransactionFee)).transactions).toHaveTransaction({ to: rollup.address, success: true });
    });

    it('после принятого батча окно начинается заново, а всё поставленное становится обязательным', async () => {
        const queued = (await rollup.getDepositQueue()).head;
        expect((await submit(sha256Int(2n))).transactions).toHaveTransaction({ to: rollup.address, success: true });
        // Цель сдвинулась на «поставлено»: следующий батч обязан обработать все элементы окна…
        const queue = await rollup.getDepositQueue();
        expect(queue.target).toEqual(queued);
        expect(queue.processed.count).toBe(0n);
        // …а новое окно пусто, и плата снова базовая — для всех, включая того, кого вытесняли ценой.
        expect(await rollup.getQueueFees()).toEqual({
            depositFee: BASE_DEPOSIT_FEE,
            forceTransactionFee: BASE_FORCE_FEE,
            pending: 0,
            step,
        });
        expect((await deposit(toNano('1'))).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect((await force(BASE_FORCE_FEE)).transactions).toHaveTransaction({ to: rollup.address, success: true });
    });

    it('депозит старого формата, без поля maxFee, не принимается', async () => {
        // Тело без maxFee: чтение поля за концом ячейки — исключение TVM 9. Депозит возвращается,
        // очередь не меняется: молча принять его с «нулевым согласием» было бы хуже.
        const before = (await rollup.getDepositQueue()).head;
        const body = beginCell()
            .storeUint(RollupOpcodes.depositTon, 32)
            .storeUint(0, 64)
            .storeUint(L2_RECIPIENT, 160)
            .endCell();
        const result = await user.send({ to: rollup.address, value: toNano('1'), body });
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode: 9 });
        expect(result.transactions).toHaveTransaction({ from: rollup.address, to: user.address, inMessageBounced: true });
        expect((await rollup.getDepositQueue()).head).toEqual(before);
    });

    it('дорогой газ и длинное окно перемножаются: удваивается плата, уже поднятая до стоимости газа', async () => {
        // При цене газа в 100 раз выше базовая плата за принудительную транзакцию — стоимость
        // газа шага, она больше 0,05 TON. Удвоение обязано применяться к ней, а не к 0,05 TON.
        blockchain.setConfig(withGasPrice(blockchain.config, 100n));
        const base = (await rollup.getQueueBudgets()).forceTransactionFee;
        expect(base).toBeGreaterThan(BASE_FORCE_FEE);
        const { forceTransactionFee } = await rollup.getQueueFees();
        expect(forceTransactionFee).toBe(2n * base);
        expect((await force(forceTransactionFee - 1n)).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.notEnoughValue,
        });
        expect((await force(forceTransactionFee)).transactions).toHaveTransaction({ to: rollup.address, success: true });
    });

    it('плата растёт все сорок удвоений и на этом останавливается', async () => {
        // Предел удвоений нельзя ни занизить (плата застыла бы, и раздувать окно снова стало бы
        // дёшево), ни убрать (сдвиг переполнил бы сумму). Окна такой длины депозитами не
        // набрать, поэтому контракт развёртывается с очередью, уже стоящей на нужной отметке.
        const withWindow = async (pending: bigint) => {
            const canonical = Rollup.createFromConfig({ ...config, genesisStateRoot: GENESIS_ROOT + pending }, code);
            const root = canonical.init!.data.beginParse();
            const rootBits = root.loadBits(root.remainingBits);
            const [keys, nullifier, state] = [root.loadRef(), root.loadRef(), root.loadRef()];
            const stateSlice = state.beginParse();
            const stateHead = stateSlice.loadBits(256 + 256 + 64);
            stateSlice.loadRef(); // прежняя очередь: все отметки нулевые
            const queue = beginCell()
                .storeUint(pending, 64) // поставлено
                .storeUint(1, 256)
                .storeUint(0, 64) // цель
                .storeUint(0, 256)
                .storeUint(0, 64) // обработано
                .storeUint(0, 256)
                .endCell();
            const data = beginCell()
                .storeBits(rootBits)
                .storeRef(keys)
                .storeRef(nullifier)
                .storeRef(beginCell().storeBits(stateHead).storeRef(queue).storeSlice(stateSlice).endCell())
                .endCell();
            const init = { code, data };
            const contract = blockchain.openContract(new Rollup(contractAddress(0, init), init));
            await contract.sendDeploy(owner.getSender(), toNano('1'));
            return contract.getQueueFees();
        };
        const stepSize = BigInt(step);
        expect(await withWindow(39n * stepSize)).toMatchObject({
            depositFee: BASE_DEPOSIT_FEE << 39n,
            forceTransactionFee: BASE_FORCE_FEE << 39n,
        });
        const capped = { depositFee: BASE_DEPOSIT_FEE << 40n, forceTransactionFee: BASE_FORCE_FEE << 40n };
        expect(await withWindow(40n * stepSize)).toMatchObject(capped);
        expect(await withWindow(41n * stepSize)).toMatchObject(capped);
        expect(await withWindow(1000n * stepSize)).toMatchObject(capped);
    });
});
