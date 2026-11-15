import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { BASE_DEPOSIT_FEE, Rollup, RollupConfig, RollupErrors, RollupOpcodes } from '../wrappers/Rollup';
import { depositHash, forcedTransactionCell, sha256Int } from '../wrappers/rollupMath';
import { withGasPrice } from './helpers/gasPrice';
import { finalizeDummyKeys, mockProof, ProtocolConstants, readProtocolConstants, testConfig } from './helpers/rollupSetup';

// Плата за место в очереди L1 растёт с длиной очереди (находка К-4, REVIEW.md).
//
// Необработанный хвост очереди (между отметками «обработано» и «поставлено») секвенсор обязан
// разобрать раньше, чем самый старый элемент провисит срок заморозки. Хвост можно было бы
// раздуть депозитами по 0,01 TON комиссии — остановить rollup за копейки. Жёсткий предел был
// бы хуже: заполнив его, можно вытеснять чужие принудительные транзакции. Поэтому плата
// удваивается на каждые 64 необработанных элемента: место есть всегда, но раздувать очередь
// экспоненциально дорого. В протоколе v2 окно — именно необработанный хвост: плату снижает
// только обработка очереди, а не сам факт принятого батча.
const CHAIN_ID = 4242n;
const START = 1_800_000_000;
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;
const BASE_FORCE_FEE = toNano('0.05');
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
    let constants: ProtocolConstants;

    const deposit = (value = toNano('1'), maxFee?: bigint) =>
        rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value, maxFee });
    const force = (value: bigint) =>
        rollup.sendForceTransaction(user.getSender(), {
            l2Transaction: forcedTransactionCell(Buffer.alloc(110, 7)),
            value,
        });
    /** Батч, обработавший очередь до элемента `upTo`. */
    const submit = (newStateRoot: bigint, upTo: number) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof(),
            hints: beginCell().endCell(),
            roots: {
                newStateRoot,
                withdrawalsRoot: 0n,
                withdrawalsCount: 0n,
                queueProcessedUpTo: BigInt(upTo),
                blockTimestamp: BigInt(START),
            },
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
        blockchain.now = START;
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        user = await blockchain.treasury('user');
        code = await compile('RollupMock');
        const nullifierCode = await compile('RollupNullifier');
        constants = await readProtocolConstants(code, nullifierCode);
        config = testConfig(constants, {
            owner: owner.address,
            sequencer: sequencer.address,
            nullifierCode,
            chainId: CHAIN_ID,
            escapeTimeout: 3600,
        });
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

    it('пока необработанных элементов меньше шага, плата базовая; на шаге — удваивается', async () => {
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

    it('плату снижает только обработка очереди: батч, не тронувший её, ничего не меняет', async () => {
        const doubled = {
            depositFee: 2n * BASE_DEPOSIT_FEE,
            forceTransactionFee: 2n * BASE_FORCE_FEE,
            pending: step,
            step,
        };
        // Батч принят, но очередь он не обработал: необработанных столько же, плата прежняя.
        expect((await submit(sha256Int(2n), 0)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect((await rollup.getRollupState()).batchIndex).toBe(1);
        expect(await rollup.getQueueFees()).toEqual(doubled);
        expect((await deposit(toNano('1'))).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.queueFeeAboveLimit,
        });

        // Обработан один элемент: необработанных на один меньше шага, плата снова базовая — для
        // всех, включая того, кого вытесняли ценой.
        expect((await submit(sha256Int(3n), 1)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await rollup.getQueueFees()).toEqual({
            depositFee: BASE_DEPOSIT_FEE,
            forceTransactionFee: BASE_FORCE_FEE,
            pending: step - 1,
            step,
        });
        expect((await deposit(toNano('1'))).transactions).toHaveTransaction({ to: rollup.address, success: true });
        // Этот депозит вернул длину хвоста к шагу: плата опять удвоена.
        expect(await rollup.getQueueFees()).toEqual(doubled);
        expect((await force(BASE_FORCE_FEE)).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.notEnoughValue,
        });
    });

    it('окно считается от отметки processed: очередь разбирается батчами, плата падает вместе с хвостом', async () => {
        await fill(step); // необработанных 2 × шаг: плата учетверена
        expect((await rollup.getQueueFees()).depositFee).toBe(4n * BASE_DEPOSIT_FEE);
        const perBatch = constants.maxBatchQueueItems;
        let processed = 0;
        let root = 2n;
        const pendingAfter = async () => (await rollup.getQueueFees()).pending;
        while (processed < 2 * step) {
            processed = Math.min(processed + perBatch, 2 * step);
            expect((await submit(sha256Int(root++), processed)).transactions).toHaveTransaction({
                to: rollup.address,
                success: true,
            });
            const pending = 2 * step - processed;
            expect(await pendingAfter()).toBe(pending);
            expect((await rollup.getQueueFees()).depositFee).toBe(BASE_DEPOSIT_FEE << BigInt(Math.floor(pending / step)));
        }
        expect(await rollup.getQueueFees()).toEqual({
            depositFee: BASE_DEPOSIT_FEE,
            forceTransactionFee: BASE_FORCE_FEE,
            pending: 0,
            step,
        });
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
        // Предел удвоений нельзя ни занизить (плата застыла бы, и раздувать очередь снова стало бы
        // дёшево), ни убрать (сдвиг переполнил бы сумму). Хвоста такой длины депозитами не
        // набрать, поэтому контракт развёртывается с очередью, уже стоящей на нужной отметке.
        const withWindow = async (pending: bigint) => {
            // Очередь подложена прямо в начальные данные; обработано тоже не ноль — окно считается
            // как разность отметок, а не как длина очереди.
            const processed = 5n;
            const contract = blockchain.openContract(
                Rollup.createPlanted(
                    config,
                    {
                        batchIndex: pending, // чтобы у каждого контракта был свой адрес
                        queue: { head: { count: processed + pending, hash: 1n }, processed: { count: processed, hash: 2n } },
                    },
                    code,
                ),
            );
            await contract.sendDeploy(owner.getSender(), toNano('1'));
            expect((await contract.getQueueFees()).pending).toBe(Number(pending));
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
