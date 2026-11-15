import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { readFileSync } from 'fs';
import path from 'path';
import { Address, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { PlantedState, Rollup, RollupConfig, RollupErrors } from '../wrappers/Rollup';
import {
    deploymentMismatches,
    MIN_ESCAPE_TIMEOUT_SECONDS,
    MIN_MAX_BLOCK_AGE_SECONDS,
    readOnchainRollup,
} from '../wrappers/rollupDeployment';
import { ProtocolConstants, readProtocolConstants, sendDummyKeys, testConfig } from './helpers/rollupSetup';

// Начальное состояние и параметры развёртывания (PROTOCOL-V2.md, 0.3 и 0.4): контракт не может
// проверить собственные начальные данные при развёртывании, но отказывается фиксировать ключ —
// то есть начинать работу — если они не канонические. Без ключа нет ни депозитов, ни батчей.
// На двойнике: проверки фиксации ключа — общий код (contracts/rollup/logic.tolk).
const CHAIN_ID = 4242n;
const TIMEOUT = 7200;

describe('Rollup: генезис и параметры развёртывания', () => {
    let code: Cell;
    let nullifierCode: Cell;
    let constants: ProtocolConstants;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let config: RollupConfig;

    const deploy = async (overrides: Partial<RollupConfig> = {}, planted?: PlantedState) => {
        const full = { ...config, ...overrides };
        const rollup = blockchain.openContract(
            planted ? Rollup.createPlanted(full, planted, code) : Rollup.createFromConfig(full, code),
        );
        await rollup.sendDeploy(owner.getSender(), toNano('1'));
        return rollup;
    };
    /** FinalizeKey отказал с этим кодом; ключ не зафиксирован, депозит не принимается. */
    const refusesToStart = async (rollup: SandboxContract<Rollup>, exitCode: number) => {
        const result = await sendDummyKeys(rollup, owner);
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode });
        expect(await rollup.getKeyHash()).toBe(0n);
        const deposit = await rollup.sendDeposit(user.getSender(), { l2Recipient: 1n, value: toNano('1') });
        expect(deposit.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.keyNotFinalized,
        });
    };
    const starts = async (rollup: SandboxContract<Rollup>) => {
        const result = await sendDummyKeys(rollup, owner);
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect(await rollup.getKeyHash()).not.toBe(0n);
    };

    beforeAll(async () => {
        code = await compile('RollupMock');
        nullifierCode = await compile('RollupNullifier');
        constants = await readProtocolConstants(code, nullifierCode);
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        user = await blockchain.treasury('user');
        config = testConfig(constants, {
            owner: owner.address,
            sequencer: owner.address,
            nullifierCode,
            chainId: CHAIN_ID,
            escapeTimeout: TIMEOUT,
            maxBlockAge: 3600,
        });
    });

    it('каноническое развёртывание с генезисом протокола начинает работу', async () => {
        const rollup = await deploy();
        expect(constants.protocolVersion).toBe(2);
        expect((await rollup.getRollupState()).stateRoot).toBe(constants.genesisHash);
        expect(constants.genesisHash).not.toBe(0n);
        await starts(rollup);
        const deposit = await rollup.sendDeposit(user.getSender(), { l2Recipient: 1n, value: toNano('1') });
        expect(deposit.transactions).toHaveTransaction({ to: rollup.address, success: true });
    });

    it('константы контракта — те же, что у цепочки узла Reth и у программы zkVM', () => {
        // Хеш заголовка генезиса: контракт сверяет с константой начальное слово состояния, а
        // цепочка L2 начинается с генезиса, хеш которого узел Reth сообщил сценарию. Они обязаны
        // совпасть — иначе первый же батч настоящей цепочки не продолжил бы состояние контракта.
        const fixtures = path.join(__dirname, '..', 'fixtures', 'evm_batches');
        const chain = JSON.parse(readFileSync(path.join(fixtures, 'reth', 'expected.json'), 'utf8'));
        const vectors = JSON.parse(readFileSync(path.join(fixtures, 'protocol-vectors.json'), 'utf8'));
        expect(constants.genesisHash).toBe(BigInt(chain.genesisHash));
        expect(chain.genesisHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(chain.blocks[0].parentHash).toBe(chain.genesisHash);
        expect(constants.protocolVersion).toBe(chain.protocolVersion);
        // Пределы, которые обязаны совпадать у контракта и программы (векторы пишет тест на Rust).
        expect(constants.maxBatchQueueItems).toBe(vectors.constants.maxBatchQueueItems);
        expect(constants.maxForcedTxBytes).toBe(vectors.constants.forcedTxMaxBytes);
        // Сумма депозита на L2 держится программой в 64 битах.
        expect(constants.depositAmountLimit).toBe(1n << 64n);
    });

    it('генезис не тот — ключ не фиксируется', async () => {
        // Генезис с заранее вписанным счётом позволил бы его владельцу вывести чужие депозиты.
        // Хеш заголовка генезиса — константа протокола в коде контракта.
        for (const genesisStateRoot of [constants.genesisHash + 1n, constants.genesisHash ^ (1n << 255n), 0n]) {
            await refusesToStart(await deploy({ genesisStateRoot }), RollupErrors.badGenesis);
        }
    });

    it.each<[string, PlantedState]>([
        ['ненулевой корень выводов', { withdrawalsRoot: 1n }],
        ['ненулевой счётчик выводов', { withdrawalsCount: 1n }],
        ['номер батча не ноль', { batchIndex: 1n }],
        ['в очереди уже есть элементы', { queue: { head: { count: 1n, hash: 0n } } }],
        ['хеш очереди не ноль', { queue: { head: { count: 0n, hash: 1n } } }],
        ['отметка обработанного не ноль', { queue: { processed: { count: 1n, hash: 0n } } }],
        ['хеш обработанного не ноль', { queue: { processed: { count: 0n, hash: 1n } } }],
        ['счётчик убранных записей не ноль', { queue: { prunedCount: 1n } }],
        [
            'в словаре очереди есть запись',
            {
                queueItems: (() => {
                    const items = Rollup.queueItemsDictionary();
                    items.set(1n, { hashBefore: 0n, queuedAt: 1, receipt: null });
                    return items;
                })(),
            },
        ],
        [
            // Долг выплачивается сообщением PayOwed кому угодно из записи — то есть из чужих
            // депозитов (REVIEW.md, 14-3).
            'в словаре долгов есть запись',
            {
                owed: (() => {
                    const owed = Rollup.owedDictionary();
                    owed.set(7n, { recipient: new Address(0, Buffer.alloc(32, 7)), amount: toNano('1000') });
                    return owed;
                })(),
            },
        ],
        [
            // Хеш данных для первого батча вошёл бы в его публичный вход.
            'в словаре данных батчей есть запись',
            {
                pendingData: (() => {
                    const pending = Rollup.pendingDataDictionary();
                    pending.set(1n, 1n);
                    return pending;
                })(),
            },
        ],
    ])('подложенное начальное состояние (%s) — ключ не фиксируется', async (_, planted) => {
        // Каждое из этих состояний — заготовка кражи или остановки: лист в дереве выводов в свою
        // пользу, «уже обработанная» очередь, запись с чужой квитанцией для возврата депозита.
        await refusesToStart(await deploy({}, planted), RollupErrors.badGenesis);
    });

    it('раскладка состояния в обёртке — та же, что в контракте: каждое подложенное поле читается на своём месте', async () => {
        // Подложенные состояния строит обёртка (Rollup.buildData), а читает их контракт. Если
        // порядок или ширина полей разойдутся, тесты на подложенных состояниях будут проверять
        // не то, что написано, — и могут проходить по случайности. Здесь все поля разные и
        // ненулевые, а читаются get-методами контракта, по именам.
        const depositor = new Address(0, Buffer.alloc(32, 0xd1));
        const debtor = new Address(0, Buffer.alloc(32, 0xd2));
        const queueItems = Rollup.queueItemsDictionary();
        queueItems.set(12n, { hashBefore: 0xaa01n, queuedAt: 1_700_000_123, receipt: { depositor, amount: 777n } });
        queueItems.set(13n, { hashBefore: 0xaa02n, queuedAt: 1_700_000_456, receipt: null });
        const pendingData = Rollup.pendingDataDictionary();
        pendingData.set(8n, 0xbb01n);
        const owed = Rollup.owedDictionary();
        owed.set(0xcc01n, { recipient: debtor, amount: 555n });
        const rollup = await deploy(
            { genesisStateRoot: 0x1001n },
            {
                withdrawalsRoot: 0x1002n,
                withdrawalsCount: 3n,
                batchIndex: 7n,
                queue: { head: { count: 13n, hash: 0x1003n }, processed: { count: 11n, hash: 0x1004n }, prunedCount: 9n },
                queueItems,
                pendingData,
                owed,
                frozen: true,
            },
        );
        expect(await rollup.getRollupState()).toEqual({
            stateRoot: 0x1001n,
            withdrawalsRoot: 0x1002n,
            batchIndex: 7,
            withdrawalsCount: 3n,
        });
        expect(await rollup.getDepositQueue()).toEqual({
            head: { count: 13n, hash: 0x1003n },
            processed: { count: 11n, hash: 0x1004n },
            prunedCount: 9n,
        });
        expect(await rollup.getQueueItem(12)).toEqual({ hashBefore: 0xaa01n, queuedAt: 1_700_000_123 });
        expect(await rollup.getQueueItem(13)).toEqual({ hashBefore: 0xaa02n, queuedAt: 1_700_000_456 });
        const receipt = await rollup.getDepositReceipt(12);
        expect(receipt?.depositor.equals(depositor)).toBe(true);
        expect(receipt?.amount).toBe(777n);
        expect(await rollup.getDepositReceipt(13)).toBeNull();
        expect(await rollup.getBatchDataHash(8)).toBe(0xbb01n);
        expect(await rollup.getBatchDataHash(7)).toBe(0n);
        const debt = await rollup.getOwedPayout(0xcc01n);
        expect(debt?.recipient.equals(debtor)).toBe(true);
        expect(debt?.amount).toBe(555n);
        // Срок считается от записи элемента processed + 1.
        expect(await rollup.getEscapeState()).toEqual({ frozen: true, oldestPendingAt: 1_700_000_123, timeout: TIMEOUT });
        const deployment = await rollup.getDeployment();
        expect(deployment.chainId).toBe(CHAIN_ID);
        expect(deployment.escapeTimeout).toBe(TIMEOUT);
        expect(deployment.maxBlockAge).toBe(3600);

        // Три словаря и признак заморозки занимают по одному биту подряд: когда все четыре бита
        // равны, перестановка соседних полей не видна. Поэтому ещё два состояния, где биты
        // чередуются: «данные есть, очереди нет, заморожен, долгов нет» и наоборот.
        const pattern = async (first: boolean) => {
            const planted = await deploy(
                { genesisStateRoot: first ? 0x2001n : 0x2002n },
                {
                    pendingData: first ? pendingData : undefined,
                    queueItems: first ? undefined : queueItems,
                    frozen: first,
                    owed: first ? undefined : owed,
                },
            );
            expect((await planted.getBatchDataHash(8)) !== 0n).toBe(first);
            expect((await planted.getQueueItem(12)) !== null).toBe(!first);
            expect((await planted.getEscapeState()).frozen).toBe(first);
            expect((await planted.getOwedPayout(0xcc01n)) !== null).toBe(!first);
        };
        await pattern(true);
        await pattern(false);
    });

    it('срок заморозки меньше наименьшего — ключ не фиксируется; ровно наименьший — годится', async () => {
        const minimum = constants.minEscapeTimeout;
        expect(minimum).toBe(MIN_ESCAPE_TIMEOUT_SECONDS);
        await refusesToStart(
            await deploy({ escapeTimeout: minimum - 1, maxBlockAge: constants.minMaxBlockAge }),
            RollupErrors.badDeployment,
        );
        await starts(await deploy({ escapeTimeout: minimum, maxBlockAge: constants.minMaxBlockAge }));
    });

    it('возраст блока: не меньше получаса и не больше срока заморозки — по секунде с обеих сторон', async () => {
        const minimum = constants.minMaxBlockAge;
        expect(minimum).toBe(MIN_MAX_BLOCK_AGE_SECONDS);
        expect(minimum).toBe(1800);
        await refusesToStart(await deploy({ maxBlockAge: minimum - 1 }), RollupErrors.badDeployment);
        await refusesToStart(await deploy({ maxBlockAge: 0 }), RollupErrors.badDeployment);
        await starts(await deploy({ maxBlockAge: minimum }));
        await refusesToStart(await deploy({ maxBlockAge: TIMEOUT + 1 }), RollupErrors.badDeployment);
        await starts(await deploy({ maxBlockAge: TIMEOUT }));
    });

    it('зафиксировать ключ может только владелец и только один раз', async () => {
        const rollup = await deploy();
        const stranger = await sendDummyKeys(rollup, user);
        expect(stranger.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.notOwner,
        });
        await starts(rollup);
        const again = await sendDummyKeys(rollup, owner);
        expect(again.transactions).toHaveTransaction({
            to: rollup.address,
            success: false,
            exitCode: RollupErrors.keyAlreadyFinalized,
        });
    });

    describe('сверка развёртывания вне контракта', () => {
        const mismatches = async (rollup: SandboxContract<Rollup>, expected: RollupConfig = config) =>
            deploymentMismatches(await readOnchainRollup(rollup), {
                config: expected,
                code,
                key: { keyHash: await rollup.getKeyHash() },
            });

        it('каноническое развёртывание сходится; контракт сообщает возраст блока и генезис', async () => {
            const rollup = await deploy();
            await starts(rollup);
            const onchain = await readOnchainRollup(rollup);
            expect(onchain.protocolVersion).toBe(2);
            expect(onchain.genesisHash).toBe(constants.genesisHash);
            expect(onchain.deployment.maxBlockAge).toBe(3600);
            expect(onchain.deployment.escapeTimeout).toBe(TIMEOUT);
            expect(await mismatches(rollup)).toEqual([]);
        });

        it('другой возраст блока, подложенное состояние и чужой генезис сверка замечает', async () => {
            const rollup = await deploy();
            await starts(rollup);
            const otherAge = await mismatches(rollup, { ...config, maxBlockAge: 1800 });
            expect(otherAge).toContain('наибольший возраст блока не тот');
            expect(otherAge.some((problem) => problem.includes('не выводится из ожидаемых кода и параметров'))).toBe(true);

            // Подложенное состояние с тем же генезисом: адрес не выводится из канонических данных.
            const planted = await deploy({}, { withdrawalsRoot: 1n });
            const plantedProblems = await mismatches(planted);
            expect(plantedProblems.some((problem) => problem.includes('не выводится из ожидаемых кода и параметров'))).toBe(true);
            expect(plantedProblems).toContain('ключ не зафиксирован: rollup ещё не принимает депозиты');

            // Проверяющий, которому назвали не тот генезис: адрес сойдётся, константа — нет.
            const genesisStateRoot = constants.genesisHash + 1n;
            const wrongGenesis = await deploy({ genesisStateRoot });
            expect(await mismatches(wrongGenesis, { ...config, genesisStateRoot })).toEqual([
                'начальное слово состояния — не хеш генезиса протокола',
                'ключ не зафиксирован: rollup ещё не принимает депозиты',
            ]);
        });
    });
});
