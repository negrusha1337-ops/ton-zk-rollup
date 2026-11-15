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
import { Rollup } from '../wrappers/Rollup';
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

describe('Rollup: полный цикл на блоках узла Reth', () => {
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
        const withdraw = await rollup.sendWithdraw(stranger.getSender(), {
            leafIndex: leaf.leafIndex,
            recipient: withdrawTo,
            amount: leaf.amount,
            merkleProof: merkleProofCell(tree.proofFor(leaf.leafIndex)),
            value: (await rollup.getMinimumValues()).withdraw,
        });
        expect(withdraw.transactions).toHaveTransaction({ from: rollup.address, to: withdrawTo, value: leaf.amount });

        // --- секвенсор пропал: поздний депозит ждёт дольше срока, rollup замораживается ---
        const late = toNano('0.5');
        const { depositFee } = await rollup.getQueueFees();
        await rollup.sendDeposit(stranger.getSender(), { l2Recipient: 0xdeadn, value: late + depositFee, maxFee: depositFee });
        blockchain.now = START + TIMEOUT + 1;
        await rollup.sendActivateEscapeHatch(stranger.getSender(), toNano('0.05'));
        expect((await rollup.getEscapeState()).frozen).toBe(true);

        // --- аварийный выход пользователя: заголовок блока 3 из данных батча и eth_getProof от Reth ---
        const exit = expected.exit;
        const header = evmNodeItems(bytes(reports[2].dataChunksHex.join('')))[0];
        expect('0x' + Buffer.from(keccak_256(header)).toString('hex')).toBe(expected.blocks[2].hash);
        expect(exit.account).toBe(expected.user);
        const exitTo = new Address(0, bytes(exit.recipientHash));
        const exitAmount = BigInt(exit.balanceWei) / WEI_PER_NANOTON;
        // Баланс пользователя — его депозит минус перевод, вывод и газ двух транзакций.
        expect(exitAmount).toBeLessThan(BigInt(first.amount) - leaf.amount - 100_000_000n);
        expect(exitAmount).toBeGreaterThan(BigInt(first.amount) - leaf.amount - 100_000_000n - 1_000_000n);
        expect(await rollup.getEvmExitConsentHash(BigInt(exit.recipientHash))).toBe(BigInt(exit.consentHash));
        const exited = await rollup.sendForceExitEvm(stranger.getSender(), {
            recipient: exitTo,
            header: evmHeaderCell(header),
            proof: evmProofCell(evmProofSteps((exit.accountProof as string[]).map(bytes))),
            signature: evmSignatureCell(evmSignatureFromHex(exit.signature)),
            value: (await rollup.getEvmExitBudget()).minValue,
        });
        expect(exited.transactions).toHaveTransaction({ from: rollup.address, to: exitTo, value: exitAmount });

        // --- поздний депозит возвращается вносителю: денег хватает, потому что всё обеспечено ---
        const refund = await rollup.sendCancelDeposit(stranger.getSender(), { depositIndex: 3, value: toNano('0.05') });
        expect(refund.transactions).toHaveTransaction({ from: rollup.address, to: stranger.address, value: late });

        // Каждый получатель получил ровно свою сумму и ни нанотоном больше (адреса новые: баланс —
        // это и есть полученное), а повтор вывода и выхода второй раз не платит.
        const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;
        expect(await balanceOf(withdrawTo)).toBe(leaf.amount);
        expect(await balanceOf(exitTo)).toBe(exitAmount);
        const withdrawAgain = await rollup.sendWithdraw(stranger.getSender(), {
            leafIndex: leaf.leafIndex,
            recipient: withdrawTo,
            amount: leaf.amount,
            merkleProof: merkleProofCell(tree.proofFor(leaf.leafIndex)),
            value: (await rollup.getMinimumValues()).withdraw,
        });
        expect(withdrawAgain.transactions).not.toHaveTransaction({ from: rollup.address, to: withdrawTo });
        const exitAgain = await rollup.sendForceExitEvm(stranger.getSender(), {
            recipient: exitTo,
            header: evmHeaderCell(header),
            proof: evmProofCell(evmProofSteps((exit.accountProof as string[]).map(bytes))),
            signature: evmSignatureCell(evmSignatureFromHex(exit.signature)),
            value: (await rollup.getEvmExitBudget()).minValue,
        });
        expect(exitAgain.transactions).not.toHaveTransaction({ from: rollup.address, to: exitTo });
        expect(await balanceOf(withdrawTo)).toBe(leaf.amount);
        expect(await balanceOf(exitTo)).toBe(exitAmount);

        // Грубая сверка остатка: на контракте не меньше того, что ещё числится на L2 за другими
        // счетами. Строгой она не является — на контракте лежат ещё комиссии и остатки сообщений;
        // точность даёт проверка выше: каждая выплата — ровно своя сумма и один раз.
        const remaining = BigInt(first.amount) + BigInt(second.amount) - leaf.amount - exitAmount;
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
        const exit = expected.exit;
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
