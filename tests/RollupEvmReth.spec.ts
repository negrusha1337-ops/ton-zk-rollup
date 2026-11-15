// @ts-nocheck
// НАБОР ПРОТОКОЛА v1. Написан под обёртки и пруфы прежнего протокола (дайджест из восьми слов,
// сообщения ForceExit и SetExitKey); с контрактом протокола v2 несовместим. Не удалён и не
// подогнан: пока пруфы в fixtures/ не перестроены под v2 (wrappers/protocolVersion.ts), набор
// помечает себя todo через describeWithProofFixtures и не типизируется. Перенос на v2 — вместе
// с шагом программы и пруфов (PROTOCOL-V2.md, раздел 11); прежняя версия целиком — тег protocol-v1.
import { describeWithProofFixtures } from './helpers/protocolGate';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { readFileSync } from 'fs';
import path from 'path';
import { keccak_256 } from '@noble/hashes/sha3';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';
import {
    evmHeaderCell,
    evmNodeItems,
    evmProofCell,
    evmProofSteps,
    evmSignatureCell,
    evmSignatureFromHex,
} from '../wrappers/evmExit';
import { EvmBatchReport, loadEvmProgramKeys, publicInputOf } from '../wrappers/evmProofs';
import { NullifierErrors, Rollup } from '../wrappers/Rollup';
import { batchDataHash, dataChunkCell, depositHash, merkleProofCell, withdrawalTree } from '../wrappers/rollupMath';
import { computePhaseOf } from './helpers/gas';
import { finalizeDummyKeys } from './helpers/rollupSetup';

// Полный цикл на блоках настоящего узла Reth (zkvm-evm/scenario/reth-scenario.mjs): деньги
// вносятся на L1, зачисляются в блоках EVM, выводятся через мост и через аварийный выход.
// В генезисе цепочки нет ни одного счёта: все монеты L2 — из депозитов этого теста, поэтому
// каждая выплата контракта обеспечена (REVIEW.md, 9-А).
//
// Контракт — двойник (contracts/rollup_mock.tolk): пруфов для этих блоков нет, проверка пруфа
// заменена заглушкой. Всё остальное — тот же код (tests/MockParity.spec.ts), и главное здесь не
// пруф, а сходимость сторон: публичный вход, который контракт ждёт для каждого батча, обязан
// совпасть с тем, что программа выдала в zkVM для блока Reth (отчёты block-N.json). Приём этих
// батчей по настоящему пруфу этим тестом НЕ доказан.
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'evm_batches', 'reth');
const expected = JSON.parse(readFileSync(path.join(FIXTURES, 'expected.json'), 'utf8'));
const reports: EvmBatchReport[] = [1, 2, 3].map((number) =>
    JSON.parse(readFileSync(path.join(FIXTURES, `block-${number}.json`), 'utf8')),
);
const bytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex');
const TIMEOUT = 3600;
const START = 1_800_000_000;
/** 1 нанотон = 1 gwei (EVM_WEI_PER_NANOTON в evm_exit.tolk). */
const WEI_PER_NANOTON = 1_000_000_000n;
/** Заглушка пруфа для двойника: «первое число пруфа равно 1». */
const MOCK_PROOF: Bn254Proof = {
    a: [1n, 0n],
    b: [
        [0n, 0n],
        [0n, 0n],
    ],
    c: [0n, 0n],
};
const NO_HINTS = beginCell().endCell();

