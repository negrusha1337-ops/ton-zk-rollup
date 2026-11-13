import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';
import { Rollup, RollupErrors } from '../wrappers/Rollup';
import { forcedTransactionCell, merkleProofCell, sha256Int, withdrawalTree } from '../wrappers/rollupMath';
import { FORCE_TRANSACTION_VALUE } from '../wrappers/rollupValues';
import { computePhaseOf } from './helpers/gas';
import { finalizeDummyKeys } from './helpers/rollupSetup';

// Пороги монет и цена газа сети (находки К-2 второго круга и 3-К2 третьего, REVIEW.md).
//
// Пороги цепочки вывода заданы в газе и пересчитываются по конфигу сети. Здесь цена газа в
// конфиге Sandbox поднимается в 10 и в 100 раз, и проверяется, что:
//   • минимум вывода растёт вместе с ценой, и его по-прежнему хватает на всю цепочку;
//   • комиссии, оставшиеся в монетах (депозит 0,01 TON, принудительная транзакция 0,05 TON),
//     не начинают оплачивать газ из денег пользователей: когда комиссия перестаёт покрывать
//     газ шага, контракт отклоняет депозит, а не принимает его в убыток.
const GENESIS_ROOT = sha256Int(1n);
const CHAIN_ID = 4242n;
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;
const mockProof: Bn254Proof = {
    a: [1n, 0n],
    b: [
        [0n, 0n],
        [0n, 0n],
    ],
    c: [0n, 0n],
};
const BASECHAIN_GAS_PRICES = 21;

/** Конфиг сети с ценой газа basechain, умноженной на `factor` (параметр 21). */
function withGasPrice(config: Cell, factor: bigint): Cell {
    const params = Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell(), config);
    const prices = params.get(BASECHAIN_GAS_PRICES)!.beginParse();
    // gas_flat_pfx#d1 flat_gas_limit:uint64 flat_gas_price:uint64, затем
    // gas_prices_ext#de gas_price:uint64 … (остальное — лимиты, их не трогаем).
    if (prices.loadUint(8) !== 0xd1) throw new Error('неожиданный формат параметра 21');
    const flatLimit = prices.loadUintBig(64);
    const flatPrice = prices.loadUintBig(64);
    if (prices.loadUint(8) !== 0xde) throw new Error('неожиданный формат цен газа');
    const gasPrice = prices.loadUintBig(64);
    params.set(
        BASECHAIN_GAS_PRICES,
        beginCell()
            .storeUint(0xd1, 8)
            .storeUint(flatLimit, 64)
            .storeUint(flatPrice * factor, 64)
            .storeUint(0xde, 8)
            .storeUint(gasPrice * factor, 64)
            .storeSlice(prices)
            .endCell(),
    );
    return beginCell().storeDictDirect(params).endCell();
}

