import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { finalizeDummyKeys, mockProof, ProtocolConstants, readProtocolConstants, testConfig } from './helpers/rollupSetup';
import { computePhaseOf } from './helpers/gas';
import { PROTOCOL_VERSION } from '../wrappers/protocolVersion';
import { BatchRoots, NullifierErrors, Rollup, RollupErrors, RollupOpcodes } from '../wrappers/Rollup';
import { ESCAPE_TIMEOUT_SECONDS } from '../wrappers/rollupValues';
import {
    batchDataHash,
    batchDigest,
    BatchPublicValues,
    batchPublicValueWords,
    dataChunkCell,
    depositHash,
    merkleProofCell,
    sha256Int,
    WithdrawalLeaf,
    withdrawalTree,
} from '../wrappers/rollupMath';

// Логика rollup-контракта протокола v2 на тестовом двойнике (contracts/rollup_mock.tolk):
// проверка пруфа заменена заглушкой «первое число пруфа равно 1». Очередь L1 — в
// tests/RollupQueue.spec.ts, начальное состояние и фиксация ключа — tests/RollupGenesis.spec.ts.
const CHAIN_ID = 4242n;
const DEPOSIT_FEE = toNano('0.01');
const START = 1_800_000_000;
const NO_HINTS = beginCell().endCell();
/** То, что батч заявляет, с умолчаниями: выводов нет, очередь не тронута, блок собран «сейчас». */
const rootsAt = (newStateRoot: bigint, overrides: Partial<BatchRoots> = {}): BatchRoots => ({
    newStateRoot,
    withdrawalsRoot: 0n,
    withdrawalsCount: 0n,
    queueProcessedUpTo: 0n,
    blockTimestamp: BigInt(START),
    ...overrides,
});
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
    let constants: ProtocolConstants;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;

    const submit = (roots: BatchRoots, valid = true) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: mockProof(valid),
            hints: NO_HINTS,
            roots,
            value: toNano('0.2'),
        });
    /**
     * Публичный вход батча с такими заявленными значениями. То, что контракт берёт у себя
     * (прежнее состояние, данные, очередь), по умолчанию — как сразу после развёртывания.
     */
    const digestOf = (roots: BatchRoots, stored: Partial<BatchPublicValues> = {}) =>
        batchDigest({
            chainId: CHAIN_ID,
            prevStateRoot: constants.genesisHash,
            newStateRoot: roots.newStateRoot,
            batchHash: 0n,
            prevWithdrawalsRoot: 0n,
            withdrawalsRoot: roots.withdrawalsRoot,
            prevDepositHash: 0n,
            newDepositHash: 0n,
            prevWithdrawalsCount: 0n,
            withdrawalsCount: roots.withdrawalsCount,
            blockTimestamp: roots.blockTimestamp,
            ...stored,
        });

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
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                testConfig(constants, {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode,
                    chainId: CHAIN_ID,
                    escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
                }),
                code,
            ),
        );
        const deploy = await rollup.sendDeploy(owner.getSender(), toNano('5'));
        expect(deploy.transactions).toHaveTransaction({ to: rollup.address, deploy: true, success: true });
        await finalizeDummyKeys(rollup, owner);
    });

    it('контракт сообщает версию протокола, и она та же, что в обёртках', async () => {
        expect(await rollup.getProtocolVersion()).toBe(2);
        expect(PROTOCOL_VERSION).toBe(2);
    });

    describe('депозит TON', () => {
        it('ставит депозит в очередь и считает накопительный хеш', async () => {
            const recipient = 0x1234567890abcdef1234567890abcdef12345678n;
            const result = await rollup.sendDeposit(user.getSender(), { l2Recipient: recipient, value: toNano('1') });
            expect(result.transactions).toHaveTransaction({ from: user.address, to: rollup.address, success: true });

            const amount = toNano('1') - DEPOSIT_FEE;
            const queue = await rollup.getDepositQueue();
            expect(queue.head).toEqual({ count: 1n, hash: depositHash(0n, recipient, amount) });
            // Обработанное двигает только батч.
            expect(queue.processed).toEqual({ count: 0n, hash: 0n });
            // Запись словаря: хеш очереди до элемента и время постановки.
            expect(await rollup.getQueueItem(1)).toEqual({ hashBefore: 0n, queuedAt: START });
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

        it('сумма на L2 обязана быть меньше 2^64 нанотон: на нанотон меньше — принят, ровно 2^64 — возвращён', async () => {
            // Программа zkVM держит суммы в 64 битах: больший депозит она не смогла бы зачислить,
            // и батч с ним был бы недоказуем. Предел — у контракта (get-метод queueLimits).
            const limit = constants.depositAmountLimit;
            expect(limit).toBe(1n << 64n);
            const whale = await blockchain.treasury('whale', { balance: 4n * limit });
            const deposit = (amount: bigint) =>
                rollup.sendDeposit(whale.getSender(), { l2Recipient: 7n, value: amount + DEPOSIT_FEE });

            const tooLarge = await deposit(limit);
            expect(tooLarge.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.depositTooLarge,
            });
            expect(tooLarge.transactions).toHaveTransaction({
                from: rollup.address,
                to: whale.address,
                inMessageBounced: true,
            });
            expect((await rollup.getDepositQueue()).head.count).toBe(0n);

            expect((await deposit(limit - 1n)).transactions).toHaveTransaction({ to: rollup.address, success: true });
            // Get-методы после такого депозита в Sandbox недоступны (баланс контракта больше 2^63
            // нанотон эмулятор не принимает), поэтому очередь читается прямо из хранилища.
            const account = (await blockchain.getContract(rollup.address)).accountState;
            if (account?.type !== 'active') throw new Error('контракт не развёрнут');
            const queue = Rollup.queueFromData(account.state.data!);
            expect(queue.head).toEqual({ count: 1n, hash: depositHash(0n, 7n, limit - 1n) });
            expect(queue.items.get(1n)?.receipt?.amount).toBe(limit - 1n);
            expect(queue.items.get(1n)?.receipt?.depositor.equals(whale.address)).toBe(true);
        });
    });

    describe('батчи', () => {
        const roots1 = rootsAt(sha256Int(2n));

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
                stateRoot: constants.genesisHash,
                withdrawalsRoot: 0n,
                batchIndex: 0,
                withdrawalsCount: 0n,
            });
        });

        it('принятый батч меняет слово состояния, корень и счётчик выводов и номер', async () => {
            const roots = rootsAt(sha256Int(2n), { withdrawalsRoot: sha256Int(50n), withdrawalsCount: 3n });
            const result = await submit(roots);
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await rollup.getRollupState()).toEqual({
                stateRoot: roots.newStateRoot,
                withdrawalsRoot: roots.withdrawalsRoot,
                batchIndex: 1,
                withdrawalsCount: 3n,
            });
        });

        it('публичный вход — одиннадцать слов в порядке протокола, привязанных к текущему состоянию', async () => {
            const before = await rollup.getExpectedPublicInput(roots1);
            expect(before).toBe(digestOf(roots1));
            // Порядок слов — часть протокола (PROTOCOL-V2.md, раздел 2): первые восемь — прежние,
            // три новых дописаны в конец.
            const words = batchPublicValueWords({
                chainId: 1n,
                prevStateRoot: 2n,
                newStateRoot: 3n,
                batchHash: 4n,
                prevWithdrawalsRoot: 5n,
                withdrawalsRoot: 6n,
                prevDepositHash: 7n,
                newDepositHash: 8n,
                prevWithdrawalsCount: 9n,
                withdrawalsCount: 10n,
                blockTimestamp: 11n,
            });
            expect(words).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n]);

            await submit(roots1);
            // Тот же батч после принятия потребовал бы уже другой публичный вход:
            // прежним словом состояния стало новое. Поэтому настоящий пруф нельзя отправить повторно.
            const after = await rollup.getExpectedPublicInput(roots1);
            expect(after).not.toBe(before);
            expect(after).toBe(digestOf(roots1, { prevStateRoot: roots1.newStateRoot }));
        });

        it('каждое заявленное значение и каждое значение из хранилища меняет публичный вход', async () => {
            // Прежние корень и счётчик выводов ненулевые: ноль скрыл бы их отсутствие в байтах.
            const first = rootsAt(sha256Int(2n), { withdrawalsRoot: sha256Int(50n), withdrawalsCount: 5n });
            await submit(first);
            const stored = {
                prevStateRoot: first.newStateRoot,
                prevWithdrawalsRoot: first.withdrawalsRoot,
                prevWithdrawalsCount: first.withdrawalsCount,
            };
            const next = rootsAt(sha256Int(3n), { withdrawalsRoot: sha256Int(51n), withdrawalsCount: 6n });
            const required = await rollup.getExpectedPublicInput(next);
            expect(required).toBe(digestOf(next, stored));
            // Слово 8 — прежний счётчик из хранилища: пруф от другого прежнего счётчика не сойдётся.
            expect(required).not.toBe(digestOf(next, { ...stored, prevWithdrawalsCount: 0n }));
            expect(required).not.toBe(digestOf(next, { ...stored, prevWithdrawalsCount: 4n }));
            // Слова 9 и 10 — заявленные счётчик и время блока.
            const changed: Partial<BatchRoots>[] = [
                { withdrawalsCount: 7n },
                { withdrawalsCount: 0n },
                { blockTimestamp: BigInt(START - 1) },
                { blockTimestamp: 0n },
                { withdrawalsRoot: sha256Int(52n) },
                { newStateRoot: sha256Int(4n) },
            ];
            for (const override of changed) {
                const other = await rollup.getExpectedPublicInput({ ...next, ...override });
                expect(other).not.toBe(required);
                expect(other).toBe(digestOf({ ...next, ...override }, stored));
            }
        });

        it('подмена счётчика выводов при том же корне меняет публичный вход', async () => {
            // Атака из раздела 4 PROTOCOL-V2.md: корень связывает только элементы фронтира на
            // единичных битах счётчика, поэтому тот же корень можно получить с другим счётчиком
            // и прыжками довести счётчик до 2^32, закрыв выводы навсегда. Счётчик поэтому входит
            // в публичные значения — и заявленный, и прежний.
            const honest = rootsAt(sha256Int(2n), { withdrawalsRoot: sha256Int(50n), withdrawalsCount: 2n });
            const jumped = { ...honest, withdrawalsCount: 1n << 31n };
            expect(await rollup.getExpectedPublicInput(jumped)).not.toBe(await rollup.getExpectedPublicInput(honest));
            // Двойник принимает любой «пруф», так что принятие само ничего не доказывает; важно,
            // что счётчик из принятого батча становится прежним для следующего.
            await submit(jumped);
            expect((await rollup.getRollupState()).withdrawalsCount).toBe(1n << 31n);
            const next = rootsAt(sha256Int(3n), { withdrawalsRoot: sha256Int(51n), withdrawalsCount: (1n << 31n) + 1n });
            expect(await rollup.getExpectedPublicInput(next)).toBe(
                digestOf(next, {
                    prevStateRoot: honest.newStateRoot,
                    prevWithdrawalsRoot: honest.withdrawalsRoot,
                    prevWithdrawalsCount: 1n << 31n,
                }),
            );
        });
    });

    describe('время блока', () => {
        // Контракт требует now − maxBlockAge ≤ blockTimestamp ≤ now. Границы — по секунде.
        let maxBlockAge: number;
        const at = (blockTimestamp: number) => submit(rootsAt(sha256Int(2n), { blockTimestamp: BigInt(blockTimestamp) }));

        beforeEach(async () => {
            maxBlockAge = (await rollup.getDeployment()).maxBlockAge;
            expect(maxBlockAge).toBe(constants.minMaxBlockAge);
        });

        it('блок из будущего отклоняется: на секунду позже времени L1 — отказ, ровно «сейчас» — принят', async () => {
            expect((await at(START + 1)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.blockFromFuture,
            });
            expect((await rollup.getRollupState()).batchIndex).toBe(0);
            expect((await at(START)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        });

        it('устаревший блок отклоняется: ровно maxBlockAge назад — принят, на секунду старше — отказ', async () => {
            expect((await at(START - maxBlockAge - 1)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.blockTooOld,
            });
            expect((await rollup.getRollupState()).batchIndex).toBe(0);
            expect((await at(START - maxBlockAge)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        });

        it('батч, не принятый за maxBlockAge, негоден навсегда', async () => {
            // Блок собран в момент START. Через maxBlockAge он ещё годен, секундой позже — уже нет.
            blockchain.now = START + maxBlockAge;
            expect((await submit(rootsAt(sha256Int(2n)))).transactions).toHaveTransaction({
                to: rollup.address,
                success: true,
            });
            blockchain.now = START + maxBlockAge + 1;
            expect((await submit(rootsAt(sha256Int(3n)))).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.blockTooOld,
            });
            expect((await rollup.getRollupState()).batchIndex).toBe(1);
        });
    });

    describe('данные батча', () => {
        const roots1 = rootsAt(sha256Int(2n));
        // Порции заведомо разной длины: неполная ячейка, ровно одна ячейка, цепочка из трёх.
        const chunkA = dataChunkCell(Buffer.from('порция А'));
        const chunkB = dataChunkCell(Buffer.alloc(127, 0xb1));
        const chunkC = dataChunkCell(Buffer.alloc(300, 0xc2));
        const publish = (batchIndex: number, data: Cell, from = sequencer) =>
            rollup.sendPublishData(from.getSender(), { batchIndex, data, value: toNano('0.05') });
        const digestWith = (batchHash: bigint) => digestOf(roots1, { batchHash });

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
            const roots2 = rootsAt(sha256Int(4n));
            expect(await rollup.getExpectedPublicInput(roots2)).toBe(
                digestOf(roots2, { prevStateRoot: roots1.newStateRoot, batchHash: batchDataHash([chunkB, chunkC]) }),
            );
            await submit(roots2);
            expect(await rollup.getBatchDataHash(2)).toBe(0n);
            expect((await rollup.getRollupState()).batchIndex).toBe(2);
        });

        it('данные нельзя публиковать дальше чем на четыре батча вперёд', async () => {
            // Иначе словарь данных можно было бы растить записями для батчей, которые не наступят.
            expect((await publish(4, chunkA)).transactions).toHaveTransaction({ to: rollup.address, success: true });
            const tooFar = await publish(5, chunkA);
            expect(tooFar.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.dataTooFarAhead,
            });
            expect(await rollup.getBatchDataHash(5)).toBe(0n);
            await submit(roots1);
            // Окно сдвинулось вместе с номером последнего принятого батча.
            expect((await publish(5, chunkA)).transactions).toHaveTransaction({ to: rollup.address, success: true });
        });

        it('секвенсор может сбросить данные батча и опубликовать заново; посторонний — нет', async () => {
            // Ошибка публикации: порция, которую программа zkVM не воспроизведёт, — ячейка с
            // раскладкой не по протоколу (те же байты цепочкой, а не «кучей»). Контракт её
            // форму не проверяет, хеш уже испорчен, и без сброса батч стал бы недоказуемым.
            const bytes = Buffer.alloc(300, 0xc2);
            const misplaced = beginCell()
                .storeBuffer(bytes.subarray(0, 127))
                .storeRef(
                    beginCell()
                        .storeBuffer(bytes.subarray(127, 254))
                        .storeRef(beginCell().storeBuffer(bytes.subarray(254)).endCell())
                        .endCell(),
                )
                .endCell();
            expect(misplaced.hash().equals(chunkC.hash())).toBe(false);
            await publish(1, chunkA);
            await publish(1, misplaced);
            expect(await rollup.getBatchDataHash(1)).not.toBe(batchDataHash([chunkA, chunkC]));

            const discard = (from: typeof sequencer, batchIndex = 1) =>
                rollup.sendDiscardBatchData(from.getSender(), { batchIndex, value: toNano('0.05') });
            expect((await discard(user)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notSequencer,
            });
            expect(await rollup.getBatchDataHash(1)).not.toBe(0n);

            expect((await discard(sequencer)).transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await rollup.getBatchDataHash(1)).toBe(0n);
            await publish(1, chunkA);
            await publish(1, chunkC);
            expect(await rollup.getBatchDataHash(1)).toBe(batchDataHash([chunkA, chunkC]));
            expect(await rollup.getExpectedPublicInput(roots1)).toBe(digestWith(batchDataHash([chunkA, chunkC])));
            // Сброс того, чего нет, ничего не ломает.
            expect((await discard(sequencer, 3)).transactions).toHaveTransaction({ to: rollup.address, success: true });
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
            await submit(
                rootsAt(sha256Int(2n), { withdrawalsRoot: tree.root, withdrawalsCount: BigInt(leaves.length) }),
            );
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

        /** Верное доказательство, у последней ячейки которого висит лишняя пустая ссылка. */
        const proofWithTrailingRef = (siblings: bigint[]): Cell => {
            let tail: Cell | null = null;
            for (let chunk = Math.ceil(siblings.length / 3) - 1; chunk >= 0; chunk--) {
                const builder = beginCell();
                for (const sibling of siblings.slice(chunk * 3, chunk * 3 + 3)) builder.storeUint(sibling, 256);
                builder.storeRef(tail ?? beginCell().endCell());
                tail = builder.endCell();
            }
            return tail!;
        };

        it('подмена суммы, получателя, номера листа или доказательства не проходит', async () => {
            const send = (overrides: Partial<Parameters<typeof rollup.sendWithdraw>[1]>) =>
                rollup.sendWithdraw(user.getSender(), {
                    leafIndex: 1,
                    recipient: recipients[1],
                    amount: leaves[1].amount,
                    merkleProof: merkleProofCell(tree.proofFor(1)),
                    value: toNano('0.2'),
                    ...overrides,
                });
            const siblings = tree.proofFor(1);
            const wrongProof: Partial<Parameters<typeof rollup.sendWithdraw>[1]>[] = [
                { amount: leaves[1].amount + 1n },
                { recipient: recipients[2] },
                // Чужое доказательство под свой лист и свой лист под чужим номером.
                { merkleProof: merkleProofCell(tree.proofFor(2)) },
                { leafIndex: 2 },
                { leafIndex: 0 },
                // Лишний хеш в конце доказательства; лишняя полная ячейка с хешами.
                { merkleProof: merkleProofCell([...siblings, 0n]) },
                { merkleProof: merkleProofCell([...siblings, 0n, 0n, 0n]) },
                // Все 32 хеша на месте, лишних бит нет, но у последней ячейки лишняя ссылка.
                { merkleProof: proofWithTrailingRef(siblings) },
            ];
            for (const overrides of wrongProof) {
                expect((await send(overrides)).transactions).toHaveTransaction({
                    to: rollup.address,
                    success: false,
                    exitCode: RollupErrors.wrongMerkleProof,
                });
            }
            // Короткое доказательство: чтение за концом ячейки (исключение TVM 9).
            expect((await send({ merkleProof: merkleProofCell(siblings.slice(0, 31)) })).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: 9,
            });
            // Получатель вне basechain: тот же хеш адреса в masterchain — другой адрес.
            const masterchain = new Address(-1, recipients[1].hash);
            expect((await send({ recipient: masterchain })).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.wrongRecipient,
            });
            for (const recipient of [...recipients, masterchain]) expect(await balanceOf(recipient)).toBe(0n);
            // Ни одна из попыток не пометила лист: честный вывод проходит.
            expect((await send({})).transactions).toHaveTransaction({
                from: rollup.address,
                to: recipients[1],
                value: leaves[1].amount,
            });
        });

        it('требует достаточно монет на цепочку сообщений', async () => {
            // Порог задан в газе и пересчитывается по ценам сети; на одну нанотону меньше — отказ.
            const { withdraw: minimum } = await rollup.getMinimumValues();
            const result = await withdraw(1, { value: minimum - 1n });
            expect(result.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.notEnoughValue,
            });
            expect(await balanceOf(recipients[1])).toBe(0n);
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