describeWithProofFixtures('Rollup: полный цикл на блоках узла Reth', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;

    const rootsOf = (report: EvmBatchReport) => ({
        newStateRoot: BigInt(report.publicValues.newStateRoot),
        withdrawalsRoot: BigInt(report.publicValues.withdrawalsRoot),
    });
    /** Депозит на L1: к сумме, которая зачтётся на L2, прибавляется комиссия очереди. */
    const deposit = async (item: { l2Recipient: string; amount: string }) => {
        const { depositFee } = await rollup.getQueueFees();
        const before = (await rollup.getDepositQueue()).head;
        await rollup.sendDeposit(user.getSender(), {
            l2Recipient: BigInt(item.l2Recipient),
            value: BigInt(item.amount) + depositFee,
            maxFee: depositFee,
        });
        const after = (await rollup.getDepositQueue()).head;
        expect(after.count).toBe(before.count + 1n);
        expect(after.hash).toBe(depositHash(before.hash, BigInt(item.l2Recipient), BigInt(item.amount)));
    };
    /** Публикует данные блока и подаёт батч; до отправки сверяет публичный вход с программой. */
    const submitBatch = async (number: number) => {
        const report = reports[number - 1];
        const chunks = report.dataChunksHex.map((hex) => dataChunkCell(bytes(hex)));
        for (const data of chunks) {
            await rollup.sendPublishData(owner.getSender(), { batchIndex: number, data, value: toNano('0.05') });
        }
        expect(await rollup.getBatchDataHash(number)).toBe(batchDataHash(chunks));
        expect(await rollup.getBatchDataHash(number)).toBe(BigInt(report.publicValues.batchHash));
        // Главная сверка: восемь слов, которые контракт соберёт из своего хранилища, — те же,
        // что программа закоммитила в zkVM для этого блока Reth.
        expect(await rollup.getExpectedPublicInput(rootsOf(report))).toBe(publicInputOf(report.publicValuesBytes));
        const result = await rollup.sendSubmitBatch(owner.getSender(), {
            proof: MOCK_PROOF,
            hints: NO_HINTS,
            roots: rootsOf(report),
            value: toNano('0.2'),
        });
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: rootsOf(report).newStateRoot,
            withdrawalsRoot: rootsOf(report).withdrawalsRoot,
            batchIndex: number,
        });
    };

    beforeAll(async () => {
        code = await compile('RollupMock');
        nullifierCode = await compile('RollupNullifier');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = START;
        owner = await blockchain.treasury('owner');
        user = await blockchain.treasury('user');
        stranger = await blockchain.treasury('stranger');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: owner.address,
                    sequencer: owner.address,
                    nullifierCode,
                    // «Корень состояния генезиса» — хеш заголовка генезиса Reth.
                    genesisStateRoot: BigInt(expected.genesisHash),
                    chainId: BigInt(expected.chainId),
                    escapeTimeout: TIMEOUT,
                },
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('0.05'));
        await finalizeDummyKeys(rollup, owner);
    });

    it('фикстуры — одна цепочка от пустого генезиса, и программа коммитит хеши её блоков', () => {
        expect(reports[0].publicValues.prevStateRoot).toBe(expected.genesisHash);
        for (let index = 0; index < 3; index++) {
            expect(reports[index].publicValues.newStateRoot).toBe(expected.blocks[index].hash);
            if (index > 0) expect(reports[index].publicValues.prevStateRoot).toBe(expected.blocks[index - 1].hash);
            expect(reports[index].zkvmCycles).toBeGreaterThan(0);
            // Блоки исполнены тем же ELF, под который выведен ключ контракта.
            expect((reports[index] as EvmBatchReport & { programElfSha256: string }).programElfSha256).toBe(
                '0x' + loadEvmProgramKeys().programElfSha256.replace(/^0x/, ''),
            );
        }
        // Блоки 4 и 5 (контракт с хранилищем и обнуление слота рядом с веткой, REVIEW.md 7-1)
        // продолжают ту же цепочку и исполнены программой в zkVM: без этого сценарий не записал бы
        // expected.json. Батчами в этом тесте они не становятся.
        expect(expected.blocks.length).toBe(5);
        expect(expected.storageDeletion.block).toBe(5);
        for (const number of [4, 5]) {
            const report = JSON.parse(readFileSync(path.join(FIXTURES, `block-${number}.json`), 'utf8'));
            expect(report.publicValues.newStateRoot).toBe(expected.blocks[number - 1].hash);
            expect(report.publicValues.prevStateRoot).toBe(expected.blocks[number - 2].hash);
            expect(report.transactions).toBe(1);
        }
        // Блок 1 очередь не трогает; блоки 2 и 3 обрабатывают по депозиту.
        expect(reports[0].publicValues.newDepositHash).toBe(reports[0].publicValues.prevDepositHash);
        expect(reports[1].publicValues.newDepositHash).not.toBe(reports[1].publicValues.prevDepositHash);
        expect(reports[2].publicValues.newDepositHash).not.toBe(reports[2].publicValues.prevDepositHash);
    });

    it('депозиты, три батча, вывод через мост, заморозка и аварийный выход: всё обеспечено депозитами', async () => {
        const [first, second] = expected.deposits as { l2Recipient: string; amount: string }[];
        // Батч k обрабатывает то, что стояло в очереди на момент батча k−1.
        await deposit(first);
        await submitBatch(1);
        await deposit(second);
        await submitBatch(2);
        await submitBatch(3);
        const queue = await rollup.getDepositQueue();
        expect(queue.processed).toEqual(queue.head);
        expect(queue.processed.hash).toBe(BigInt(reports[2].publicValues.newDepositHash));

        // --- вывод через мост: перевод на адрес моста в блоке 3 стал листом дерева выводов ---
        const leaf = {
            leafIndex: expected.withdrawal.leafIndex as number,
            recipientHash: BigInt(expected.withdrawal.recipientHash),
            amount: BigInt(expected.withdrawal.amount),
        };
        const tree = withdrawalTree([leaf]);
        expect(tree.root).toBe(BigInt(reports[2].publicValues.withdrawalsRoot));
        const withdrawTo = new Address(0, bytes(expected.withdrawal.recipientHash));
        // Сколько каждый адрес обязан получить за весь тест (вывод и выходы могут идти одному получателю).
        const owed = new Map<string, bigint>();
        const credit = (to: Address, amount: bigint) => owed.set(to.toString(), (owed.get(to.toString()) ?? 0n) + amount);
        const sendWithdraw = async () =>
            rollup.sendWithdraw(stranger.getSender(), {
                leafIndex: leaf.leafIndex,
                recipient: withdrawTo,
                amount: leaf.amount,
                merkleProof: merkleProofCell(tree.proofFor(leaf.leafIndex)),
                value: (await rollup.getMinimumValues()).withdraw,
            });
        expect((await sendWithdraw()).transactions).toHaveTransaction({ from: rollup.address, to: withdrawTo, value: leaf.amount });
        credit(withdrawTo, leaf.amount);

        // --- секвенсор пропал: поздний депозит ждёт дольше срока, rollup замораживается ---
        const late = toNano('0.5');
        const { depositFee } = await rollup.getQueueFees();
        await rollup.sendDeposit(stranger.getSender(), { l2Recipient: 0xdeadn, value: late + depositFee, maxFee: depositFee });
        blockchain.now = START + TIMEOUT + 1;
        await rollup.sendActivateEscapeHatch(stranger.getSender(), toNano('0.05'));
        expect((await rollup.getEscapeState()).frozen).toBe(true);

        // --- аварийные выходы обоих счетов: заголовок блока 3 из данных батча и eth_getProof от Reth ---
        const header = evmNodeItems(bytes(reports[2].dataChunksHex.join('')))[0];
        expect('0x' + Buffer.from(keccak_256(header)).toString('hex')).toBe(expected.blocks[2].hash);
        const exitTo = new Address(0, bytes(expected.exitRecipientHash));
        expect(await rollup.getEvmExitConsentHash(BigInt(expected.exitRecipientHash))).toBe(BigInt(expected.consentHash));
        const exits = expected.exits as { account: string; balanceWei: string; accountProof: string[]; signature: string }[];
        expect(exits.map((exit) => exit.account)).toEqual([expected.user, second.l2Recipient]);
        const amounts = exits.map((exit) => BigInt(exit.balanceWei) / WEI_PER_NANOTON);
        // Пользователь: депозит минус перевод, вывод и газ двух транзакций (меньше 0,001 монеты).
        const spent = BigInt(expected.transferWei) / WEI_PER_NANOTON + leaf.amount;
        expect(amounts[0]).toBeLessThan(BigInt(first.amount) - spent);
        expect(amounts[0]).toBeGreaterThan(BigInt(first.amount) - spent - 1_000_000n);
        // Второй счёт только получил депозит: его баланс — ровно депозит.
        expect(amounts[1]).toBe(BigInt(second.amount));
        const sendExit = async (index: number) =>
            rollup.sendForceExitEvm(stranger.getSender(), {
                recipient: exitTo,
                header: evmHeaderCell(header),
                proof: evmProofCell(evmProofSteps(exits[index].accountProof.map(bytes))),
                signature: evmSignatureCell(evmSignatureFromHex(exits[index].signature)),
                value: (await rollup.getEvmExitBudget()).minValue,
            });
        for (const index of [0, 1]) {
            expect((await sendExit(index)).transactions).toHaveTransaction({ from: rollup.address, to: exitTo, value: amounts[index] });
            credit(exitTo, amounts[index]);
        }

        // Повтор вывода и выходов второй раз не платит (деньги на контракте ещё есть: отказ — от нуллификатора).
        expect((await sendWithdraw()).transactions).not.toHaveTransaction({ from: rollup.address, to: withdrawTo });
        for (const index of [0, 1]) {
            const again = await sendExit(index);
            expect(again.transactions).toHaveTransaction({ success: false, exitCode: NullifierErrors.alreadyClaimed });
            expect(again.transactions).not.toHaveTransaction({ from: rollup.address, to: exitTo });
        }

        // --- поздний депозит возвращается вносителю: денег хватает, потому что всё обеспечено ---
        const refund = await rollup.sendCancelDeposit(stranger.getSender(), { depositIndex: 3, value: toNano('0.05') });
        expect(refund.transactions).toHaveTransaction({ from: rollup.address, to: stranger.address, value: late });

        // Каждый получатель получил ровно своё и ни нанотоном больше (адреса новые: баланс — это и
        // есть полученное).
        const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;
        for (const address of [withdrawTo, exitTo]) expect(await balanceOf(address)).toBe(owed.get(address.toString()));

        // Грубая сверка остатка: на контракте не меньше того, что ещё числится на L2 за другими
        // счетами. Строгой она не является — на контракте лежат ещё комиссии и остатки сообщений;
        // точность даёт проверка выше.
        const remaining = BigInt(first.amount) + BigInt(second.amount) - leaf.amount - amounts[0] - amounts[1];
        expect(remaining).toBeGreaterThan(0n);
        expect(await balanceOf(rollup.address)).toBeGreaterThanOrEqual(remaining);
    });

    it('порядок очереди — часть протокола: оба депозита до батча 1 дают другой публичный вход батча 2', async () => {
        const [first, second] = expected.deposits as { l2Recipient: string; amount: string }[];
        await deposit(first);
        await deposit(second);
        await submitBatch(1);
        // Теперь батч 2 обязан обработать оба депозита, а блок 2 зачисляет один: пруф этого
        // блока контракту не подошёл бы.
        for (const data of reports[1].dataChunksHex.map((hex) => dataChunkCell(bytes(hex)))) {
            await rollup.sendPublishData(owner.getSender(), { batchIndex: 2, data, value: toNano('0.05') });
        }
        // Данные те же, что в пруфе: расходится именно очередь.
        expect(await rollup.getBatchDataHash(2)).toBe(BigInt(reports[1].publicValues.batchHash));
        const queue = await rollup.getDepositQueue();
        expect(queue.target.count).toBe(2n);
        expect(queue.target.hash).not.toBe(BigInt(reports[1].publicValues.newDepositHash));
        expect(await rollup.getExpectedPublicInput(rootsOf(reports[1]))).not.toBe(publicInputOf(reports[1].publicValuesBytes));
    });

    it('чужой аварийный выход не проходит: подпись под другого получателя', async () => {
        const [first, second] = expected.deposits as { l2Recipient: string; amount: string }[];
        await deposit(first);
        await submitBatch(1);
        await deposit(second);
        await submitBatch(2);
        await submitBatch(3);
        const { depositFee } = await rollup.getQueueFees();
        await rollup.sendDeposit(stranger.getSender(), { l2Recipient: 0xdeadn, value: toNano('0.5') + depositFee, maxFee: depositFee });
        blockchain.now = START + TIMEOUT + 1;
        await rollup.sendActivateEscapeHatch(stranger.getSender(), toNano('0.05'));
        const exit = expected.exits[0];
        const thief = await blockchain.treasury('thief');
        const result = await rollup.sendForceExitEvm(stranger.getSender(), {
            // Получатель — посторонний кошелёк, а согласие подписано под другой адрес.
            recipient: thief.address,
            header: evmHeaderCell(evmNodeItems(bytes(reports[2].dataChunksHex.join('')))[0]),
            proof: evmProofCell(evmProofSteps((exit.accountProof as string[]).map(bytes))),
            signature: evmSignatureCell(evmSignatureFromHex(exit.signature)),
            value: (await rollup.getEvmExitBudget()).minValue,
        });
        // Из такой подписи восстанавливается чужой адрес. В дереве блока 3 всего пять счетов, и
        // чем кончится проход для чужого ключа (пустой потомок или чужая ветка), зависит от
        // ключа: коды 7403 и 7404 — EvmExitErrors в evm_exit.tolk. Точные коды на каждую проверку
        // закрепляет tests/RollupEvmExit.spec.ts; здесь важно, что выплаты нет.
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false });
        expect([7403, 7404]).toContain(computePhaseOf(result.transactions, rollup.address).exitCode);
        expect(result.transactions).not.toHaveTransaction({ from: rollup.address, to: thief.address });
    });
});