describe('Rollup: пороги монет следуют за ценой газа сети', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let baseConfig: Cell;
    const recipient = new Address(0, Buffer.alloc(32, 0xc7));
    const leaf = { leafIndex: 0, recipientHash: BigInt('0x' + recipient.hash.toString('hex')), amount: toNano('0.3') };
    const tree = withdrawalTree([leaf]);

    const deposit = () => rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') });
    const force = () =>
        rollup.sendForceTransaction(user.getSender(), {
            l2Transaction: forcedTransactionCell(Buffer.alloc(110, 7)),
            value: FORCE_TRANSACTION_VALUE,
        });
    const withdraw = (value: bigint) =>
        rollup.sendWithdraw(user.getSender(), {
            leafIndex: 0,
            recipient,
            amount: leaf.amount,
            merkleProof: merkleProofCell(tree.proofFor(0)),
            value,
        });
    const queued = async () => (await rollup.getDepositQueue()).head.count;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        baseConfig = blockchain.config;
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        user = await blockchain.treasury('user');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode: await compile('RollupNullifier'),
                    genesisStateRoot: GENESIS_ROOT,
                    chainId: CHAIN_ID,
                    escapeTimeout: 3600,
                },
                await compile('RollupMock'),
            ),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
        await finalizeDummyKeys(rollup, owner);
        await rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof,
            hints: beginCell().endCell(),
            roots: { newStateRoot: sha256Int(2n), withdrawalsRoot: tree.root },
            value: toNano('0.2'),
        });
    });

    it('при цене газа в 10 раз выше минимум вывода вырос, и его хватает на всю цепочку', async () => {
        const before = await rollup.getMinimumValues();
        blockchain.setConfig(withGasPrice(baseConfig, 10n));
        const after = await rollup.getMinimumValues();
        // Газовая часть порога выросла вдесятеро; плата за пересылку (другие параметры сети) — нет.
        expect(after.withdraw).toBeGreaterThan(before.withdraw * 5n);
        expect(after.forceExit).toBeGreaterThan(before.forceExit * 9n);

        // Прежнего минимума теперь мало — отказ до пометки.
        expect((await withdraw(before.withdraw)).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.notEnoughValue,
        });
        // Нового минимума хватает на все три шага: выплата дошла.
        const result = await withdraw(after.withdraw);
        expect(result.transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: leaf.amount });
        expect((await blockchain.getContract(recipient)).balance).toBe(leaf.amount);
        expect(await rollup.getOwedPayout(0n)).toBeNull();
    });

    it('депозит отклоняется, когда его комиссия перестаёт покрывать газ шага', async () => {
        expect((await deposit()).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await queued()).toBe(1n);

        // Граница — там, где стоимость газа шага с запасом (get-метод queueBudgets) сравнивается
        // с комиссией 0,01 TON. При нынешней цене газа это множитель 6: ×5 депозит ещё
        // проходит, ×7 — уже нет. Так запас шага закреплён тестом с обеих сторон.
        blockchain.setConfig(withGasPrice(baseConfig, 5n));
        expect((await deposit()).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await queued()).toBe(2n);

        blockchain.setConfig(withGasPrice(baseConfig, 7n));
        const rejected = await deposit();
        expect(rejected.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.feeBelowGasCost,
        });
        expect(rejected.transactions).toHaveTransaction({
            from: rollup.address,
            to: user.address,
            inMessageBounced: true,
        });
        expect(await queued()).toBe(2n);

        // Цены вернулись — депозиты снова принимаются.
        blockchain.setConfig(baseConfig);
        expect((await deposit()).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await queued()).toBe(3n);
    });

    it('принудительную транзакцию цена газа не запирает: плата растёт вместе с ней', async () => {
        // Принудительная транзакция — единственный способ запустить срок заморозки при пустой
        // очереди. Если бы дорогой газ её запрещал (как депозит), балансы L2 остались бы
        // заперты до снижения цен. Поэтому плата за неё — не меньше 0,05 TON и не меньше
        // стоимости газа шага; на суммы L2 она не влияет.
        const base = await rollup.getQueueBudgets();
        expect(base.forceTransactionFee).toBe(toNano('0.05'));
        expect((await force()).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await queued()).toBe(1n);

        // При цене в 100 раз выше газ шага стоит дороже 0,05 TON: прежней суммы мало…
        blockchain.setConfig(withGasPrice(baseConfig, 100n));
        const raised = await rollup.getQueueBudgets();
        expect(raised.forceTransactionFee).toBeGreaterThan(toNano('0.05'));
        expect((await force()).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.notEnoughValue,
        });
        expect(await queued()).toBe(1n);
        // …на нанотону меньше новой платы — отказ, ровно новая плата — транзакция в очереди.
        const forceWith = (value: bigint) =>
            rollup.sendForceTransaction(user.getSender(), {
                l2Transaction: forcedTransactionCell(Buffer.alloc(110, 7)),
                value,
            });
        expect((await forceWith(raised.forceTransactionFee - 1n)).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.notEnoughValue,
        });
        expect((await forceWith(raised.forceTransactionFee)).transactions).toHaveTransaction({
            to: rollup.address,
            success: true,
        });
        expect(await queued()).toBe(2n);
        // Депозит при той же цене отклонён, а срок заморозки уже идёт от поставленных элементов.
        expect((await deposit()).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.feeBelowGasCost,
        });
        expect((await rollup.getEscapeState()).oldestPendingAt).toBeGreaterThan(0);
    });

    it('шаги очереди укладываются в запасы газа и при длинном словаре квитанций', async () => {
        // Запасы газа шагов — у контракта (queueBudgets). Газ депозита растёт с глубиной
        // словаря квитанций: меряем его после нескольких сотен необработанных депозитов.
        const budgets = await rollup.getQueueBudgets();
        let worst = 0;
        for (let index = 0; index < 300; index++) {
            const result = await deposit();
            const used = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
            worst = Math.max(worst, used);
        }
        expect(await queued()).toBe(300n);
        expect(worst).toBeLessThan(budgets.depositStepGas);
        const forced = await force();
        const forcedGas = Number(computePhaseOf(forced.transactions, rollup.address).gasUsed);
        expect(forcedGas).toBeLessThan(budgets.forceTransactionStepGas);
    });
});
