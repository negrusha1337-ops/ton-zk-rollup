import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { computePhaseOf } from './helpers/gas';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';
import { NullifierErrors, Rollup, RollupErrors, RollupOpcodes } from '../wrappers/Rollup';
import { ESCAPE_TIMEOUT_SECONDS } from '../wrappers/rollupValues';
import {
    batchDataHash,
    batchDigest,
    dataChunkCell,
    depositHash,
    merkleProofCell,
    sha256Int,
    WithdrawalLeaf,
    withdrawalTree,
} from '../wrappers/rollupMath';

// Логика rollup-контракта на тестовом двойнике (contracts/rollup_mock.tolk): проверка
// пруфа заменена заглушкой «первое число пруфа равно 1». Настоящая проверка —
// в tests/RollupProof.spec.ts.
const GENESIS_ROOT = sha256Int(1n);
const CHAIN_ID = 4242n;
const DEPOSIT_FEE = toNano('0.01');
const mockProof = (valid: boolean): Bn254Proof => ({
    a: [valid ? 1n : 2n, 0n],
    b: [
        [0n, 0n],
        [0n, 0n],
    ],
    c: [0n, 0n],
});
const NO_HINTS = beginCell().endCell();
/** Детерминированные «случайные» байты: поток sha256(seed ‖ счётчик). */
const pseudoRandomBytes = (length: number, seed: number) => {
    const blocks: Buffer[] = [];
    for (let counter = 0; blocks.length * 32 < length; counter++) {
        blocks.push(createHash('sha256').update(`rollup-data:${seed}:${counter}`).digest());
    }
    return Buffer.concat(blocks).subarray(0, length);
};

