import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';
import { ExitClaim, NullifierErrors, Rollup, RollupErrors } from '../wrappers/Rollup';
import { merkleProofCell, sha256Int, withdrawalTree } from '../wrappers/rollupMath';

// Аварийный выход на тестовом двойнике (contracts/rollup_mock.tolk): проверка пруфа
// заменена заглушкой «первое число пруфа равно 1». Настоящий пруф выхода —
// в tests/RollupZkvmProof.spec.ts.
const GENESIS_ROOT = sha256Int(1n);
const CHAIN_ID = 4242n;
const TIMEOUT = 3600;
const DEPOSIT_FEE = toNano('0.01');
const START = 1_800_000_000;
const mockProof = (valid: boolean): Bn254Proof => ({
    a: [valid ? 1n : 2n, 0n],
    b: [
        [0n, 0n],
        [0n, 0n],
    ],
    c: [0n, 0n],
});
const NO_HINTS = beginCell().endCell();
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;

describe('Rollup: аварийный выход на тестовом двойнике', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;

    const submit = (newStateRoot: bigint, withdrawalsRoot = 0n) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof(true),
            hints: NO_HINTS,
            roots: { newStateRoot, withdrawalsRoot },
            value: toNano('0.2'),
        });
    const deposit = (from = user, value = toNano('1')) =>
        rollup.sendDeposit(from.getSender(), { l2Recipient: L2_RECIPIENT, value });
    const activate = () => rollup.sendActivateEscapeHatch(stranger.getSender(), toNano('0.05'));
    const forceExit = (claim: ExitClaim, valid = true, value = toNano('0.3')) =>
        rollup.sendForceExit(stranger.getSender(), { proof: mockProof(valid), hints: NO_HINTS, claim, value });
    /** Депозит ждёт дольше срока — rollup замораживается. */
    const freeze = async () => {
        await deposit();
        blockchain.now = START + TIMEOUT + 1;
        const result = await activate();
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect((await rollup.getEscapeState()).frozen).toBe(true);
    };

    beforeAll(async () => {
        code = await compile('RollupMock');
        nullifierCode = await compile('RollupNullifier');
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
                {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode,
                    genesisStateRoot: GENESIS_ROOT,
                    chainId: CHAIN_ID,
                    escapeTimeout: TIMEOUT,
                },
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('5'));
    });

    describe('заморозка', () => {
        it('без необработанных депозитов заморозить нельзя, сколько бы ни прошло времени', async () => {
            expect(await rollup.getEscapeState()).toEqual({ frozen: false, oldestPendingAt: 0, timeout: TIMEOUT });
            blockchain.now = START + 100 * TIMEOUT;
            const result = await activate();
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.escapeNotDue,
            });
        });

        it('срок считается от самого старого необработанного депозита', async () => {
            await deposit();
            blockchain.now = START + 100;
            await deposit(); // второй депозит срок не сдвигает
            expect((await rollup.getEscapeState()).oldestPendingAt).toBe(START);

            blockchain.now = START + TIMEOUT;
            expect((await activate()).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.escapeNotDue,
            });
            blockchain.now = START + TIMEOUT + 1;
            expect((await activate()).transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect((await rollup.getEscapeState()).frozen).toBe(true);
        });

        it('работающий секвенсор заморозку не вызывает: батчи обнуляют срок', async () => {
            await deposit();
            // Батч 1 фиксирует депозит как цель, батч 2 его обрабатывает.
            blockchain.now = START + 10;
            await submit(sha256Int(2n));
            expect((await rollup.getEscapeState()).oldestPendingAt).toBe(START);
            blockchain.now = START + 20;
            await submit(sha256Int(3n));
            expect((await rollup.getEscapeState()).oldestPendingAt).toBe(0);

            blockchain.now = START + 100 * TIMEOUT;
            expect((await activate()).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.escapeNotDue,
            });
        });

        it('депозит после долгого простоя не даёт заморозить сразу', async () => {
            // Rollup месяц без активности — это не отказ секвенсора. Срок начинается с депозита.
            blockchain.now = START + 30 * 24 * 3600;
            await deposit();
            expect((await activate()).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.escapeNotDue,
            });
        });

        it('если секвенсор взял депозит в цель и пропал, срок идёт от этого депозита', async () => {
            await deposit();
            blockchain.now = START + 10;
            await submit(sha256Int(2n)); // депозит стал обязательным для батча 2, но батча 2 нет
            blockchain.now = START + 20;
            await deposit(); // ещё один, уже за целью
            expect((await rollup.getEscapeState()).oldestPendingAt).toBe(START);
            blockchain.now = START + TIMEOUT + 1;
            expect((await activate()).transactions).toHaveTransaction({ to: rollup.address, success: true });
        });

        it('после заморозки батчи, данные и депозиты не принимаются; депозит возвращается', async () => {
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
            const result = await rollup.sendCancelDeposit(user.getSender(), { depositIndex: 1, value: toNano('0.05') });
            expect(result.transactions).toHaveTransaction({
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

            const refund = await rollup.sendCancelDeposit(stranger.getSender(), {
                depositIndex: 1,
                value: toNano('0.05'),
            });
            expect(refund.transactions).toHaveTransaction({ from: rollup.address, to: user.address, value: amount });
            expect(await rollup.getDepositReceipt(1)).toBeNull();

            const again = await rollup.sendCancelDeposit(user.getSender(), { depositIndex: 1, value: toNano('0.05') });
            expect(again.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.noSuchDeposit,
            });
            expect(again.transactions).not.toHaveTransaction({ from: rollup.address, to: user.address, value: amount });
        });

        it('обработанный депозит вернуть нельзя: он уже на L2', async () => {
            await deposit(); // депозит 1
            blockchain.now = START + 10;
            await submit(sha256Int(2n));
            blockchain.now = START + 20;
            await submit(sha256Int(3n)); // депозит 1 обработан
            blockchain.now = START + 30;
            await deposit(stranger); // депозит 2 — так и не обработан
            blockchain.now = START + 30 + TIMEOUT + 1;
            await activate();

            const processed = await rollup.sendCancelDeposit(user.getSender(), {
                depositIndex: 1,
                value: toNano('0.05'),
            });
            expect(processed.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.depositAlreadyProcessed,
            });
            const pending = await rollup.sendCancelDeposit(user.getSender(), {
                depositIndex: 2,
                value: toNano('0.05'),
            });
            expect(pending.transactions).toHaveTransaction({
                from: rollup.address,
                to: stranger.address,
                value: toNano('1') - DEPOSIT_FEE,
            });
        });

        it('квитанции обработанных депозитов убираются, необработанных — нет', async () => {
            await deposit();
            await deposit();
            blockchain.now = START + 10;
            await submit(sha256Int(2n));
            blockchain.now = START + 20;
            await submit(sha256Int(3n)); // депозиты 1 и 2 обработаны
            await deposit(); // депозит 3 ждёт
            const prune = await rollup.sendPruneDepositReceipts(stranger.getSender(), {
                count: 10,
                value: toNano('0.05'),
            });
            expect(prune.transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await rollup.getDepositReceipt(1)).toBeNull();
            expect(await rollup.getDepositReceipt(2)).toBeNull();
            expect(await rollup.getDepositReceipt(3)).not.toBeNull();
        });
    });

    describe('выход с баланса L2', () => {
        const recipient = new Address(0, Buffer.alloc(32, 0xe1));
        const claim: ExitClaim = { l2Account: L2_RECIPIENT, amount: toNano('0.4'), recipient };

        it('до заморозки выйти нельзя', async () => {
            await deposit();
            expect((await forceExit(claim)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupNotFrozen,
            });
        });

        it('выплачивает баланс получателю из заявки и только один раз на счёт', async () => {
            await freeze();
            const first = await forceExit(claim);
            expect(first.transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: claim.amount });
            expect((await blockchain.getContract(recipient)).balance).toBe(claim.amount);

            // Повтор — даже с другой суммой и другим получателем: счёт уже вышел.
            const other = new Address(0, Buffer.alloc(32, 0xe2));
            const again = await forceExit({ ...claim, amount: toNano('0.1'), recipient: other });
            expect(again.transactions).toHaveTransaction({
                to: await rollup.getExitNullifierAddress(claim.l2Account),
                success: false,
                exitCode: NullifierErrors.alreadyClaimed,
            });
            expect(again.transactions).not.toHaveTransaction({ from: rollup.address, to: other });
            expect((await blockchain.getContract(recipient)).balance).toBe(claim.amount);
        });

        it('неверный пруф, нулевая сумма и нехватка монет отклоняются', async () => {
            await freeze();
            expect((await forceExit(claim, false)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.wrongProof,
            });
            expect((await forceExit({ ...claim, amount: 0n })).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.nothingToExit,
            });
            expect((await forceExit(claim, true, toNano('0.1'))).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notEnoughValue,
            });
            expect((await blockchain.getContract(recipient)).balance).toBe(0n);
        });

        it('публичный вход выхода привязан к счёту, сумме, получателю и состоянию', async () => {
            const base = await rollup.getExpectedExitInput(claim);
            expect(await rollup.getExpectedExitInput({ ...claim, amount: claim.amount + 1n })).not.toBe(base);
            expect(await rollup.getExpectedExitInput({ ...claim, l2Account: claim.l2Account + 1n })).not.toBe(base);
            expect(
                await rollup.getExpectedExitInput({ ...claim, recipient: new Address(0, Buffer.alloc(32, 0xe2)) }),
            ).not.toBe(base);
            await submit(sha256Int(2n));
            expect(await rollup.getExpectedExitInput(claim)).not.toBe(base);
        });

        it('обычный вывод по принятому батчу работает и после заморозки, выход ему не мешает', async () => {
            const leaf = {
                leafIndex: 0,
                recipientHash: BigInt('0x' + Buffer.alloc(32, 0xa1).toString('hex')),
                amount: toNano('0.2'),
            };
            const tree = withdrawalTree([leaf]);
            await deposit();
            blockchain.now = START + 10;
            await submit(sha256Int(2n), tree.root);
            blockchain.now = START + 10 + TIMEOUT + 1;
            await activate();

            // Номер листа 0 и счёт L2 гасятся разными нуллификаторами.
            await forceExit(claim);
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
