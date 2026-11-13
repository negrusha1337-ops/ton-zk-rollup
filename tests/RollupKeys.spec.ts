import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, contractAddress, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier, KeySlots, KeyUpload } from '../wrappers/Bn254Groth16Verifier';
import { Rollup, RollupConfig, RollupErrors, VerifierErrors } from '../wrappers/Rollup';
import {
    deploymentMismatches,
    loadRollupKey,
    MIN_ESCAPE_TIMEOUT_SECONDS,
    readOnchainRollup,
} from '../wrappers/rollupDeployment';
import {
    DEPLOY_VALUE,
    ESCAPE_TIMEOUT_SECONDS,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    TESTNET_ESCAPE_TIMEOUT_SECONDS,
} from '../wrappers/rollupValues';
import { saveGasReport } from './helpers/benchResults';
import { computePhaseOf } from './helpers/gas';
import { sha256Int } from '../wrappers/rollupMath';

// Ключи и развёртывание НАСТОЯЩЕГО контракта (contracts/rollup.tolk): находки второго
// круга проверки (REVIEW.md). Пруфы здесь не нужны: ключ выводится из закреплённого
// верификатора SP1 и ключей программ (fixtures/zkvm_batches/key.json, zk/gen-rollup-key.mjs).
const GENESIS_ROOT = sha256Int(1n);
const CHAIN_ID = 0x544f4e5a4bn;
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;
// Точка не на кривой y² = x³ + 3 и образующая G1.
const OFF_CURVE: [bigint, bigint] = [1n, 3n];
const GENERATOR: [bigint, bigint] = [1n, 2n];

