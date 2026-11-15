import { Blockchain, internal as internalFrom, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, contractAddress, internal, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { NullifierErrors, Rollup, RollupErrors, RollupOpcodes } from '../wrappers/Rollup';
import { merkleProofCell, sha256Int, withdrawalTree } from '../wrappers/rollupMath';
import { RollupNullifier } from '../wrappers/RollupNullifier';
import { saveGasReport } from './helpers/benchResults';
import { cellStats, computePhaseOf } from './helpers/gas';
import { finalizeDummyKeys, mockProof, ProtocolConstants, readProtocolConstants, testConfig } from './helpers/rollupSetup';

// Выплата после нуллификатора: находки второго круга проверки (REVIEW.md).
//
// Нуллификатор помечает заявку ДО выплаты, и снять пометку нельзя. Раньше при нехватке
// баланса в момент выплаты заявка сгорала: пометка стоит, денег нет. Проверка баланса на
// шаге Withdraw этого не исключала — между ней и выплатой два сообщения. Теперь шаг
// выплаты не может потерять заявку: он платит или записывает долг.
//
// Запасы газа (пороги в contracts/rollup/nullifier_types.tolk и logic.tolk) тест берёт у
// самого контракта (get-метод payoutBudgets) и следит, чтобы измеренный расход в них
// укладывался. Копии констант в тесте не годятся: уменьшенный в контракте запас прошёл бы
// незамеченным. Размер заявки в нуллификатор — оценка, по которой контракт считает плату за
// пересылку (CLAIM_MESSAGE_BITS и CLAIM_MESSAGE_CELLS в logic.tolk).
const CLAIM_MESSAGE_BITS = 8192;
const CLAIM_MESSAGE_CELLS = 16;

const CHAIN_ID = 4242n;
const TIMEOUT = 3600;
const START = 1_800_000_000;
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;
const NO_HINTS = beginCell().endCell();
const recipientOf = (byte: number) => new Address(0, Buffer.alloc(32, byte));
const hashOf = (address: Address) => BigInt('0x' + address.hash.toString('hex'));

describe('Rollup: выплата не теряется', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let constants: ProtocolConstants;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    const gas: Record<string, number> = {};
    let budgets: Awaited<ReturnType<SandboxContract<Rollup>['getPayoutBudgets']>>;

    const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;
    /** Долг по ключу нуллификатора в сравнимом виде (адрес — строкой). */
    const owedBy = async (key: bigint) => {
        const debt = await rollup.getOwedPayout(key);
        return debt && { recipient: debt.recipient.toString(), amount: debt.amount };
    };
    const debtTo = (recipient: Address, amount: bigint) => ({ recipient: recipient.toString(), amount });
    const isDeployed = async (address: Address) =>
        ((await blockchain.getContract(address)).accountState?.type ?? 'uninit') === 'active';
    /** Батч с таким корнем выводов; очередь обрабатывается до головы. Счётчик выводов на логику выплаты не влияет. */
    const submit = async (newStateRoot: bigint, withdrawalsRoot = 0n) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof(),
            hints: NO_HINTS,
            roots: {
                newStateRoot,
                withdrawalsRoot,
                withdrawalsCount: withdrawalsRoot === 0n ? 0n : 1n,
                queueProcessedUpTo: (await rollup.getDepositQueue()).head.count,
                blockTimestamp: BigInt(blockchain.now!),
            },
            value: toNano('0.2'),
        });
    const deploy = async (value: bigint) => {
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                testConfig(constants, {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode,
                    chainId: CHAIN_ID,
                    escapeTimeout: TIMEOUT,
                }),
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), value);
        await finalizeDummyKeys(rollup, owner);
        budgets = await rollup.getPayoutBudgets();
    };
    /** Подтверждение NullifierClaimed, как его шлёт нуллификатор. */
    const claimedBody = (key: bigint, recipient: Address, amount: bigint) =>
        beginCell()
            .storeUint(RollupOpcodes.nullifierClaimed, 32)
            .storeUint(0, 64)
            .storeUint(key, 256)
            .storeAddress(recipient)
            .storeCoins(amount)
            .endCell();
    /** Подтверждение с адреса настоящего нуллификатора листа `key`, несущее `value` монет. */
    const confirmFromNullifier = async (key: number, recipient: Address, amount: bigint, value: bigint) =>
        blockchain.sendMessage(
            internalFrom({
                from: await rollup.getNullifierAddress(key),
                to: rollup.address,
                value,
                bounce: false,
                body: claimedBody(BigInt(key), recipient, amount),
            }),
        );
    const withdrawBody = (leaf: { leafIndex: number; amount: bigint }, recipient: Address, proof: Cell) =>
        beginCell()
            .storeUint(RollupOpcodes.withdraw, 32)
            .storeUint(0, 64)
            .storeUint(leaf.leafIndex, 32)
            .storeAddress(recipient)
            .storeCoins(leaf.amount)
            .storeRef(proof)
            .endCell();

    beforeAll(async () => {
        code = await compile('RollupMock');
        nullifierCode = await compile('RollupNullifier');
        constants = await readProtocolConstants(code, nullifierCode);
    });

    afterAll(() => {
        saveGasReport(
            'rollup-payout-gas.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupPayout.spec.ts; не редактировать вручную',
                note: 'Газ шагов цепочки вывода на тестовом двойнике и запасы, заданные в контракте (пороги монет считаются из них по ценам сети)',
                budgets: {
                    WITHDRAW_STEP_GAS: budgets.withdrawStepGas,
                    NULLIFIER_CLAIM_GAS: budgets.nullifierClaimGas,
                    PAYOUT_STEP_GAS: budgets.payoutStepGas,
                },
            },
            gas,
            [
                'withdrawStep',
                'nullifierClaim',
                'payoutPaid',
                'payoutOwed',
                'payoutOwedDeep',
                'payOwed',
                'claimMessageCells',
                'claimMessageBits',
            ],
        );
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = START;
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        user = await blockchain.treasury('user');
    });

    describe('две заявки на последние монеты', () => {
        // Два вывода по 2 TON, а на контракте денег на один. Обе заявки уходят одной
        // транзакцией кошелька: обе проходят раннюю проверку баланса раньше, чем выплачена
        // первая, — та самая гонка, в которой раньше сгорала вторая заявка.
        const leaves = [0, 1].map((leafIndex) => ({
            leafIndex,
            recipientHash: hashOf(recipientOf(0xa0 + leafIndex)),
            amount: toNano('2'),
        }));
        const tree = withdrawalTree(leaves);
        const race = async () => {
            await deploy(toNano('3'));
            await submit(sha256Int(2n), tree.root);
            return user.sendMessages(
                leaves.map((leaf) =>
                    internal({
                        to: rollup.address,
                        value: toNano('0.2'),
                        body: withdrawBody(
                            leaf,
                            recipientOf(0xa0 + leaf.leafIndex),
                            merkleProofCell(tree.proofFor(leaf.leafIndex)),
                        ),
                    }),
                ),
            );
        };

        it('первая выплачена, вторая записана долгом; пометки стоят у обеих', async () => {
            const result = await race();
            // Обе заявки прошли шаг Withdraw и обе помечены в нуллификаторах.
            for (const leaf of leaves) {
                expect(await isDeployed(await rollup.getNullifierAddress(leaf.leafIndex))).toBe(true);
            }
            expect(await balanceOf(recipientOf(0xa0))).toBe(toNano('2'));
            expect(await balanceOf(recipientOf(0xa1))).toBe(0n);
            // Шаг выплаты второй заявки не упал: транзакция успешна, долг записан.
            const confirmations = result.transactions.filter(
                (tx) =>
                    tx.inMessage?.info.type === 'internal' &&
                    tx.inMessage.info.dest.equals(rollup.address) &&
                    tx.inMessage.body.beginParse().preloadUint(32) === RollupOpcodes.nullifierClaimed,
            );
            expect(confirmations).toHaveLength(2);
            for (const tx of confirmations) {
                expect(tx.description.type === 'generic' && tx.description.aborted).toBe(false);
            }
            expect(await owedBy(1n)).toEqual(debtTo(recipientOf(0xa1), toNano('2')));
            expect(await owedBy(0n)).toBeNull();
            const phases = confirmations.map((tx) =>
                tx.description.type === 'generic' && tx.description.computePhase.type === 'vm'
                    ? Number(tx.description.computePhase.gasUsed)
                    : 0,
            );
            [gas.payoutPaid, gas.payoutOwed] = phases;
            expect(Math.max(...phases)).toBeLessThan(budgets.payoutStepGas);
        });

        it('долг выплачивается, когда деньги появились: ровно один раз и только записанному получателю', async () => {
            await race();
            const pay = (key = 1n) => rollup.sendPayOwed(user.getSender(), { key, value: toNano('0.05') });

            // Денег всё ещё нет: отказ, запись на месте.
            expect((await pay()).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.insufficientFunds,
            });
            expect(await rollup.getOwedPayout(1n)).not.toBeNull();
            // По чужому ключу платить нечего.
            expect((await pay(0n)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.nothingOwed,
            });

            await owner.send({ to: rollup.address, value: toNano('3') });
            const paid = await pay();
            expect(paid.transactions).toHaveTransaction({
                from: rollup.address,
                to: recipientOf(0xa1),
                value: toNano('2'),
            });
            gas.payOwed = Number(computePhaseOf(paid.transactions, rollup.address).gasUsed);
            expect(await balanceOf(recipientOf(0xa1))).toBe(toNano('2'));
            expect(await rollup.getOwedPayout(1n)).toBeNull();

            expect((await pay()).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.nothingOwed,
            });
            expect(await balanceOf(recipientOf(0xa1))).toBe(toNano('2'));
        });

        it('повторный вывод по листу с долгом ничего не добавляет', async () => {
            await race();
            await owner.send({ to: rollup.address, value: toNano('5') });
            const again = await rollup.sendWithdraw(user.getSender(), {
                leafIndex: 1,
                recipient: recipientOf(0xa1),
                amount: toNano('2'),
                merkleProof: merkleProofCell(tree.proofFor(1)),
                value: toNano('0.2'),
            });
            expect(again.transactions).toHaveTransaction({
                to: await rollup.getNullifierAddress(1),
                success: false,
                exitCode: NullifierErrors.alreadyClaimed,
            });
            expect(await balanceOf(recipientOf(0xa1))).toBe(0n);
            expect(await owedBy(1n)).toEqual(debtTo(recipientOf(0xa1), toNano('2')));
        });
    });

    // Выхода по пруфу zkVM в протоколе v2 нет, и теста «аварийный выход при нехватке баланса
    // становится долгом» на двойнике больше нет: шаг выплаты (handleNullifierClaimed) у вывода и
    // у выхода счёта EVM общий и от вида ключа нуллификатора не зависит. Отказ выхода EVM при
    // нехватке денег до пометки — tests/RollupEvmExit.spec.ts.

    describe('пороги монет', () => {
        const leaf = { leafIndex: 0, recipientHash: hashOf(recipientOf(0xb0)), amount: toNano('0.3') };
        const tree = withdrawalTree([leaf]);
        const withdraw = (value: bigint) =>
            rollup.sendWithdraw(user.getSender(), {
                leafIndex: 0,
                recipient: recipientOf(0xb0),
                amount: leaf.amount,
                merkleProof: merkleProofCell(tree.proofFor(0)),
                value,
            });

        beforeEach(async () => {
            await deploy(toNano('5'));
            await submit(sha256Int(2n), tree.root);
        });

        it('минимума хватает на всю цепочку вывода, а нанотоной меньше — отказ до пометки', async () => {
            const { withdraw: minimum } = await rollup.getMinimumValues();
            // Порог считается из газа; при нынешних ценах это доли TON, а не прежние 0,1 TON.
            expect(minimum).toBeLessThan(toNano('0.1'));

            const tooLittle = await withdraw(minimum - 1n);
            expect(tooLittle.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notEnoughValue,
            });
            expect(await isDeployed(await rollup.getNullifierAddress(0))).toBe(false);

            const exact = await withdraw(minimum);
            expect(exact.transactions).toHaveTransaction({
                from: rollup.address,
                to: recipientOf(0xb0),
                value: leaf.amount,
            });
            expect(await balanceOf(recipientOf(0xb0))).toBe(leaf.amount);

            // Расход каждого шага укладывается в запас, из которого посчитан порог.
            const nullifier = await rollup.getNullifierAddress(0);
            gas.withdrawStep = Number(computePhaseOf(exact.transactions, rollup.address).gasUsed);
            gas.nullifierClaim = Number(computePhaseOf(exact.transactions, nullifier).gasUsed);
            expect(gas.withdrawStep).toBeLessThan(budgets.withdrawStepGas);
            expect(gas.nullifierClaim).toBeLessThan(budgets.nullifierClaimGas);

            // Заявка в нуллификатор (с его кодом и данными) не больше оценки, по которой
            // контракт считает плату за пересылку.
            const claimTx = exact.transactions.find(
                (tx) => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.dest.equals(nullifier),
            )!;
            const message = claimTx.inMessage!;
            const parts = [message.body, message.init?.code, message.init?.data].filter(
                (cell): cell is Cell => cell != null,
            );
            gas.claimMessageCells = parts.reduce((sum, cell) => sum + cellStats(cell).cells, 0);
            gas.claimMessageBits = parts.reduce((sum, cell) => sum + cellStats(cell).bits, 0);
            expect(gas.claimMessageCells).toBeLessThanOrEqual(CLAIM_MESSAGE_CELLS);
            expect(gas.claimMessageBits).toBeLessThanOrEqual(CLAIM_MESSAGE_BITS);
        });

        it('развёрнутый нуллификатор — ещё не погашенная заявка', async () => {
            // Нуллификатор может развернуть кто угодно: адрес известен, пустое сообщение он
            // принимает. Скрипты поэтому смотрят на флаг isClaimed, а не на то, развёрнут ли
            // контракт; а настоящему выводу чужое развёртывание не мешает.
            const address = await rollup.getNullifierAddress(0);
            const init = {
                code: nullifierCode,
                data: beginCell().storeAddress(rollup.address).storeUint(0, 256).storeBit(false).endCell(),
            };
            expect(contractAddress(0, init).equals(address)).toBe(true);
            await owner.send({ to: address, value: toNano('0.01'), init, bounce: false });
            expect(await isDeployed(address)).toBe(true);
            const nullifier = blockchain.openContract(RollupNullifier.createFromAddress(address));
            expect(await nullifier.getIsClaimed()).toBe(false);

            const { withdraw: minimum } = await rollup.getMinimumValues();
            const result = await withdraw(minimum);
            expect(result.transactions).toHaveTransaction({
                from: rollup.address,
                to: recipientOf(0xb0),
                value: leaf.amount,
            });
            expect(await nullifier.getIsClaimed()).toBe(true);
        });

        it('нуллификатор не помечает заявку, если монет не хватит довести цепочку до конца', async () => {
            // Нуллификатор, у которого «rollup» — обычный кошелёк: так ему можно прислать
            // заявку с любой суммой, минуя пороги настоящего rollup-контракта.
            const data = beginCell().storeAddress(user.address).storeUint(7, 256).storeBit(false).endCell();
            const init = { code: nullifierCode, data };
            const nullifier = contractAddress(0, init);
            const claim = beginCell()
                .storeUint(RollupOpcodes.nullifierClaim, 32)
                .storeUint(0, 64)
                .storeAddress(recipientOf(0xb1))
                .storeCoins(toNano('1'))
                .endCell();
            const isClaimed = async () => {
                const state = (await blockchain.getContract(nullifier)).accountState;
                if (state?.type !== 'active') return false;
                return (await blockchain.runGetMethod(nullifier, 'isClaimed')).stackReader.readBoolean();
            };

            // Развёртываем пустым сообщением, чтобы спросить у нуллификатора его порог.
            await user.send({ to: nullifier, value: toNano('0.01'), init, bounce: false });
            const minimum = await blockchain.openContract(RollupNullifier.createFromAddress(nullifier)).getMinimumValue();
            // Порог не меньше стоимости шага выплаты, которую считает rollup-контракт.
            expect(minimum).toBeGreaterThan(budgets.payoutStepValue);

            // На нанотону меньше порога: заявка возвращается, пометки нет.
            const below = await user.send({ to: nullifier, value: minimum - 1n, body: claim, bounce: true });
            expect(below.transactions).toHaveTransaction({
                to: nullifier,
                success: false,
                exitCode: NullifierErrors.notEnoughValue,
            });
            expect(await isClaimed()).toBe(false);

            // Ровно порог: пометка ставится, а до «rollup'а» доходит не меньше, чем стоит шаг
            // выплаты, — на этом держится обещание, что шаг выплаты исполнится.
            const exact = await user.send({ to: nullifier, value: minimum, body: claim, bounce: true });
            expect(exact.transactions).toHaveTransaction({ from: nullifier, to: user.address, success: true });
            expect(await isClaimed()).toBe(true);
            const confirmation = exact.transactions.find(
                (tx) => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.src.equals(nullifier),
            )!;
            const delivered = confirmation.inMessage!.info.type === 'internal' ? confirmation.inMessage!.info.value.coins : 0n;
            expect(delivered).toBeGreaterThanOrEqual(budgets.payoutStepValue);
            // Чужой отправитель пометить не может.
            const stranger = await owner.send({ to: nullifier, value: toNano('0.05'), body: claim, bounce: true });
            expect(stranger.transactions).toHaveTransaction({
                to: nullifier,
                success: false,
                exitCode: NullifierErrors.notRollup,
            });
        });
    });

    it('шагу выплаты хватает монет, которые гарантирует нуллификатор, даже для записи долга в глубокий словарь', async () => {
        // Худший случай шага выплаты: баланса нет, долг пишется в словарь, где уже много
        // записей (длинный путь в дереве словаря), а подтверждение несёт ровно столько монет,
        // сколько гарантирует порог нуллификатора. Если шаг не уложится в газ, заявка сгорит.
        await deploy(toNano('1'));
        (await blockchain.getContract(rollup.address)).balance = toNano('0.01');
        const recipient = recipientOf(0xd0);
        let worst = 0;
        for (let key = 0; key < 64; key++) {
            // Ключи с разными старшими и младшими битами — ветвление словаря на разных уровнях.
            const leaf = key < 32 ? 2 ** key - (key === 0 ? 0 : 1) : (key - 32) * 3 + 5;
            const result = await confirmFromNullifier(leaf, recipient, toNano('2'), budgets.payoutStepValue);
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            worst = Math.max(worst, Number(computePhaseOf(result.transactions, rollup.address).gasUsed));
            expect(await owedBy(BigInt(leaf))).toEqual(debtTo(recipient, toNano('2')));
        }
        gas.payoutOwedDeep = worst;
        expect(worst).toBeLessThan(budgets.payoutStepGas);
    });

    it('граница «платить или записать долг»: запас сверх суммы выплаты не тратится', async () => {
        // Шаг выплаты платит, только если на балансе остаётся запас (хранение, газ, пересылка).
        // Баланс на нанотону меньше границы — долг; ровно граница — выплата.
        await deploy(toNano('1'));
        const amount = toNano('2');
        const value = budgets.payoutStepValue;
        const setBalance = async (balance: bigint) => {
            (await blockchain.getContract(rollup.address)).balance = balance;
        };

        await setBalance(amount + budgets.payoutOverhead - value - 1n);
        const short = await confirmFromNullifier(11, recipientOf(0xd1), amount, value);
        expect(short.transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await balanceOf(recipientOf(0xd1))).toBe(0n);
        expect(await owedBy(11n)).toEqual(debtTo(recipientOf(0xd1), amount));

        await setBalance(amount + budgets.payoutOverhead - value);
        const enough = await confirmFromNullifier(12, recipientOf(0xd2), amount, value);
        expect(enough.transactions).toHaveTransaction({ from: rollup.address, to: recipientOf(0xd2), value: amount });
        expect(await owedBy(12n)).toBeNull();
    });

    it('ранняя проверка баланса не считает монеты самого сообщения', async () => {
        // На контракте денег на выплату нет, но к заявке приложено больше, чем сумма вывода.
        // Приложенные монеты уйдут дальше по цепочке и в выплате не участвуют: раньше
        // проверка их засчитывала и пропускала заявку, которую нечем оплатить.
        await deploy(toNano('0.3'));
        const big = { leafIndex: 0, recipientHash: hashOf(recipientOf(0xb2)), amount: toNano('3') };
        const bigTree = withdrawalTree([big]);
        await submit(sha256Int(2n), bigTree.root);
        expect(await balanceOf(rollup.address)).toBeLessThan(big.amount);
        const result = await rollup.sendWithdraw(user.getSender(), {
            leafIndex: 0,
            recipient: recipientOf(0xb2),
            amount: big.amount,
            merkleProof: merkleProofCell(bigTree.proofFor(0)),
            value: big.amount + toNano('1'),
        });
        expect(result.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.insufficientFunds,
        });
        expect(await isDeployed(await rollup.getNullifierAddress(0))).toBe(false);
    });

    it('возврат депозита при пустом контракте не теряет квитанцию', async () => {
        await deploy(toNano('0.3'));
        await rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') });
        blockchain.now = START + TIMEOUT + 1;
        await rollup.sendActivateEscapeHatch(user.getSender(), toNano('0.05'));
        // Деньги с контракта ушли (в жизни — на плату за хранение; здесь баланс просто обнулён).
        const contract = await blockchain.getContract(rollup.address);
        contract.balance = toNano('0.01');

        const cancel = () => rollup.sendCancelDeposit(user.getSender(), { depositIndex: 1, value: toNano('0.05') });
        expect((await cancel()).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.insufficientFunds,
        });
        const receipt = await rollup.getDepositReceipt(1);
        expect(receipt?.depositor.toString()).toBe(user.address.toString());
        expect(receipt?.amount).toBe(toNano('0.99'));

        await owner.send({ to: rollup.address, value: toNano('2') });
        expect((await cancel()).transactions).toHaveTransaction({
            from: rollup.address,
            to: user.address,
            value: toNano('0.99'),
        });
        expect(await rollup.getDepositReceipt(1)).toBeNull();
    });
});
