import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { finalizeDummyKeys } from './helpers/rollupSetup';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';
import { Rollup, RollupErrors } from '../wrappers/Rollup';
import { depositHash, forcedTransactionCell, forcedTransactionHash, sha256Int } from '../wrappers/rollupMath';
import { FORCE_TRANSACTION_VALUE } from '../wrappers/rollupValues';
import { computePhaseOf } from './helpers/gas';

// Принудительные транзакции L2 на тестовом двойнике (contracts/rollup_mock.tolk):
// постановка в очередь L1, форма ячейки, плата и связь с аварийным выходом. Исполнение
// самой транзакции — дело программы zkVM (zkvm/lib, тесты на Rust) и сквозных тестов с
// настоящими пруфами (tests/RollupZkvmProof.spec.ts).
const GENESIS_ROOT = sha256Int(1n);
const CHAIN_ID = 4242n;
const TIMEOUT = 3600;
const START = 1_800_000_000;
const DEPOSIT_FEE = toNano('0.01');
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;
const mockProof: Bn254Proof = {
    a: [1n, 0n],
    b: [
        [0n, 0n],
        [0n, 0n],
    ],
    c: [0n, 0n],
};
const NO_HINTS = beginCell().endCell();
/** Байты «транзакции»: контракт их не разбирает, важна только форма ячейки. */
const transactionBytes = (fill: number, length = 110) => Buffer.alloc(length, fill);

describe('Rollup: принудительные транзакции L2 на тестовом двойнике', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;

    const force = (l2Transaction: Cell, value = FORCE_TRANSACTION_VALUE) =>
        rollup.sendForceTransaction(user.getSender(), { l2Transaction, value });
    const submit = (newStateRoot: bigint) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof,
            hints: NO_HINTS,
            roots: { newStateRoot, withdrawalsRoot: 0n },
            value: toNano('0.2'),
        });

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
        await finalizeDummyKeys(rollup, owner);
    });

    it('ставит транзакцию в общую очередь с депозитами, в порядке прихода', async () => {
        const first = forcedTransactionCell(transactionBytes(0xa1));
        const second = forcedTransactionCell(transactionBytes(0xa2, 122));
        const result = await force(first);
        expect(result.transactions).toHaveTransaction({ from: user.address, to: rollup.address, success: true });
        await rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') });
        await force(second);

        const afterFirst = forcedTransactionHash(0n, first);
        const afterDeposit = depositHash(afterFirst, L2_RECIPIENT, toNano('1') - DEPOSIT_FEE);
        const queue = await rollup.getDepositQueue();
        expect(queue.head).toEqual({ count: 3n, hash: forcedTransactionHash(afterDeposit, second) });
        // Порядок — часть обязательства: те же элементы в другом порядке дают другой хеш.
        expect(queue.head.hash).not.toBe(forcedTransactionHash(depositHash(afterFirst, L2_RECIPIENT, 1n), second));
        // Квитанция есть только у депозита: принудительной транзакции возвращать нечего.
        expect(await rollup.getDepositReceipt(1)).toBeNull();
        expect(await rollup.getDepositReceipt(2)).not.toBeNull();
        expect(await rollup.getDepositReceipt(3)).toBeNull();
    });

    it('принудительную транзакцию нельзя спутать с депозитом', async () => {
        // Депозит с тем же «содержимым» дал бы другой хеш очереди: у транзакции на месте
        // получателя стоит метка, которой не может быть у 160-битного адреса.
        const cell = forcedTransactionCell(transactionBytes(0xa1));
        await force(cell);
        const asForced = (await rollup.getDepositQueue()).head.hash;
        const cellHash = BigInt('0x' + cell.hash().toString('hex'));
        expect(asForced).not.toBe(depositHash(0n, L2_RECIPIENT, cellHash));
        expect(asForced).toBe(forcedTransactionHash(0n, cell));
    });

    it('секвенсор обязан обработать её наравне с депозитом', async () => {
        const cell = forcedTransactionCell(transactionBytes(0xa1));
        await force(cell);
        const queued = forcedTransactionHash(0n, cell);
        await submit(sha256Int(2n)); // батч 1: транзакция становится целью
        expect((await rollup.getDepositQueue()).target).toEqual({ count: 1n, hash: queued });
        await submit(sha256Int(3n)); // батч 2: обязан включить её хеш в публичный вход
        expect((await rollup.getDepositQueue()).processed).toEqual({ count: 1n, hash: queued });
    });

    it('принимает только одну ячейку без ссылок с целым числом байт', async () => {
        const withRef = beginCell().storeBuffer(transactionBytes(1, 10)).storeRef(beginCell().endCell()).endCell();
        const notByteAligned = beginCell().storeUint(1, 7).endCell();
        const tooLong = beginCell().storeBuffer(transactionBytes(1, 127)).storeUint(0, 7).endCell();
        for (const malformed of [withRef, notByteAligned, tooLong]) {
            expect((await force(malformed)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.malformedForcedTransaction,
            });
        }
        expect((await rollup.getDepositQueue()).head.count).toBe(0n);

        // Предельный размер и пустая ячейка формально допустимы: программа их просто пропустит.
        for (const allowed of [forcedTransactionCell(transactionBytes(1, 127)), beginCell().endCell()]) {
            expect((await force(allowed)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        expect((await rollup.getDepositQueue()).head.count).toBe(2n);
    });

    it('берёт плату и не принимает транзакцию без неё', async () => {
        const cheap = await force(forcedTransactionCell(transactionBytes(1)), toNano('0.04'));
        expect(cheap.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.notEnoughValue,
        });
        expect((await rollup.getDepositQueue()).head.count).toBe(0n);
    });

    it('газ постановки в очередь невелик', async () => {
        const result = await force(forcedTransactionCell(transactionBytes(1, 122)));
        const gasUsed = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect(gasUsed).toBeLessThan(10_000);
    });

    it('цензура ведёт к заморозке: необработанная транзакция запускает срок', async () => {
        // Секвенсор жив и выпускает батчи, но транзакцию пользователя не берёт. Пользователь
        // ставит её в очередь сам — и дальше секвенсор либо обработает очередь, либо rollup
        // заморозят.
        await force(forcedTransactionCell(transactionBytes(0xa1)));
        expect((await rollup.getEscapeState()).oldestPendingAt).toBe(START);
        blockchain.now = START + 10;
        await submit(sha256Int(2n)); // батч 1 фиксирует транзакцию как цель и на этом секвенсор встаёт

        blockchain.now = START + TIMEOUT;
        expect((await rollup.sendActivateEscapeHatch(user.getSender(), toNano('0.05'))).transactions).toHaveTransaction(
            { to: rollup.address, success: false, exitCode: RollupErrors.escapeNotDue },
        );
        blockchain.now = START + TIMEOUT + 1;
        expect((await rollup.sendActivateEscapeHatch(user.getSender(), toNano('0.05'))).transactions).toHaveTransaction(
            { to: rollup.address, success: true },
        );
        expect((await rollup.getEscapeState()).frozen).toBe(true);
    });

    it('после заморозки в очередь ничего не ставится, а «возврата» у транзакции нет', async () => {
        await force(forcedTransactionCell(transactionBytes(0xa1)));
        blockchain.now = START + TIMEOUT + 1;
        await rollup.sendActivateEscapeHatch(user.getSender(), toNano('0.05'));

        expect((await force(forcedTransactionCell(transactionBytes(0xa2)))).transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.rollupFrozen,
        });
        const refund = await rollup.sendCancelDeposit(user.getSender(), { depositIndex: 1, value: toNano('0.05') });
        expect(refund.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.noSuchDeposit,
        });
    });
});
