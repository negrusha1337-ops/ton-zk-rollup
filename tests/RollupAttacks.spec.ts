import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';
import { ExitClaim, Rollup, RollupErrors } from '../wrappers/Rollup';
import {
    batchDigest,
    forcedTransactionCell,
    forcedTransactionHash,
    merkleProofCell,
    sha256Int,
    withdrawalTree,
} from '../wrappers/rollupMath';
import { FORCE_TRANSACTION_VALUE } from '../wrappers/rollupValues';
import { finalizeDummyKeys } from './helpers/rollupSetup';

// Регрессионные тесты на атаки из независимого разбора протокола (REVIEW.md). Каждый
// тест воспроизводит ход атакующего на тестовом двойнике (contracts/rollup_mock.tolk) и
// проверяет, что контракт его больше не допускает. Атаки на программы zkVM покрыты
// тестами на Rust (zkvm/lib/src/tests.rs, zkvm/exit-lib/src/lib.rs).
const GENESIS_ROOT = sha256Int(1n);
const CHAIN_ID = 4242n;
const TIMEOUT = 3600;
const START = 1_800_000_000;
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

describe('Rollup: атаки из независимого разбора', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;

    const submit = (newStateRoot: bigint, withdrawalsRoot = 0n) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof,
            hints: NO_HINTS,
            roots: { newStateRoot, withdrawalsRoot },
            value: toNano('0.2'),
        });
    const deploy = async (value = toNano('5')) => {
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
        await rollup.sendDeploy(owner.getSender(), value);
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
    });

    it('прежний корень выводов входит в публичный вход: приписать лист в дерево нельзя', async () => {
        // Атака: секвенсор строит батч от «прежних выводов», в которые вписал лист в свою
        // пользу. Прежний корень теперь — часть доказываемого утверждения, и контракт
        // подставляет его из хранилища, а не из сообщения.
        await deploy();
        await finalizeDummyKeys(rollup, owner);
        const honestRoot = withdrawalTree([{ leafIndex: 0, recipientHash: 7n, amount: toNano('0.1') }]).root;
        await submit(sha256Int(2n), honestRoot);

        const next = { newStateRoot: sha256Int(3n), withdrawalsRoot: sha256Int(99n) };
        const common = {
            chainId: CHAIN_ID,
            prevStateRoot: sha256Int(2n),
            ...next,
            batchHash: 0n,
            prevDepositHash: 0n,
            newDepositHash: 0n,
        };
        const required = await rollup.getExpectedPublicInput(next);
        expect(required).toBe(batchDigest({ ...common, prevWithdrawalsRoot: honestRoot }));
        // Пруф, построенный от любого другого прежнего дерева, даёт другой публичный вход.
        const forgedPrior = withdrawalTree([
            { leafIndex: 0, recipientHash: 7n, amount: toNano('0.1') },
            { leafIndex: 1, recipientHash: 0x66n, amount: toNano('1000') },
        ]).root;
        expect(required).not.toBe(batchDigest({ ...common, prevWithdrawalsRoot: forgedPrior }));
        expect(required).not.toBe(batchDigest({ ...common, prevWithdrawalsRoot: 0n }));
    });

    it('принудительная транзакция в виде ссылки на библиотеку не ломает очередь', async () => {
        // Атака: в очередь шлют экзотическую ячейку — ссылку на библиотеку. При чтении TVM
        // подставляет содержимое библиотеки, проверка формы проходит, а хеш самой ссылки
        // программа zkVM из байтов не воспроизведёт. Контракт обязан класть в очередь хеш
        // обычной ячейки с теми же битами.
        await deploy();
        await finalizeDummyKeys(rollup, owner);
        const content = forcedTransactionCell(Buffer.alloc(110, 0xa1));
        const libraries = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        libraries.set(BigInt('0x' + content.hash().toString('hex')), content);
        blockchain.libs = beginCell().storeDictDirect(libraries).endCell();
        const libraryReference = beginCell().storeUint(2, 8).storeBuffer(content.hash()).endCell({ exotic: true });
        expect(libraryReference.hash().equals(content.hash())).toBe(false);

        const result = await rollup.sendForceTransaction(user.getSender(), {
            l2Transaction: libraryReference,
            value: FORCE_TRANSACTION_VALUE,
        });
        // Sandbox подтверждает посылку атаки: TVM подставляет содержимое библиотеки, и
        // транзакция принимается. В очереди при этом обязан лежать хеш, который программа
        // посчитает из байтов транзакции, а не хеш ячейки-ссылки.
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        const queue = await rollup.getDepositQueue();
        expect(queue.head.count).toBe(1n);
        expect(queue.head.hash).toBe(forcedTransactionHash(0n, content));
        expect(queue.head.hash).not.toBe(forcedTransactionHash(0n, libraryReference));
    });

    it('до фиксации ключей rollup не принимает ни депозиты, ни принудительные транзакции', async () => {
        // Атака владельца: дождаться депозитов и зафиксировать ключ своей программы.
        await deploy();
        const deposit = await rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') });
        expect(deposit.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.keyNotFinalized,
        });
        expect(deposit.transactions).toHaveTransaction({
            from: rollup.address,
            to: user.address,
            inMessageBounced: true,
        });
        const forced = await rollup.sendForceTransaction(user.getSender(), {
            l2Transaction: forcedTransactionCell(Buffer.alloc(110, 1)),
            value: FORCE_TRANSACTION_VALUE,
        });
        expect(forced.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.keyNotFinalized,
        });
        expect((await rollup.getDepositQueue()).head.count).toBe(0n);

        await finalizeDummyKeys(rollup, owner);
        const after = await rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') });
        expect(after.transactions).toHaveTransaction({ to: rollup.address, success: true });
    });

    it('вывод не помечается использованным, если контракту нечем платить', async () => {
        // Нуллификатор ставит пометку до выплаты, и снять её нельзя. Если бы заявка ушла при
        // пустом контракте, вывод был бы потерян навсегда. Теперь без денег заявка не уходит.
        await deploy(toNano('0.2'));
        await finalizeDummyKeys(rollup, owner);
        const leaf = { leafIndex: 0, recipientHash: BigInt('0x' + 'a1'.repeat(32)), amount: toNano('3') };
        const tree = withdrawalTree([leaf]);
        await submit(sha256Int(2n), tree.root);
        const recipient = new Address(0, Buffer.alloc(32, 0xa1));
        const withdraw = () =>
            rollup.sendWithdraw(user.getSender(), {
                leafIndex: 0,
                recipient,
                amount: leaf.amount,
                merkleProof: merkleProofCell(tree.proofFor(0)),
                value: toNano('0.2'),
            });

        const early = await withdraw();
        expect(early.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.insufficientFunds,
        });
        const nullifier = await rollup.getNullifierAddress(0);
        // Нуллификатор не развёрнут — значит, пометка не поставлена.
        expect((await blockchain.getContract(nullifier)).accountState?.type ?? 'uninit').toBe('uninit');

        // Контракт пополнили — тот же вывод проходит: пометка не была потрачена впустую.
        await owner.send({ to: rollup.address, value: toNano('5') });
        const later = await withdraw();
        expect(later.transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: leaf.amount });
    });

    it('аварийный выход не помечается использованным, если контракту нечем платить', async () => {
        await deploy(toNano('0.2'));
        await finalizeDummyKeys(rollup, owner);
        await rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('0.1') });
        blockchain.now = START + TIMEOUT + 1;
        await rollup.sendActivateEscapeHatch(user.getSender(), toNano('0.05'));
        const claim: ExitClaim = {
            l2Account: L2_RECIPIENT,
            amount: toNano('50'),
            recipient: new Address(0, Buffer.alloc(32, 0xe1)),
        };
        const exit = await rollup.sendForceExit(user.getSender(), {
            proof: mockProof,
            hints: NO_HINTS,
            claim,
            value: toNano('0.3'),
        });
        expect(exit.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.insufficientFunds,
        });
        const nullifier = await rollup.getExitNullifierAddress(claim.l2Account);
        // Нуллификатор не развёрнут — значит, пометка не поставлена.
        expect((await blockchain.getContract(nullifier)).accountState?.type ?? 'uninit').toBe('uninit');
    });

    it('квитанции обработанных депозитов убираются сами, по одной на новый депозит', async () => {
        // Иначе словарь квитанций рос бы без предела и мог упереться в лимит хранилища.
        await deploy();
        await finalizeDummyKeys(rollup, owner);
        const deposit = () => rollup.sendDeposit(user.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') });
        await deposit(); // 1
        await deposit(); // 2
        await submit(sha256Int(2n));
        await submit(sha256Int(3n)); // депозиты 1 и 2 обработаны
        expect(await rollup.getDepositReceipt(1)).not.toBeNull();

        await deposit(); // 3: убирает квитанцию 1
        expect(await rollup.getDepositReceipt(1)).toBeNull();
        expect(await rollup.getDepositReceipt(2)).not.toBeNull();
        await deposit(); // 4: убирает квитанцию 2
        expect(await rollup.getDepositReceipt(2)).toBeNull();
        // Необработанные квитанции уборка не трогает: по ним возвращают депозиты.
        await deposit(); // 5
        expect(await rollup.getDepositReceipt(3)).not.toBeNull();
        expect(await rollup.getDepositReceipt(4)).not.toBeNull();
        expect(await rollup.getDepositReceipt(5)).not.toBeNull();
    });
});