describe('Rollup: ключи и развёртывание', () => {
    const expectedKey = loadRollupKey();
    const key = expectedKey.upload;
    let code: Cell;
    let nullifierCode: Cell;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let config: RollupConfig;
    let uploaded: BlockchainSnapshot;
    const gas: Record<string, number> = {};

    const deploy = async (overrides: Partial<RollupConfig> = {}) => {
        const custom = { ...config, ...overrides };
        const contract = blockchain.openContract(Rollup.createFromConfig(custom, code));
        await contract.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        return contract;
    };
    // Суммы сообщений — те же, что шлёт скрипт прогона в testnet (wrappers/rollupValues.ts):
    // если их перестанет хватать на газ, это всплывёт здесь, а не в сети.
    const uploadParts = async (target: SandboxContract<Rollup>, upload: KeyUpload = key) => {
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(upload)) {
            const result = await target.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
            expect(result.transactions).toHaveTransaction({ to: target.address, success: true });
            gas.uploadKeyPart = Math.max(
                gas.uploadKeyPart ?? 0,
                Number(computePhaseOf(result.transactions, target.address).gasUsed),
            );
        }
    };
    const setExitKey = (target = rollup, ic0 = expectedKey.exitIc0, from = owner) =>
        target.sendSetExitKey(from.getSender(), { ic0, value: KEY_FINALIZE_VALUE });
    const finalize = (target = rollup, upload: KeyUpload = key, from = owner) =>
        target.sendFinalizeKey(from.getSender(), { key: upload, value: KEY_FINALIZE_VALUE });
    /** Контракт, где владельцем записан посторонний: ключи в нём наш владелец зафиксировать не может. */
    const readOnchainRollupOwnedByStranger = async () => readOnchainRollup(await deploy({ owner: stranger.address }));
    const rejected = (result: { transactions: unknown }, target: SandboxContract<Rollup>, exitCode: number) =>
        expect(result.transactions).toHaveTransaction({ to: target.address, success: false, exitCode });

    beforeAll(async () => {
        code = await compile('Rollup');
        nullifierCode = await compile('RollupNullifier');
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        stranger = await blockchain.treasury('stranger');
        config = {
            owner: owner.address,
            sequencer: sequencer.address,
            nullifierCode,
            genesisStateRoot: GENESIS_ROOT,
            chainId: CHAIN_ID,
            escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
        };
        rollup = await deploy();
        await uploadParts(rollup);
        uploaded = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(uploaded);
    });

    afterAll(() => {
        saveGasReport(
            'rollup-key-gas.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupKeys.spec.ts; не редактировать вручную',
                note: 'Газ загрузки и фиксации ключа rollup-контракта (ключ SP1 v6.1.0, одна оконная таблица)',
                keyParts: Bn254Groth16Verifier.keyParts(key).length,
            },
            gas,
            ['uploadKeyPart', 'setExitKey', 'finalizeKey'],
        );
    });

    describe('ключ выводится из исходников, без пруфа', () => {
        it('после загрузки контракт сообщает ровно те хеши ключей, что посчитаны вне цепочки', async () => {
            expect(await rollup.getKeyHash()).toBe(0n);
            expect(await rollup.getExitKeyHash()).toBe(0n);
            const exitKeySet = await setExitKey();
            gas.setExitKey = Number(computePhaseOf(exitKeySet.transactions, rollup.address).gasUsed);
            const finalized = await finalize();
            expect(finalized.transactions).toHaveTransaction({ to: rollup.address, success: true });
            gas.finalizeKey = Number(computePhaseOf(finalized.transactions, rollup.address).gasUsed);
            expect(await rollup.getKeyHash()).toBe(expectedKey.keyHash);
            expect(await rollup.getExitKeyHash()).toBe(expectedKey.exitKeyHash);
            expect(expectedKey.keyHash).not.toBe(expectedKey.exitKeyHash);
            // У ключа одна оконная таблица: нонс SP1 свёрнут в IC0 и своей таблицы не имеет.
            expect(key.table1Parts).toHaveLength(0);
        });

        it('части ключа и ключ выхода читаются из данных контракта: скрипт сверяет их до фиксации', async () => {
            // До фиксации часть ключа можно перезаписать, а после — ключ неизменяем. Поэтому
            // скрипт развёртывания сверяет СОДЕРЖИМОЕ каждой части (по хешу), а не только то,
            // что часть с таким номером загружена.
            const data = async () => {
                const state = (await blockchain.getContract(rollup.address)).accountState;
                if (state?.type !== 'active' || !state.state.data) throw new Error('контракт не развёрнут');
                return state.state.data;
            };
            const expectedParts = Bn254Groth16Verifier.keyParts(key);
            const expectedHashes = new Map(expectedParts.map(({ slot, part }) => [slot, part.hash().toString('hex')]));
            expect(Rollup.uploadedKeyPartHashes(await data())).toEqual(expectedHashes);
            expect(Rollup.uploadedKeySlots(await data()).sort((a, b) => a - b)).toEqual(
                [...expectedHashes.keys()].sort((a, b) => a - b),
            );

            // Часть подменена (тот же номер, другое содержимое): по номерам всё на месте, по хешам — нет.
            const { slot } = expectedParts[0];
            await rollup.sendUploadKeyPart(owner.getSender(), {
                slot,
                part: beginCell().storeUint(0xbad, 16).endCell(),
                value: KEY_PART_VALUE,
            });
            const tampered = Rollup.uploadedKeyPartHashes(await data());
            expect(tampered.size).toBe(expectedHashes.size);
            expect(tampered.get(slot)).not.toBe(expectedHashes.get(slot));

            expect(Rollup.exitKeyIc0(await data())).toEqual([0n, 0n]);
            await setExitKey();
            expect(Rollup.exitKeyIc0(await data())).toEqual(expectedKey.exitIc0);
        });

        it('сверка развёртывания проходит для честного контракта', async () => {
            await setExitKey();
            await finalize();
            const onchain = await readOnchainRollup(rollup);
            expect(deploymentMismatches(onchain, { config, code, key: expectedKey })).toEqual([]);
            expect(onchain.deployment.nullifierCodeHash).toBe(BigInt('0x' + nullifierCode.hash().toString('hex')));
        });

        it('сверка называет каждую подмену по имени', async () => {
            // Каждое сравнение сверки проверено отдельно и точным списком: раньше тест требовал
            // лишь «расхождений больше одного», и из сверки можно было убрать почти все сравнения.
            const ADDRESS = expect.stringMatching(/^адрес/);
            /** Контракт с подменённым параметром, с зафиксированными честными ключами. */
            const deployedWith = async (overrides: Partial<RollupConfig>) => {
                const other = await deploy(overrides);
                await uploadParts(other);
                await setExitKey(other);
                expect((await finalize(other)).transactions).toHaveTransaction({ to: other.address, success: true });
                return readOnchainRollup(other);
            };
            const check = (onchain: Awaited<ReturnType<typeof readOnchainRollup>>) =>
                deploymentMismatches(onchain, { config, code, key: expectedKey });

            // Параметры развёртывания: расходится и адрес, и само поле.
            const fakeNullifier = beginCell().storeUint(0xdead, 16).endCell();
            expect(check(await deployedWith({ sequencer: stranger.address }))).toEqual([ADDRESS, 'секвенсор не тот']);
            expect(check(await readOnchainRollupOwnedByStranger())).toEqual([
                ADDRESS,
                'владелец не тот',
                'ключ не зафиксирован: rollup ещё не принимает депозиты',
            ]);
            expect(check(await deployedWith({ chainId: CHAIN_ID + 1n }))).toEqual([ADDRESS, 'chainId не тот']);
            expect(check(await deployedWith({ escapeTimeout: ESCAPE_TIMEOUT_SECONDS - 1 }))).toEqual([
                ADDRESS,
                'срок заморозки не тот',
            ]);
            expect(check(await deployedWith({ nullifierCode: fakeNullifier }))).toEqual([
                ADDRESS,
                'код нуллификатора не тот',
            ]);
            // Другой генезис get-методы не показывают вовсе — только адрес.
            expect(check(await deployedWith({ genesisStateRoot: GENESIS_ROOT + 1n }))).toEqual([ADDRESS]);

            // Ключи: параметры развёртывания и адрес те же — ловится только сверкой хешей.
            const snapshot = blockchain.snapshot();
            await setExitKey(rollup, GENERATOR);
            await finalize();
            expect(check(await readOnchainRollup(rollup))).toEqual(['ключ программы выхода не тот']);

            await blockchain.loadFrom(snapshot);
            await setExitKey();
            // Владелец зафиксировал ключ другой программы батчей: IC0 чужой, остальное то же.
            await finalize(rollup, { ...key, ic0: GENERATOR });
            expect(check(await readOnchainRollup(rollup))).toEqual(['ключ программы батчей не тот']);

            await blockchain.loadFrom(snapshot);
            expect(check(await readOnchainRollup(rollup))).toEqual([
                'ключ не зафиксирован: rollup ещё не принимает депозиты',
            ]);
        });

        it('подложенный в начальные данные корень выводов виден только по адресу', async () => {
            // Развёртывающий подкладывает в начальные данные корень дерева выводов с листом в
            // свою пользу, а дальше ведёт себя честно: те же параметры, те же ключи.
            // Get-методы deployment, keyHash и exitKeyHash у такого контракта безупречны —
            // подмену показывает только адрес, который не выводится из канонических данных.
            const canonical = Rollup.createFromConfig(config, code);
            const data = canonical.init!.data.beginParse();
            const head = data.loadBits(data.remainingBits);
            const [keys, nullifier, state] = [data.loadRef(), data.loadRef(), data.loadRef()];
            const stateSlice = state.beginParse();
            const stateRoot = stateSlice.loadUintBig(256);
            expect(stateSlice.loadUintBig(256)).toBe(0n); // честный корень выводов: ноль
            const plantedRoot = sha256Int(0xbadn);
            const planted = beginCell().storeUint(stateRoot, 256).storeUint(plantedRoot, 256).storeSlice(stateSlice);
            const tampered = beginCell()
                .storeBits(head)
                .storeRef(keys)
                .storeRef(nullifier)
                .storeRef(planted.endCell())
                .endCell();
            const init = { code, data: tampered };
            const fake = blockchain.openContract(new Rollup(contractAddress(0, init), init));
            await fake.sendDeploy(owner.getSender(), DEPLOY_VALUE);
            await uploadParts(fake);
            await setExitKey(fake);
            expect((await finalize(fake)).transactions).toHaveTransaction({ to: fake.address, success: true });
            expect((await fake.getRollupState()).withdrawalsRoot).toBe(plantedRoot);

            const problems = deploymentMismatches(await readOnchainRollup(fake), { config, code, key: expectedKey });
            expect(problems).toHaveLength(1);
            expect(problems[0].startsWith('адрес')).toBe(true);
        });
    });

    describe('фиксация ключа', () => {
        it('без ключа выхода ключ не фиксируется', async () => {
            rejected(await finalize(), rollup, RollupErrors.exitKeyNotSet);
            expect(await rollup.getKeyHash()).toBe(0n);
        });

        it('ключи задаёт только владелец', async () => {
            rejected(await setExitKey(rollup, expectedKey.exitIc0, stranger), rollup, RollupErrors.notOwner);
            await setExitKey();
            rejected(await finalize(rollup, key, stranger), rollup, RollupErrors.notOwner);
            rejected(await finalize(rollup, key, sequencer), rollup, RollupErrors.notOwner);
            const part = await rollup.sendUploadKeyPart(stranger.getSender(), {
                slot: KeySlots.fixedLines,
                part: beginCell().endCell(),
                value: KEY_PART_VALUE,
            });
            rejected(part, rollup, RollupErrors.notOwner);
            expect(await rollup.getKeyHash()).toBe(0n);
        });

        it('ключ выхода — точка на кривой, задаётся один раз', async () => {
            rejected(await setExitKey(rollup, OFF_CURVE), rollup, RollupErrors.badKeyPoint);
            rejected(await setExitKey(rollup, [0n, 0n]), rollup, RollupErrors.badKeyPoint);
            const exitKeyIsSet = async () => {
                const state = (await blockchain.getContract(rollup.address)).accountState;
                if (state?.type !== 'active' || !state.state.data) throw new Error('контракт не развёрнут');
                return Rollup.isExitKeySet(state.state.data);
            };
            expect(await exitKeyIsSet()).toBe(false);
            expect((await setExitKey()).transactions).toHaveTransaction({ to: rollup.address, success: true });
            expect(await exitKeyIsSet()).toBe(true);
            rejected(await setExitKey(rollup, GENERATOR), rollup, RollupErrors.keyAlreadyFinalized);
        });

        it('IC0 ключа батчей — точка на кривой', async () => {
            await setExitKey();
            rejected(await finalize(rollup, { ...key, ic0: OFF_CURVE }), rollup, RollupErrors.badKeyPoint);
            expect(await rollup.getKeyHash()).toBe(0n);
        });

        it('ключ со второй оконной таблицей не фиксируется: проверить её было бы нечем', async () => {
            await setExitKey();
            // Вторая таблица (для нонса SP1) загружена и заявлена: ни один пруф с нулевым
            // нонсом её не тронул бы, а подменённая таблица позволила бы подобрать нонсом
            // любой дайджест. Контракт таких ключей не принимает вовсе.
            const extra = key.table0Parts[0];
            await rollup.sendUploadKeyPart(owner.getSender(), { slot: KeySlots.table1, part: extra, value: KEY_PART_VALUE });
            rejected(
                await finalize(rollup, { ...key, table1Parts: [extra] }),
                rollup,
                VerifierErrors.badKeyPart,
            );
            expect(await rollup.getKeyHash()).toBe(0n);
        });

        it('без загруженной части ключ не собирается', async () => {
            const partial = await deploy({ genesisStateRoot: GENESIS_ROOT + 1n });
            for (const { slot, part } of Bn254Groth16Verifier.keyParts(key).slice(1)) {
                await partial.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
            }
            await setExitKey(partial);
            rejected(await finalize(partial), partial, VerifierErrors.badKeyPart);
        });

        it('после фиксации ключи неизменяемы', async () => {
            await setExitKey();
            await finalize();
            rejected(await finalize(), rollup, RollupErrors.keyAlreadyFinalized);
            rejected(await setExitKey(rollup, GENERATOR), rollup, RollupErrors.keyAlreadyFinalized);
            const part = await rollup.sendUploadKeyPart(owner.getSender(), {
                slot: KeySlots.table0,
                part: beginCell().endCell(),
                value: KEY_PART_VALUE,
            });
            rejected(part, rollup, RollupErrors.keyAlreadyFinalized);
            expect(await rollup.getKeyHash()).toBe(expectedKey.keyHash);
            expect(await rollup.getExitKeyHash()).toBe(expectedKey.exitKeyHash);
        });
    });

    describe('срок заморозки', () => {
        it('с тестовым сроком в минуты rollup не начинает работу', async () => {
            // Срок короче MIN_ESCAPE_TIMEOUT: ключи не фиксируются, а без ключей контракт не
            // принимает ни депозиты, ни принудительные транзакции. Деньги в такой rollup не попадут.
            const short = await deploy({ escapeTimeout: MIN_ESCAPE_TIMEOUT_SECONDS - 1 });
            await uploadParts(short);
            await setExitKey(short);
            rejected(await finalize(short), short, RollupErrors.badDeployment);
            expect(await short.getKeyHash()).toBe(0n);
            const deposit = await short.sendDeposit(stranger.getSender(), {
                l2Recipient: L2_RECIPIENT,
                value: toNano('1'),
            });
            rejected(deposit, short, RollupErrors.keyNotFinalized);
            expect(deposit.transactions).toHaveTransaction({
                from: short.address,
                to: stranger.address,
                inMessageBounced: true,
            });
        });

        it('наименьший допустимый срок принимается; срок для testnet не меньше него', async () => {
            const edge = await deploy({ escapeTimeout: MIN_ESCAPE_TIMEOUT_SECONDS });
            await uploadParts(edge);
            await setExitKey(edge);
            expect((await finalize(edge)).transactions).toHaveTransaction({ to: edge.address, success: true });
            expect(TESTNET_ESCAPE_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(MIN_ESCAPE_TIMEOUT_SECONDS);
        });
    });
});