describe('Rollup: логика на тестовом двойнике', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;

    const submit = (roots: { newStateRoot: bigint; withdrawalsRoot: bigint }, valid = true) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof(valid),
            hints: NO_HINTS,
            roots,
            value: toNano('0.2'),
        });

    beforeAll(async () => {
        code = await compile('RollupMock');
        nullifierCode = await compile('RollupNullifier');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
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
                    escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
                },
                code,
            ),
        );
        const deploy = await rollup.sendDeploy(owner.getSender(), toNano('5'));
        expect(deploy.transactions).toHaveTransaction({ to: rollup.address, deploy: true, success: true });
    });

    describe('депозит TON', () => {
        it('ставит депозит в очередь и считает накопительный хеш', async () => {
            const recipient = 0x1234567890abcdef1234567890abcdef12345678n;
            const result = await rollup.sendDeposit(user.getSender(), { l2Recipient: recipient, value: toNano('1') });
            expect(result.transactions).toHaveTransaction({ from: user.address, to: rollup.address, success: true });

            const amount = toNano('1') - DEPOSIT_FEE;
            const queue = await rollup.getDepositQueue();
            expect(queue.head).toEqual({ count: 1n, hash: depositHash(0n, recipient, amount) });
            // До первого батча цель и обработанное не двигаются.
            expect(queue.target).toEqual({ count: 0n, hash: 0n });
            expect(queue.processed).toEqual({ count: 0n, hash: 0n });
        });

        it('слишком маленький депозит возвращается отправителю', async () => {
            const result = await rollup.sendDeposit(user.getSender(), { l2Recipient: 1n, value: toNano('0.03') });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.depositTooSmall,
            });
            expect(result.transactions).toHaveTransaction({
                from: rollup.address,
                to: user.address,
                inMessageBounced: true,
            });
            expect((await rollup.getDepositQueue()).head.count).toBe(0n);
        });
    });

    describe('батчи', () => {
        const roots1 = { newStateRoot: sha256Int(2n), withdrawalsRoot: 0n };

        it('принимает батч только от секвенсора', async () => {
            const result = await rollup.sendSubmitBatch(user.getSender(), {
                proof: mockProof(true),
                hints: NO_HINTS,
                roots: roots1,
                value: toNano('0.2'),
            });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notSequencer,
            });
            expect((await rollup.getRollupState()).batchIndex).toBe(0);
        });

        it('отклоняет батч с неверным пруфом и не меняет состояние', async () => {
            const result = await submit(roots1, false);
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.wrongProof,
            });
            expect(await rollup.getRollupState()).toEqual({
                stateRoot: GENESIS_ROOT,
                withdrawalsRoot: 0n,
                batchIndex: 0,
            });
        });

        it('принятый батч меняет корни и номер', async () => {
            const result = await submit(roots1);
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await rollup.getRollupState()).toEqual({
                stateRoot: roots1.newStateRoot,
                withdrawalsRoot: 0n,
                batchIndex: 1,
            });
        });

        it('публичный вход привязан к текущему состоянию и очереди', async () => {
            const before = await rollup.getExpectedPublicInput(roots1);
            expect(before).toBe(
                batchDigest({
                    chainId: CHAIN_ID,
                    prevStateRoot: GENESIS_ROOT,
                    ...roots1,
                    batchHash: 0n,
                    prevDepositHash: 0n,
                    newDepositHash: 0n,
                }),
            );
            await submit(roots1);
            // Тот же батч после принятия потребовал бы уже другой публичный вход:
            // прежним корнем стал новый. Поэтому настоящий пруф нельзя отправить повторно.
            const after = await rollup.getExpectedPublicInput(roots1);
            expect(after).not.toBe(before);
            expect(after).toBe(
                batchDigest({
                    chainId: CHAIN_ID,
                    prevStateRoot: roots1.newStateRoot,
                    ...roots1,
                    batchHash: 0n,
                    prevDepositHash: 0n,
                    newDepositHash: 0n,
                }),
            );
        });

        it('принудительное включение: депозит до батча k−1 обязан войти в батч k', async () => {
            const recipient = 77n;
            await rollup.sendDeposit(user.getSender(), { l2Recipient: recipient, value: toNano('1') });
            const afterDeposit = depositHash(0n, recipient, toNano('1') - DEPOSIT_FEE);

            // Батч 1: депозит пришёл после того, как цель была зафиксирована (на генезисе),
            // поэтому этот батч его ещё не обрабатывает.
            expect(await rollup.getExpectedPublicInput(roots1)).toBe(
                batchDigest({
                    chainId: CHAIN_ID,
                    prevStateRoot: GENESIS_ROOT,
                    ...roots1,
                    batchHash: 0n,
                    prevDepositHash: 0n,
                    newDepositHash: 0n,
                }),
            );
            await submit(roots1);
            const queue1 = await rollup.getDepositQueue();
            expect(queue1.processed.count).toBe(0n);
            expect(queue1.target).toEqual({ count: 1n, hash: afterDeposit });

            // Батч 2 обязан довести очередь до цели: контракт сам подставляет её хеш.
            const roots2 = { newStateRoot: sha256Int(4n), withdrawalsRoot: 0n };
            expect(await rollup.getExpectedPublicInput(roots2)).toBe(
                batchDigest({
                    chainId: CHAIN_ID,
                    prevStateRoot: roots1.newStateRoot,
                    ...roots2,
                    batchHash: 0n,
                    prevDepositHash: 0n,
                    newDepositHash: afterDeposit,
                }),
            );
            await submit(roots2);
            const queue2 = await rollup.getDepositQueue();
            expect(queue2.processed).toEqual({ count: 1n, hash: afterDeposit });
            expect(queue2.target).toEqual(queue2.head);
        });
    });

    describe('данные батча', () => {
        const roots1 = { newStateRoot: sha256Int(2n), withdrawalsRoot: 0n };
        // Порции заведомо разной длины: неполная ячейка, ровно одна ячейка, цепочка из трёх.
        const chunkA = dataChunkCell(Buffer.from('порция А'));
        const chunkB = dataChunkCell(Buffer.alloc(127, 0xb1));
        const chunkC = dataChunkCell(Buffer.alloc(300, 0xc2));
        const publish = (batchIndex: number, data: Cell, from = sequencer) =>
            rollup.sendPublishData(from.getSender(), { batchIndex, data, value: toNano('0.05') });
        const digestWith = (batchHash: bigint) =>
            batchDigest({
                chainId: CHAIN_ID,
                prevStateRoot: GENESIS_ROOT,
                ...roots1,
                batchHash,
                prevDepositHash: 0n,
                newDepositHash: 0n,
            });

        it('публиковать данные может только секвенсор', async () => {
            const result = await publish(1, chunkA, user);
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notSequencer,
            });
            expect(await rollup.getBatchDataHash(1)).toBe(0n);
        });

        it('порции складываются в накопительный хеш в порядке публикации', async () => {
            expect(await rollup.getExpectedPublicInput(roots1)).toBe(digestWith(0n));
            for (const chunk of [chunkA, chunkB, chunkC]) {
                expect((await publish(1, chunk)).transactions).toHaveTransaction({ to: rollup.address, success: true });
            }
            const expected = batchDataHash([chunkA, chunkB, chunkC]);
            expect(await rollup.getBatchDataHash(1)).toBe(expected);
            expect(expected).not.toBe(batchDataHash([chunkB, chunkA, chunkC]));
            // Публичный вход следующего батча теперь зависит от опубликованных данных.
            expect(await rollup.getExpectedPublicInput(roots1)).toBe(digestWith(expected));
        });

        it('данные принятого батча опубликовать нельзя, а запись о них удаляется', async () => {
            await publish(1, chunkA);
            await submit(roots1);
            expect(await rollup.getBatchDataHash(1)).toBe(0n);
            const late = await publish(1, chunkB);
            expect(late.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.dataForClosedBatch,
            });
        });

        it('данные можно публиковать вперёд: они дожидаются своего батча', async () => {
            await publish(2, chunkB);
            await publish(1, chunkA);
            await publish(2, chunkC);
            await submit(roots1);
            expect(await rollup.getBatchDataHash(2)).toBe(batchDataHash([chunkB, chunkC]));
            const roots2 = { newStateRoot: sha256Int(4n), withdrawalsRoot: 0n };
            expect(await rollup.getExpectedPublicInput(roots2)).toBe(
                batchDigest({
                    chainId: CHAIN_ID,
                    prevStateRoot: roots1.newStateRoot,
                    ...roots2,
                    batchHash: batchDataHash([chunkB, chunkC]),
                    prevDepositHash: 0n,
                    newDepositHash: 0n,
                }),
            );
            await submit(roots2);
            expect(await rollup.getBatchDataHash(2)).toBe(0n);
            expect((await rollup.getRollupState()).batchIndex).toBe(2);
        });

        it('газ публикации не зависит от размера порции', async () => {
            // Контракт берёт готовый хеш ячейки и не читает данные: порция в 60 КБ стоит
            // по газу столько же, сколько маленькая. Размер оплачивается пересылкой сообщения.
            const sizes = [100, 4_000, 60_000];
            const measured: Record<
                string,
                { gasUsed: number; forwardFeeNano: number; cells: number; messageBocBytes: number }
            > = {};
            for (const [index, bytes] of sizes.entries()) {
                // Данные без повторов: одинаковые ячейки сеть тарифицирует один раз, и плата
                // за пересылку на однородном заполнении получилась бы заниженной.
                const data = dataChunkCell(pseudoRandomBytes(bytes, index));
                const result = await publish(1, data);
                expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
                const tx = result.transactions.find(
                    (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.dest.equals(rollup.address),
                )!;
                const info = tx.inMessage!.info;
                measured[`${bytes} байт`] = {
                    gasUsed: Number(computePhaseOf(result.transactions, rollup.address).gasUsed),
                    forwardFeeNano: info.type === 'internal' ? Number(info.forwardFee) : 0,
                    cells: Math.ceil(bytes / 127),
                    messageBocBytes: beginCell().storeRef(data).endCell().toBoc().length,
                };
            }
            const gasValues = Object.values(measured).map((m) => m.gasUsed);
            // Первая порция создаёт запись словаря, следующие её обновляют — разница в сотни gas.
            expect(Math.max(...gasValues) - Math.min(...gasValues)).toBeLessThan(1_000);

            const file = path.join(__dirname, '..', 'bench', 'rollup-publish-data.json');
            mkdirSync(path.dirname(file), { recursive: true });
            writeFileSync(
                file,
                JSON.stringify(
                    {
                        source: 'Измерено в @ton/sandbox тестом tests/Rollup.spec.ts; не редактировать вручную',
                        note: 'Сообщение PublishData: газ контракта и поле forward fee входящего сообщения (часть платы за пересылку, оставшаяся после доли отправляющего шарда) при ценах встроенного конфига Sandbox',
                        measured,
                    },
                    null,
                    2,
                ) + '\n',
            );
        });
    });

    describe('вывод', () => {
        const recipients = [1, 2, 3].map(
            (i) =>
                new Address(
                    0,
                    Buffer.from(
                        sha256Int(BigInt(100 + i))
                            .toString(16)
                            .padStart(64, '0'),
                        'hex',
                    ),
                ),
        );
        const leaves: WithdrawalLeaf[] = recipients.map((address, i) => ({
            leafIndex: i,
            recipientHash: BigInt('0x' + address.hash.toString('hex')),
            amount: toNano('0.3') + BigInt(i),
        }));
        const tree = withdrawalTree(leaves);
        const withdraw = (index: number, overrides: { amount?: bigint; value?: bigint; proofIndex?: number } = {}) =>
            rollup.sendWithdraw(user.getSender(), {
                leafIndex: index,
                recipient: recipients[index],
                amount: overrides.amount ?? leaves[index].amount,
                merkleProof: merkleProofCell(tree.proofFor(overrides.proofIndex ?? index)),
                value: overrides.value ?? toNano('0.2'),
            });
        const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;

        beforeEach(async () => {
            await submit({ newStateRoot: sha256Int(2n), withdrawalsRoot: tree.root });
        });

        it('выплачивает ровно сумму листа получателю через нуллификатор', async () => {
            const result = await withdraw(1);
            const nullifier = await rollup.getNullifierAddress(1);
            expect(result.transactions).toHaveTransaction({ from: user.address, to: rollup.address, success: true });
            expect(result.transactions).toHaveTransaction({
                from: rollup.address,
                to: nullifier,
                deploy: true,
                success: true,
                op: RollupOpcodes.nullifierClaim,
            });
            expect(result.transactions).toHaveTransaction({
                from: nullifier,
                to: rollup.address,
                success: true,
                op: RollupOpcodes.nullifierClaimed,
            });
            expect(result.transactions).toHaveTransaction({ from: rollup.address, to: recipients[1] });
            expect(await balanceOf(recipients[1])).toBe(leaves[1].amount);
        });

        it('повторный вывод того же листа не выплачивается', async () => {
            await withdraw(1);
            const second = await withdraw(1);
            const nullifier = await rollup.getNullifierAddress(1);
            expect(second.transactions).toHaveTransaction({
                from: rollup.address,
                to: nullifier,
                success: false,
                exitCode: NullifierErrors.alreadyClaimed,
            });
            // Заявка вернулась bounce'ом, второй выплаты нет.
            expect(second.transactions).toHaveTransaction({
                from: nullifier,
                to: rollup.address,
                inMessageBounced: true,
            });
            expect(second.transactions).not.toHaveTransaction({ from: rollup.address, to: recipients[1] });
            expect(await balanceOf(recipients[1])).toBe(leaves[1].amount);
        });

        it('разные листья выводятся независимо', async () => {
            await withdraw(0);
            await withdraw(2);
            expect(await balanceOf(recipients[0])).toBe(leaves[0].amount);
            expect(await balanceOf(recipients[2])).toBe(leaves[2].amount);
        });

        it.each([
            ['завышенная сумма', { amount: toNano('3') }],
            ['доказательство от другого листа', { proofIndex: 2 }],
        ])('отклоняет вывод: %s', async (_, overrides) => {
            const result = await withdraw(1, overrides);
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.wrongMerkleProof,
            });
            expect(await balanceOf(recipients[1])).toBe(0n);
        });

        it('требует достаточно монет на цепочку сообщений', async () => {
            const result = await withdraw(1, { value: toNano('0.05') });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notEnoughValue,
            });
        });

        it('подтверждение не от нуллификатора не приводит к выплате', async () => {
            const forged = beginCell()
                .storeUint(RollupOpcodes.nullifierClaimed, 32)
                .storeUint(0, 64)
                .storeUint(1, 256)
                .storeAddress(user.address)
                .storeCoins(toNano('1'))
                .endCell();
            const result = await user.send({ to: rollup.address, value: toNano('0.1'), body: forged });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notNullifier,
            });
        });

        it('нуллификатор принимает заявки только от своего rollup', async () => {
            await withdraw(1);
            const nullifier = await rollup.getNullifierAddress(1);
            const claim = beginCell()
                .storeUint(RollupOpcodes.nullifierClaim, 32)
                .storeUint(0, 64)
                .storeAddress(user.address)
                .storeCoins(toNano('1'))
                .endCell();
            const result = await user.send({ to: nullifier, value: toNano('0.1'), body: claim });
            expect(result.transactions).toHaveTransaction({
                to: nullifier,
                success: false,
                exitCode: NullifierErrors.notRollup,
            });
        });
    });
});
