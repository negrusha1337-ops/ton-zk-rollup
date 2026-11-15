import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { readFileSync } from 'fs';
import path from 'path';
import { keccak_256 } from '@noble/hashes/sha3';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import {
    evmHeaderCell,
    evmNodeItems,
    evmProofCell,
    evmProofSteps,
    evmSignatureCell,
    evmSignatureFromHex,
} from '../wrappers/evmExit';
import { Rollup, RollupErrors, VerifierErrors } from '../wrappers/Rollup';
import { batchDataHash, withdrawalTree } from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    ESCAPE_TIMEOUT_SECONDS,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
} from '../wrappers/rollupValues';
import {
    evmProofStatus,
    loadEvmProgramKeys,
    loadEvmRollupKey,
    loadProvenEvmBatch,
    publicInputOf,
} from '../wrappers/evmProofs';
import { saveGasReport } from './helpers/benchResults';
import { computePhaseOf } from './helpers/gas';

// Лимит газа на транзакцию: конфиг сети, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;

// Блок EVM, исполненный Reth внутри SP1 (zkvm-evm/), и его Groth16-пруф проверяются настоящим
// rollup-контрактом — тем же, что принимает батчи игрушечного реестра: контракту всё равно,
// что стоит за восемью словами. Это демонстрация приёма батча, а не готовый rollup на EVM:
// ключ выхода в контракте — заглушка (выход по пруфу zkVM для состояния EVM невозможен; баланс
// обычного счёта выходит без пруфа — tests/RollupEvmExit.spec.ts), депозитов и принудительных
// транзакций в батче нет, монеты L2 в блоке — из генезиса anvil, обеспечения на L1 у них нет,
// поэтому вывод здесь не проверяется (REVIEW.md, находки 6-А, 6-Б, 9-А).
const SUITE = 'Rollup: пруф SP1 блока EVM';
const status = evmProofStatus();
if (status.current) {
    describe(SUITE, suite);
} else {
    // Пруфа для нынешней программы нет (или он от прежней версии): набор ждёт его, а не падает
    // и не проходит молча. Пруфы строятся только по команде пользователя.
    describe(SUITE, () => {
        it.todo(`ждёт пруфа SP1 блока EVM для нынешней программы (${status.reason})`);
    });
}

