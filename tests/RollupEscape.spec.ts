import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { finalizeDummyKeys, mockProof, ProtocolConstants, readProtocolConstants, testConfig } from './helpers/rollupSetup';
import { Rollup, RollupErrors } from '../wrappers/Rollup';
import { forcedTransactionCell, merkleProofCell, sha256Int, withdrawalTree } from '../wrappers/rollupMath';
import { FORCE_TRANSACTION_VALUE } from '../wrappers/rollupValues';

// Аварийный режим на тестовом двойнике (contracts/rollup_mock.tolk), протокол v2: заморозка по
// возрасту самого старого необработанного элемента очереди L1, возврат необработанных
// депозитов. Выхода с баланса L2 по пруфу zkVM в v2 нет; выход счёта EVM по доказательству —
// tests/RollupEvmExit.spec.ts.
const CHAIN_ID = 4242n;
const TIMEOUT = 3600;
const DEPOSIT_FEE = toNano('0.01');
const START = 1_800_000_000;
const NO_HINTS = beginCell().endCell();
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;

describe('Rollup: аварийный режим на тестовом двойнике', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let constants: ProtocolConstants;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;

    /** Батч, обработавший очередь до элемента `upTo` (по умолчанию — до головы). */
    const submit = async (newStateRoot: bigint, upTo?: number, withdrawals: { root: bigint; count: bigint } = { root: 0n, count: 0n }) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof(),
            hints: NO_HINTS,
            roots: {
                newStateRoot,
                withdrawalsRoot: withdrawals.root,
                withdrawalsCount: withdrawals.count,
                queueProcessedUpTo: upTo === undefined ? (await rollup.getDepositQueue()).head.count : BigInt(upTo),
                blockTimestamp: BigInt(blockchain.now!),
            },
            value: toNano('0.2'),
        });
    const deposit = (from = user, value = toNano('1')) =>
        rollup.sendDeposit(from.getSender(), { l2Recipient: L2_RECIPIENT, value });
    const activate = () => rollup.sendActivateEscapeHatch(stranger.getSender(), toNano('0.05'));
    const cancel = (depositIndex: number, from = user) =>
        rollup.sendCancelDeposit(from.getSender(), { depositIndex, value: toNano('0.05') });
    const oldestPendingAt = async () => (await rollup.getEscapeState()).oldestPendingAt;
    const notDue = async () =>
        expect((await activate()).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.escapeNotDue,
        });
    const freezes = async () => {
        expect((await activate()).transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect((await rollup.getEscapeState()).frozen).toBe(true);
    };
    /** Депозит ждёт дольше срока — rollup замораживается. */
    const freeze = async () => {
        await deposit();
        blockchain.now = START + TIMEOUT + 1;
        await freezes();
    };

    beforeAll(async () => {
        code = await compile('RollupMock');
        nullifierCode = await compile('RollupNullifier');
        constants = await readProtocolConstants(code, nullifierCode);
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = START;
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        user = await blockchain.treasury('user');
        stranger = await blockchain.treasury('stranger');
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
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
        await finalizeDummyKeys(rollup, owner);
    });

    describe('заморозка', () => {
        it('без необработанных элементов заморозить нельзя, сколько бы ни прошло времени', async () => {
            expect(await rollup.getEscapeState()).toEqual({ frozen: false, oldestPendingAt: 0, timeout: TIMEOUT });
            blockchain.now = START + 100 * TIMEOUT;
            await notDue();
        });

        it('срок считается от самого старого необработанного элемента', async () => {
            await deposit();
            blockchain.now = START + 100;
            await deposit(); // второй депозит срок не сдвигает
            expect(await oldestPendingAt()).toBe(START);

            blockchain.now = START + TIMEOUT;
            await notDue();
            blockchain.now = START + TIMEOUT + 1;
            await freezes();
        });

        it('работающий секвенсор заморозку не вызывает: батч, обработавший очередь, обнуляет срок', async () => {
            await deposit();
            blockchain.now = START + 10;
            await submit(sha256Int(2n)); // ближайший же батч обрабатывает депозит
            expect(await oldestPendingAt()).toBe(0);

            blockchain.now = START + 100 * TIMEOUT;
            await notDue();
        });

        it('батч, не тронувший очередь, срок не сбрасывает', async () => {
            // Секвенсор выпускает батчи, но очередь не обрабатывает: это и есть цензура.
            await deposit();
            blockchain.now = START + 10;
            expect((await submit(sha256Int(2n), 0)).transactions).toHaveTransaction({ to: rollup.address, success: true });
            blockchain.now = START + 20;
            expect((await submit(sha256Int(3n), 0)).transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect((await rollup.getRollupState()).batchIndex).toBe(2);
            expect(await oldestPendingAt()).toBe(START);
            blockchain.now = START + TIMEOUT + 1;
            await freezes();
        });

        it('после частичной обработки срок идёт от первого из оставшихся', async () => {
            // Три элемента встали в разное время; батч обработал только первый. Самый старый
            // необработанный теперь — второй: срок считается от его постановки, не раньше и не позже.
            await deposit(); // 1 — START
            blockchain.now = START + 100;
            await rollup.sendForceTransaction(user.getSender(), {
                l2Transaction: forcedTransactionCell(Buffer.alloc(40, 7)),
                value: FORCE_TRANSACTION_VALUE,
            }); // 2 — START + 100
            blockchain.now = START + 200;
            await deposit(); // 3 — START + 200
            blockchain.now = START + 300;
            await submit(sha256Int(2n), 1);
            expect(await oldestPendingAt()).toBe(START + 100);

            // От первого элемента срок уже вышел бы — но он обработан.
            blockchain.now = START + TIMEOUT + 1;
            await notDue();
            blockchain.now = START + 100 + TIMEOUT;
            await notDue();
            blockchain.now = START + 100 + TIMEOUT + 1;
            await freezes();
        });

        it('возраст самого старого необработанного элемента — на всех переходах очереди', async () => {
            expect(await oldestPendingAt()).toBe(0); // очередь пуста
            blockchain.now = START + 5;
            await deposit(); // 1
            expect(await oldestPendingAt()).toBe(START + 5);
            blockchain.now = START + 6;
            await deposit(); // 2
            blockchain.now = START + 7;
            await deposit(); // 3
            expect(await oldestPendingAt()).toBe(START + 5);
            await submit(sha256Int(2n), 2); // обработаны 1 и 2
            expect(await oldestPendingAt()).toBe(START + 7);
            await submit(sha256Int(3n), 2); // пустой отрезок: ничего не меняется
            expect(await oldestPendingAt()).toBe(START + 7);
            await submit(sha256Int(4n), 3); // очередь обработана целиком
            expect(await oldestPendingAt()).toBe(0);
            blockchain.now = START + 50;
            await deposit(); // 4: срок начинается заново, с него
            expect(await oldestPendingAt()).toBe(START + 50);
        });

        it('депозит после долгого простоя не даёт заморозить сразу', async () => {
            // Rollup месяц без активности — это не отказ секвенсора. Срок начинается с депозита.
            blockchain.now = START + 30 * 24 * 3600;
            await deposit();
            await notDue();
        });

        it('после заморозки батчи, данные и депозиты не принимаются', async () => {
            await freeze();
            expect((await submit(sha256Int(2n))).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupFrozen,
            });
            const publish = await rollup.sendPublishData(sequencer.getSender(), {
                batchIndex: 1,
                data: beginCell().storeUint(1, 8).endCell(),
                value: toNano('0.05'),
            });
            expect(publish.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupFrozen,
            });
            const late = await deposit(stranger);
            expect(late.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupFrozen,
            });
            expect(late.transactions).toHaveTransaction({
                from: rollup.address,
                to: stranger.address,
                inMessageBounced: true,
            });
            // Повторная заморозка ничего не меняет.
            expect((await activate()).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupFrozen,
            });
        });
    });

    describe('возврат необработанных депозитов', () => {
        it('до заморозки депозит вернуть нельзя', async () => {
            await deposit();
            expect((await cancel(1)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupNotFrozen,
            });
        });

        it('после заморозки депозит возвращается вносителю, кто бы ни попросил, и только один раз', async () => {
            await freeze();
            const amount = toNano('1') - DEPOSIT_FEE;
            const receipt = await rollup.getDepositReceipt(1);
            expect(receipt?.depositor.equals(user.address)).toBe(true);
            expect(receipt?.amount).toBe(amount);

            const refund = await cancel(1, stranger);
            expect(refund.transactions).toHaveTransaction({ from: rollup.address, to: user.address, value: amount });
            expect(await rollup.getDepositReceipt(1)).toBeNull();
            expect(await rollup.getQueueItem(1)).toBeNull();

            const again = await cancel(1);
            expect(again.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.noSuchDeposit,
            });
            expect(again.transactions).not.toHaveTransaction({ from: rollup.address, to: user.address, value: amount });
        });

        it('после частичной обработки возвращаются только депозиты за отметкой processed', async () => {
            await deposit(); // 1
            await deposit(stranger); // 2
            await deposit(); // 3
            blockchain.now = START + 10;
            await submit(sha256Int(2n), 2); // обработаны 1 и 2; депозит 3 ждёт
            blockchain.now = START + TIMEOUT + 1;
            await freezes();

            // Обработанные уже зачислены на L2: и первый, и тот, что стоит ровно на отметке.
            for (const index of [1, 2]) {
                expect((await cancel(index)).transactions).toHaveTransaction({
                    to: rollup.address,
                    success: false,
                    exitCode: RollupErrors.depositAlreadyProcessed,
                });
                expect(await rollup.getDepositReceipt(index)).not.toBeNull();
            }
            const pending = await cancel(3, stranger);
            expect(pending.transactions).toHaveTransaction({
                from: rollup.address,
                to: user.address,
                value: toNano('1') - DEPOSIT_FEE,
            });
            // Номера, которого в очереди не было, тоже не вернуть.
            expect((await cancel(4)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.noSuchDeposit,
            });
        });

        it('обработанный депозит вернуть нельзя: он уже на L2', async () => {
            await deposit(); // депозит 1
            blockchain.now = START + 10;
            await submit(sha256Int(2n)); // депозит 1 обработан
            blockchain.now = START + 30;
            await deposit(stranger); // депозит 2 — так и не обработан
            blockchain.now = START + 30 + TIMEOUT + 1;
            await freezes();

            expect((await cancel(1)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.depositAlreadyProcessed,
            });
            expect((await cancel(2)).transactions).toHaveTransaction({
                from: rollup.address,
                to: stranger.address,
                value: toNano('1') - DEPOSIT_FEE,
            });
        });

        it('уборка после заморозки не мешает возврату: записи необработанных депозитов остаются', async () => {
            await deposit();
            await deposit();
            blockchain.now = START + 10;
            await submit(sha256Int(2n)); // депозиты 1 и 2 обработаны
            await deposit(); // депозит 3 ждёт
            blockchain.now = START + 10 + TIMEOUT + 1;
            await freezes();
            const prune = await rollup.sendPruneDepositReceipts(stranger.getSender(), {
                count: 10,
                value: toNano('0.05'),
            });
            expect(prune.transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await rollup.getDepositReceipt(1)).toBeNull();
            expect(await rollup.getDepositReceipt(2)).toBeNull();
            expect(await rollup.getDepositReceipt(3)).not.toBeNull();
            expect((await cancel(3)).transactions).toHaveTransaction({
                from: rollup.address,
                to: user.address,
                value: toNano('1') - DEPOSIT_FEE,
            });
        });
    });

    describe('выводы после заморозки', () => {
        it('обычный вывод по принятому батчу работает и после заморозки', async () => {
            const leaf = {
                leafIndex: 0,
                recipientHash: BigInt('0x' + Buffer.alloc(32, 0xa1).toString('hex')),
                amount: toNano('0.2'),
            };
            const tree = withdrawalTree([leaf]);
            await deposit();
            blockchain.now = START + 10;
            await submit(sha256Int(2n), 0, { root: tree.root, count: 1n });
            blockchain.now = START + TIMEOUT + 1;
            await freezes();

            const withdrawRecipient = new Address(0, Buffer.alloc(32, 0xa1));
            const withdraw = await rollup.sendWithdraw(user.getSender(), {
                leafIndex: 0,
                recipient: withdrawRecipient,
                amount: leaf.amount,
                merkleProof: merkleProofCell(tree.proofFor(0)),
                value: toNano('0.2'),
            });
            expect(withdraw.transactions).toHaveTransaction({
                from: rollup.address,
                to: withdrawRecipient,
                value: leaf.amount,
            });
        });
    });
});