function suite() {
    const batch = loadProvenEvmBatch();
    const words = batch.report.publicValues;
    const genesis = BigInt(words.prevStateRoot);
    const expectedKey = loadEvmRollupKey();
    const gas: Record<string, number> = {};

    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let ready: BlockchainSnapshot;

    const submit = (overrides: { newStateRoot?: bigint; hintsBoc?: string } = {}) =>
        rollup.sendSubmitBatch(sequencer.getSender(), {
            proof: batch.proof,
            hints: Cell.fromBase64(overrides.hintsBoc ?? batch.hinted.hintsBoc),
            roots: { ...batch.roots, newStateRoot: overrides.newStateRoot ?? batch.roots.newStateRoot },
            value: SUBMIT_BATCH_VALUE,
        });
    /** Публикует блок EVM в TON: порции данных батча в том порядке, в каком их хешировала программа. */
    const publishData = async () => {
        for (const data of batch.dataChunks) {
            const result = await rollup.sendPublishData(sequencer.getSender(), {
                batchIndex: 1,
                data,
                value: PUBLISH_DATA_VALUE,
            });
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            gas.publishData = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        }
    };

    beforeAll(async () => {
        const code = await compile('Rollup');
        const nullifierCode = await compile('RollupNullifier');
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                {
                    owner: owner.address,
                    sequencer: sequencer.address,
                    nullifierCode,
                    // «Корень состояния генезиса» для EVM — хеш заголовка блока-родителя.
                    genesisStateRoot: genesis,
                    chainId: BigInt(words.chainId),
                    escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
                },
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(expectedKey.upload)) {
            const upload = await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
            expect(upload.transactions).toHaveTransaction({ to: rollup.address, success: true });
        }
        await rollup.sendSetExitKey(owner.getSender(), { ic0: expectedKey.exitIc0, value: KEY_FINALIZE_VALUE });
        const finalize = await rollup.sendFinalizeKey(owner.getSender(), {
            key: expectedKey.upload,
            value: KEY_FINALIZE_VALUE,
        });
        expect(finalize.transactions).toHaveTransaction({ to: rollup.address, success: true });
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
    });

    afterAll(() => {
        saveGasReport(
            'rollup-evm-proof.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupEvmProof.spec.ts; не редактировать вручную',
                note: 'Газ rollup-контракта с Groth16-пруфом SP1 (схема v6.1.0) блока EVM: программа zkvm-evm (Reth внутри SP1). Ключ выхода в контракте — заглушка; депозитов и принудительных транзакций в батче нет. forceExitEvmAfterBatch — выход счёта EVM без пруфа против блока, принятого этим батчем (три узла).',
                gasLimit: TX_GAS_LIMIT,
                sourcesSha256: loadEvmProgramKeys().sourcesSha256,
                blockNumber: batch.report.blockNumber,
                transactions: batch.report.transactions,
                zkvmCycles: batch.report.zkvmCycles,
            },
            gas,
            ['submitBatch', 'publishData', 'rejectedForgery', 'forceExitEvmAfterBatch'],
        );
        console.table(gas);
    });

    it('пруф построен для программы EVM, для этого блока и под ключ контракта', async () => {
        expect(await rollup.getKeyHash()).toBe(expectedKey.keyHash);
        expect(BigInt('0x' + Cell.fromBase64(batch.hinted.vkDataBoc).hash().toString('hex'))).toBe(expectedKey.keyHash);
        const [programVKey, digest, exitCode, , nonce] = batch.publicInputs;
        expect(programVKey).toBe(BigInt(loadEvmProgramKeys().programVKey));
        expect(digest).toBe(publicInputOf(batch.report.publicValuesBytes));
        expect(exitCode).toBe(0n);
        expect(nonce).toBe(0n);
        expect(await rollup.getChainId()).toBe(BigInt(words.chainId));
        // Слова состояния — хеши заголовков блоков EVM: они разные и ненулевые.
        expect(genesis).not.toBe(0n);
        expect(batch.roots.newStateRoot).not.toBe(genesis);
        // Очередь L1 у свежего контракта пуста: под это построен пруф.
        expect(BigInt(words.prevDepositHash)).toBe(0n);
        expect(BigInt(words.newDepositHash)).toBe(0n);
        expect(BigInt(words.prevWithdrawalsRoot)).toBe(0n);
    });

    it('хеш данных и корень выводов программы совпадают с тем, как их считает сторона TON', async () => {
        // Хеш данных батча программа считала в zkVM на Rust; здесь — та же раскладка ячеек на
        // TypeScript, которой пользуется секвенсор при публикации.
        expect(batchDataHash(batch.dataChunks)).toBe(BigInt(words.batchHash));
        // Выводы блока по сценарию: 0,25 и 0,1 монеты на получателей с первыми байтами 0x11 и
        // 0x22 (zkvm-evm/scenario/anvil-scenario.sh, функция recipient).
        const recipient = (first: number) =>
            BigInt('0x' + [first, ...Array.from({ length: 31 }, (_, i) => parseInt(String(i + 1).padStart(2, '0'), 16))]
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join(''));
        const leaves = [
            { leafIndex: 0, recipientHash: recipient(0x11), amount: 250_000_000n },
            { leafIndex: 1, recipientHash: recipient(0x22), amount: 100_000_000n },
        ];
        expect(withdrawalTree(leaves).root).toBe(batch.roots.withdrawalsRoot);
    });

    it('без опубликованных данных батч не принимается', async () => {
        // Хеш данных батча контракт берёт из того, что опубликовано: без публикации он нулевой,
        // публичный вход другой, и подсказки пруфа к нему не подходят (отказ на проверке наклона).
        const result = await submit();
        expect(result.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: VerifierErrors.wrongSlope,
        });
        expect(await rollup.getRollupState()).toMatchObject({ stateRoot: genesis, batchIndex: 0 });
    });

    it('блок EVM с пруфом SP1 принимается контрактом и укладывается в лимит газа', async () => {
        await publishData();
        expect(await rollup.getBatchDataHash(1)).toBe(BigInt(words.batchHash));
        expect(await rollup.getExpectedPublicInput(batch.roots)).toBe(batch.publicInputs[1]);
        const result = await submit();
        expect(result.transactions).toHaveTransaction({ from: sequencer.address, to: rollup.address, success: true });
        gas.submitBatch = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        gas.submitBatchHeadroom = TX_GAS_LIMIT - gas.submitBatch;
        expect(gas.submitBatch).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: batch.roots.newStateRoot,
            withdrawalsRoot: batch.roots.withdrawalsRoot,
            batchIndex: 1,
        });
    });

    it('«лучшая подделка»: пруф под чужой хеш блока отклоняется замыкающим равенством', async () => {
        // Подсказки посчитаны честно для ложного утверждения (другой хеш нового блока), поэтому
        // все промежуточные проверки проходят; ложно только само утверждение.
        await publishData();
        const forgery = batch.hinted.statementForgery;
        expect(forgery.alteredWord).toBe(2);
        const forgedRoot = BigInt(forgery.alteredValue);
        expect(forgedRoot).toBe(batch.roots.newStateRoot ^ 1n);
        expect(await rollup.getExpectedPublicInput({ ...batch.roots, newStateRoot: forgedRoot })).toBe(
            BigInt(forgery.input),
        );
        const result = await submit({ newStateRoot: forgedRoot, hintsBoc: forgery.hintsBoc });
        expect(result.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.wrongProof,
        });
        gas.rejectedForgery = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect(gas.rejectedForgery).toBeLessThan(TX_GAS_LIMIT);
        expect(await rollup.getRollupState()).toMatchObject({ stateRoot: genesis, batchIndex: 0 });
    });

    describe('после принятого батча счёт выходит по доказательству против того же блока', () => {
        // Сквозная связка двух половин: программа в zkVM коммитит хеш заголовка блока 2, а выход
        // счёта EVM без пруфа (contracts/rollup/evm_exit.tolk) проверяет заголовок с этим хешем и
        // дерево состояния под ним. Фикстура — zk/gen-evm-batch-exit-fixture.mjs: заголовок из
        // данных батча, узлы — из состояния после блока 2, сохранённого во входе блока 3.
        // Счёт — dev-счёт anvil, его баланс из генезиса и на L1 ничем не обеспечен (REVIEW.md,
        // 9-А): платить контракту нечем, кроме чужого депозита, — тест это и показывает.
        const exitFixture = JSON.parse(
            readFileSync(path.join(__dirname, '..', 'fixtures', 'evm_exit', 'batch2-exit.json'), 'utf8'),
        );
        const bytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex');
        const header = bytes(exitFixture.headerRlp);
        const recipient = new Address(0, bytes(exitFixture.recipientHash));
        const account = BigInt(exitFixture.account);
        // 1 нанотон = 1 gwei (EVM_WEI_PER_NANOTON в evm_exit.tolk).
        const amount = BigInt(exitFixture.balanceWei) / 1_000_000_000n;
        // Коды отказа: EvmExitErrors в contracts/rollup/evm_exit.tolk.
        const WRONG_BLOCK_HEADER = 7401;
        let user: SandboxContract<TreasuryContract>;

        const exit = (headerRlp = header) =>
            rollup.sendForceExitEvm(user.getSender(), {
                recipient,
                header: evmHeaderCell(headerRlp),
                proof: evmProofCell(evmProofSteps(exitFixture.accountProof.map(bytes))),
                signature: evmSignatureCell(evmSignatureFromHex(exitFixture.signature)),
                value: exitValue,
            });
        let exitValue: bigint;
        /** Депозит, который никто не обработал, ждёт дольше срока — rollup замораживается. */
        const freeze = async () => {
            const start = Math.floor(Date.now() / 1000);
            blockchain.now = start;
            await rollup.sendDeposit(user.getSender(), { l2Recipient: 0x1234n, value: amount + toNano('1') });
            blockchain.now = start + ESCAPE_TIMEOUT_SECONDS + 1;
            await rollup.sendActivateEscapeHatch(user.getSender(), toNano('0.05'));
            expect((await rollup.getEscapeState()).frozen).toBe(true);
        };

        beforeEach(async () => {
            user = await blockchain.treasury('user');
            exitValue = ((await rollup.getEvmExitBudget()).minValue * 11n) / 10n;
        });
        afterEach(() => {
            blockchain.now = undefined;
        });

        it('фикстура выхода — про тот самый блок, что в пруфе', () => {
            // После перезапуска сценария anvil разошлись бы и пруф, и эта фикстура: видно сразу.
            expect(BigInt(exitFixture.blockHash)).toBe(batch.roots.newStateRoot);
            expect(header.equals(evmNodeItems(Buffer.from(batch.report.dataChunksHex.join(''), 'hex'))[0])).toBe(true);
            expect(BigInt('0x' + Buffer.from(keccak_256(header)).toString('hex'))).toBe(batch.roots.newStateRoot);
            expect(amount).toBeGreaterThan(0n);
        });

        it('батч по пруфу, заморозка, выход счёта: выплата один раз', async () => {
            await publishData();
            expect((await submit()).transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await rollup.getEvmExitConsentHash(BigInt(exitFixture.recipientHash))).toBe(BigInt(exitFixture.consentHash));
            // До заморозки выхода нет.
            expect((await exit()).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.rollupNotFrozen,
            });
            await freeze();

            const result = await exit();
            expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
            gas.forceExitEvmAfterBatch = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
            expect(gas.forceExitEvmAfterBatch).toBeLessThanOrEqual((await rollup.getEvmExitBudget()).stepGas);
            expect(result.transactions).toHaveTransaction({ from: rollup.address, to: recipient, value: amount });
            expect((await blockchain.getContract(recipient)).balance).toBe(amount);

            // Заявка счёта погашена в нуллификаторе; повтор не платит. Здесь он отклоняется ещё
            // раньше — денег на вторую такую выплату у контракта нет (повтор при деньгах, до
            // отказа нуллификатора, проверяет tests/RollupEvmExit.spec.ts).
            const nullifier = await rollup.getExitNullifierAddress(account);
            expect((await blockchain.getContract(nullifier)).accountState?.type).toBe('active');
            const again = await exit();
            expect(again.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.insufficientFunds,
            });
            expect(again.transactions).not.toHaveTransaction({ from: rollup.address, to: recipient });

            // Цена необеспеченного баланса (9-А): выход оплачен депозитом вносителя, и вернуть
            // свой депозит вноситель уже не может — контракту нечем.
            const refund = await rollup.sendCancelDeposit(user.getSender(), { depositIndex: 1, value: toNano('0.05') });
            expect(refund.transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: RollupErrors.insufficientFunds,
            });
        });

        it('без принятого батча тот же выход не проходит: заголовок не тот, что в контракте', async () => {
            // Слово состояния — ещё хеш блока 1: выход привязан именно к принятому батчу.
            await freeze();
            expect((await exit()).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: WRONG_BLOCK_HEADER,
            });
        });

        it('заголовок с изменённым байтом после принятого батча отвергается', async () => {
            await publishData();
            await submit();
            await freeze();
            const altered = Buffer.from(header);
            altered[altered.length - 1] ^= 1;
            expect((await exit(altered)).transactions).toHaveTransaction({
                to: rollup.address,
                success: false,
                exitCode: WRONG_BLOCK_HEADER,
            });
        });
    });
}
