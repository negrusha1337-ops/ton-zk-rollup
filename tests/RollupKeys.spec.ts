import { spawnSync } from 'child_process';
import path from 'path';
import { Blockchain, BlockchainSnapshot, createShardAccount, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Bn254Groth16Verifier, KeySlots, KeyUpload } from '../wrappers/Bn254Groth16Verifier';
import { currentEvmSourcesSha256, loadEvmProgramKeys, loadEvmRollupKey, loadRethExpected } from '../wrappers/evmProofs';
import { PROTOCOL_VERSION } from '../wrappers/protocolVersion';
import { PlantedState, Rollup, RollupConfig, RollupErrors, RollupOpcodes, VerifierErrors } from '../wrappers/Rollup';
import { deploymentMismatches, readOnchainRollup } from '../wrappers/rollupDeployment';
import { forcedTransactionCell, sha256Int } from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    ESCAPE_TIMEOUT_SECONDS,
    FORCE_TRANSACTION_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    MAX_BLOCK_AGE_SECONDS,
    SUBMIT_BATCH_VALUE,
    TESTNET_ESCAPE_TIMEOUT_SECONDS,
    TESTNET_MAX_BLOCK_AGE_SECONDS,
} from '../wrappers/rollupValues';
import { saveGasReport } from './helpers/benchResults';
import { computePhaseOf } from './helpers/gas';
import { batchRoots, mockProof, ProtocolConstants, readProtocolConstants } from './helpers/rollupSetup';

// Ключи и развёртывание НАСТОЯЩЕГО контракта протокола v2 (contracts/rollup.tolk). Пруфы здесь
// не нужны: ключ программы батча EVM выводится из закреплённого верификатора SP1 и ключа
// программы (fixtures/evm_batches/key.json, zk/gen-evm-rollup-key.mjs). Ключа программы выхода
// в протоколе v2 нет — шага SetExitKey больше нет.
//
// Защиты загрузки и фиксации ключа — общий код с двойником (contracts/rollup/logic.tolk), но
// исполняются здесь на настоящей точке входа: до круга 14 ни один действующий тест этого не делал.
const expectedChain = loadRethExpected();
const CHAIN_ID = BigInt(expectedChain.chainId);
const L2_RECIPIENT = 0x1234567890abcdef1234567890abcdef12345678n;
// Точка не на кривой y² = x³ + 3 и образующая G1.
const OFF_CURVE: [bigint, bigint] = [1n, 3n];
const GENERATOR: [bigint, bigint] = [1n, 2n];
/** Опкоды сообщений протокола v1, которых в v2 нет: ForceExit и SetExitKey. */
const REMOVED_OPCODES = [0x52420007, 0x52420009];

describe('Rollup: ключи и развёртывание на настоящем контракте', () => {
    const expectedKey = loadEvmRollupKey();
    const key = expectedKey.upload;
    let code: Cell;
    let nullifierCode: Cell;
    let constants: ProtocolConstants;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let sequencer: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let config: RollupConfig;
    let uploaded: BlockchainSnapshot;
    const gas: Record<string, number> = {};

    const deploy = async (overrides: Partial<RollupConfig> = {}, planted?: PlantedState) => {
        const custom = { ...config, ...overrides };
        const contract = blockchain.openContract(
            planted ? Rollup.createPlanted(custom, planted, code) : Rollup.createFromConfig(custom, code),
        );
        await contract.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        return contract;
    };
    // Суммы сообщений — те же, что шлёт развёртывание в testnet (wrappers/rollupValues.ts):
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
    const finalize = (target = rollup, upload: KeyUpload = key, from = owner) =>
        target.sendFinalizeKey(from.getSender(), { key: upload, value: KEY_FINALIZE_VALUE });
    const rejected = (result: { transactions: unknown }, target: SandboxContract<Rollup>, exitCode: number) =>
        expect(result.transactions).toHaveTransaction({ to: target.address, success: false, exitCode });
    const accepted = (result: { transactions: unknown }, target: SandboxContract<Rollup>) =>
        expect(result.transactions).toHaveTransaction({ to: target.address, success: true });
    const dataOf = async (target = rollup) => {
        const state = (await blockchain.getContract(target.address)).accountState;
        if (state?.type !== 'active' || !state.state.data) throw new Error('контракт не развёрнут');
        return state.state.data;
    };
    /** Контракт с подменённым параметром и загруженными честными частями ключа. */
    const uploadedWith = async (overrides: Partial<RollupConfig>, planted?: PlantedState) => {
        const other = await deploy(overrides, planted);
        await uploadParts(other);
        return other;
    };
    const check = (onchain: Awaited<ReturnType<typeof readOnchainRollup>>, expected: RollupConfig = config) =>
        deploymentMismatches(onchain, { config: expected, code, key: expectedKey });

    beforeAll(async () => {
        code = await compile('Rollup');
        nullifierCode = await compile('RollupNullifier');
        constants = await readProtocolConstants(code, nullifierCode);
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        sequencer = await blockchain.treasury('sequencer');
        stranger = await blockchain.treasury('stranger');
        config = {
            owner: owner.address,
            sequencer: sequencer.address,
            nullifierCode,
            // Ожидаемый генезис — у цепочки L2, не у контракта: сверка развёртывания сравнивает
            // с ним константу кода (тест ниже проверяет, что они совпадают).
            genesisStateRoot: BigInt(expectedChain.genesisHash),
            chainId: CHAIN_ID,
            escapeTimeout: ESCAPE_TIMEOUT_SECONDS,
            maxBlockAge: MAX_BLOCK_AGE_SECONDS,
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
                source: 'Измерено в @ton/sandbox тестом tests/RollupKeys.spec.ts на настоящем контракте; не редактировать вручную',
                note: 'Газ загрузки и фиксации ключа rollup-контракта протокола v2 (ключ программы батча EVM, SP1 v6.1.0, одна оконная таблица). Ключа программы выхода в протоколе нет. uploadKeyPart — наибольший по частям.',
                keyParts: Bn254Groth16Verifier.keyParts(key).length,
                programVKey: expectedKey.file.programVKey,
            },
            gas,
            ['uploadKeyPart', 'finalizeKey'],
        );
    });

    describe('ключ выводится из исходников, без пруфа', () => {
        it('key.json — ключ нынешней программы EVM нынешнего протокола, пересчитываемый из закреплённого верификатора', () => {
            const programs = loadEvmProgramKeys();
            expect(expectedKey.file.protocolVersion).toBe(PROTOCOL_VERSION);
            expect(programs.sourcesSha256).toBe(currentEvmSourcesSha256());
            expect(expectedKey.file.sourcesSha256).toBe(programs.sourcesSha256);
            expect(expectedKey.file.programVKey).toBe(programs.programVKey);
            expect(expectedKey.file.programElfSha256).toBe(programs.programElfSha256);
            // Цепочка сценария исполнена тем же ELF.
            expect(expectedChain.programElfSha256).toBe(programs.programElfSha256);
            // Остатков ключа выхода в файле нет.
            expect(Object.keys(expectedKey.file).filter((field) => /exit/i.test(field))).toEqual([]);
            // Части ключа и хеши пересчитываются из закреплённого ключа схемы и program.json.
            const recomputed = spawnSync('node', [path.join(__dirname, '..', 'zk', 'gen-evm-rollup-key.mjs'), '--check'], {
                encoding: 'utf8',
            });
            expect(recomputed.stderr).toBe('');
            expect(recomputed.status).toBe(0);
        });

        it('после загрузки и фиксации контракт сообщает ровно тот хеш ключа, что посчитан вне цепочки', async () => {
            expect(await rollup.getKeyHash()).toBe(0n);
            const finalized = await finalize();
            accepted(finalized, rollup);
            gas.finalizeKey = Number(computePhaseOf(finalized.transactions, rollup.address).gasUsed);
            expect(await rollup.getKeyHash()).toBe(expectedKey.keyHash);
            expect(expectedKey.keyHash).not.toBe(0n);
            // У ключа одна оконная таблица: нонс SP1 свёрнут в IC0 и своей таблицы не имеет.
            expect(key.table1Parts).toHaveLength(0);
            // Части после фиксации убраны из хранилища: остался только собранный ключ.
            expect(Rollup.uploadedKeySlots(await dataOf())).toEqual([]);
            expect(BigInt('0x' + Rollup.finalizedKeyCell(await dataOf())!.hash().toString('hex'))).toBe(expectedKey.keyHash);
        });

        it('части ключа читаются из данных контракта: развёртывание сверяет их содержимое до фиксации', async () => {
            // До фиксации часть ключа можно перезаписать, а после — ключ неизменяем. Поэтому
            // развёртывание сверяет СОДЕРЖИМОЕ каждой части (по хешу), а не только то, что часть
            // с таким номером загружена.
            const expectedParts = Bn254Groth16Verifier.keyParts(key);
            const expectedHashes = new Map(expectedParts.map(({ slot, part }) => [slot, part.hash().toString('hex')]));
            expect(Rollup.uploadedKeyPartHashes(await dataOf())).toEqual(expectedHashes);
            expect(Rollup.uploadedKeySlots(await dataOf()).sort((a, b) => a - b)).toEqual(
                [...expectedHashes.keys()].sort((a, b) => a - b),
            );
            expect(Rollup.finalizedKeyCell(await dataOf())).toBeNull();

            // Часть подменена (тот же номер, другое содержимое): по номерам всё на месте, по хешам — нет.
            const { slot } = expectedParts[0];
            await rollup.sendUploadKeyPart(owner.getSender(), {
                slot,
                part: beginCell().storeUint(0xbad, 16).endCell(),
                value: KEY_PART_VALUE,
            });
            const tampered = Rollup.uploadedKeyPartHashes(await dataOf());
            expect(tampered.size).toBe(expectedHashes.size);
            expect(tampered.get(slot)).not.toBe(expectedHashes.get(slot));
            // С подменённой частью ключ фиксируется, но хеш у него другой: сверка это видит.
            accepted(await finalize(), rollup);
            expect(await rollup.getKeyHash()).not.toBe(expectedKey.keyHash);
            expect(check(await readOnchainRollup(rollup))).toEqual(['ключ программы батчей не тот']);
        });
    });

    describe('сверка развёртывания', () => {
        it('константа генезиса в коде контракта — генезис цепочки L2; честное развёртывание сходится', async () => {
            expect(constants.genesisHash).toBe(BigInt(expectedChain.genesisHash));
            accepted(await finalize(), rollup);
            const onchain = await readOnchainRollup(rollup);
            expect(check(onchain)).toEqual([]);
            expect(onchain.protocolVersion).toBe(PROTOCOL_VERSION);
            expect(onchain.genesisHash).toBe(BigInt(expectedChain.genesisHash));
            expect(onchain.deployment.nullifierCodeHash).toBe(BigInt('0x' + nullifierCode.hash().toString('hex')));
        });

        it('сверка называет каждую подмену по имени', async () => {
            const ADDRESS = expect.stringMatching(/^адрес/);
            const NOT_FINALIZED = 'ключ не зафиксирован: rollup ещё не принимает депозиты';
            /** Контракт с подменённым параметром и зафиксированным честным ключом. */
            const deployedWith = async (overrides: Partial<RollupConfig>) => {
                const other = await uploadedWith(overrides);
                accepted(await finalize(other), other);
                return readOnchainRollup(other);
            };
            // Параметры развёртывания: расходится и адрес, и само поле.
            const fakeNullifier = beginCell().storeUint(0xdead, 16).endCell();
            expect(check(await deployedWith({ sequencer: stranger.address }))).toEqual([ADDRESS, 'секвенсор не тот']);
            expect(check(await readOnchainRollup(await deploy({ owner: stranger.address })))).toEqual([
                ADDRESS,
                'владелец не тот',
                NOT_FINALIZED,
            ]);
            expect(check(await deployedWith({ chainId: CHAIN_ID + 1n }))).toEqual([ADDRESS, 'chainId не тот']);
            expect(check(await deployedWith({ escapeTimeout: ESCAPE_TIMEOUT_SECONDS - 1 }))).toEqual([
                ADDRESS,
                'срок заморозки не тот',
            ]);
            expect(check(await deployedWith({ maxBlockAge: MAX_BLOCK_AGE_SECONDS - 1 }))).toEqual([
                ADDRESS,
                'наибольший возраст блока не тот',
            ]);
            expect(check(await deployedWith({ nullifierCode: fakeNullifier }))).toEqual([ADDRESS, 'код нуллификатора не тот']);

            // Другой генезис в начальных данных: контракт сам не фиксирует с ним ключ.
            const otherGenesis = await uploadedWith({ genesisStateRoot: constants.genesisHash + 1n });
            rejected(await finalize(otherGenesis), otherGenesis, RollupErrors.badGenesis);
            expect(check(await readOnchainRollup(otherGenesis))).toEqual([ADDRESS, NOT_FINALIZED]);
            // Проверяющий, которому назвали не тот генезис: расходится и адрес, и константа кода.
            accepted(await finalize(), rollup);
            const wrongExpectation = { ...config, genesisStateRoot: constants.genesisHash + 1n };
            expect(check(await readOnchainRollup(rollup), wrongExpectation)).toEqual([
                ADDRESS,
                'начальное слово состояния — не хеш генезиса протокола',
            ]);

            // Ключ: параметры развёртывания и адрес те же — ловится только сверкой хеша.
            await blockchain.loadFrom(uploaded);
            // Владелец зафиксировал ключ другой программы батчей: IC0 чужой, остальное то же.
            accepted(await finalize(rollup, { ...key, ic0: GENERATOR }), rollup);
            expect(check(await readOnchainRollup(rollup))).toEqual(['ключ программы батчей не тот']);
            await blockchain.loadFrom(uploaded);
            expect(check(await readOnchainRollup(rollup))).toEqual([NOT_FINALIZED]);
        });

        it('подлог мимо FinalizeKey — уже «зафиксированный» ключ и лист в дереве выводов — виден только по адресу', async () => {
            // Сверка генезиса в контракте работает только на пути через FinalizeKey. Развёртывающий
            // может положить в начальные данные сразу и собранный ЧЕСТНЫЙ ключ, и корень дерева
            // выводов с листом в свою пользу: FinalizeKey ему не нужен. Get-методы такого контракта
            // безупречны — подмену показывает только адрес, который не выводится из канонических
            // данных. Поэтому адресная сверка обязательна (REVIEW.md, 14-3).
            accepted(await finalize(), rollup);
            const vkData = Rollup.finalizedKeyCell(await dataOf())!;
            const plantedRoot = sha256Int(0xbadn);
            const planted = Rollup.createPlanted(config, { vkData, withdrawalsRoot: plantedRoot, withdrawalsCount: 1n }, code);
            await blockchain.setShardAccount(
                planted.address,
                createShardAccount({ address: planted.address, code, data: planted.init!.data, balance: toNano('1') }),
            );
            const fake = blockchain.openContract(planted);
            expect(await fake.getKeyHash()).toBe(expectedKey.keyHash);
            expect((await fake.getRollupState()).withdrawalsRoot).toBe(plantedRoot);
            // Такой контракт работает: депозит он принимает.
            accepted(await fake.sendDeposit(stranger.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') }), fake);
            const problems = check(await readOnchainRollup(fake));
            expect(problems).toEqual([expect.stringMatching(/^адрес/)]);
        });
    });

    describe('загрузка и фиксация ключа', () => {
        it('части ключа загружает и ключ фиксирует только владелец', async () => {
            for (const from of [stranger, sequencer]) {
                const part = await rollup.sendUploadKeyPart(from.getSender(), {
                    slot: KeySlots.fixedLines,
                    part: beginCell().endCell(),
                    value: KEY_PART_VALUE,
                });
                rejected(part, rollup, RollupErrors.notOwner);
                rejected(await finalize(rollup, key, from), rollup, RollupErrors.notOwner);
            }
            expect(await rollup.getKeyHash()).toBe(0n);
            // Отказ ничего не перезаписал: части на месте, честный ключ собирается.
            accepted(await finalize(), rollup);
            expect(await rollup.getKeyHash()).toBe(expectedKey.keyHash);
        });

        it('часть с номером вне раскладки ключа не принимается', async () => {
            const before = Rollup.uploadedKeySlots(await dataOf());
            // Допустимы номера обеих таблиц (0…31) и номер фиксированных прямых (32).
            for (const slot of [33, 200, 255]) {
                const part = await rollup.sendUploadKeyPart(owner.getSender(), { slot, part: beginCell().endCell(), value: KEY_PART_VALUE });
                rejected(part, rollup, VerifierErrors.badKeyPart);
            }
            expect(VerifierErrors.badKeyPart).toBe(7105);
            expect(Rollup.uploadedKeySlots(await dataOf())).toEqual(before);
        });

        it('IC0 ключа — точка на кривой: иначе код 7324', async () => {
            expect(RollupErrors.badKeyPoint).toBe(7324);
            rejected(await finalize(rollup, { ...key, ic0: OFF_CURVE }), rollup, RollupErrors.badKeyPoint);
            rejected(await finalize(rollup, { ...key, ic0: [0n, 0n] }), rollup, RollupErrors.badKeyPoint);
            expect(await rollup.getKeyHash()).toBe(0n);
            // Точка на кривой проходит эту проверку (ключ получится чужой, но это уже дело сверки).
            accepted(await finalize(rollup, { ...key, ic0: GENERATOR }), rollup);
        });

        it('ключ со второй оконной таблицей не фиксируется: проверить её было бы нечем', async () => {
            // Вторая таблица (для нонса SP1) загружена и заявлена: ни один пруф с нулевым нонсом
            // её не тронул бы, а подменённая таблица позволила бы подобрать нонсом любой дайджест.
            const extra = key.table0Parts[0];
            await rollup.sendUploadKeyPart(owner.getSender(), { slot: KeySlots.table1, part: extra, value: KEY_PART_VALUE });
            rejected(await finalize(rollup, { ...key, table1Parts: [extra] }), rollup, VerifierErrors.badKeyPart);
            expect(await rollup.getKeyHash()).toBe(0n);
        });

        it('без загруженной части ключ не собирается', async () => {
            const partial = await deploy({ chainId: CHAIN_ID + 7n });
            for (const { slot, part } of Bn254Groth16Verifier.keyParts(key).slice(1)) {
                await partial.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
            }
            rejected(await finalize(partial), partial, VerifierErrors.badKeyPart);
            expect(await partial.getKeyHash()).toBe(0n);
        });

        it('после фиксации ключ неизменяем: ни повторной фиксации, ни новых частей', async () => {
            accepted(await finalize(), rollup);
            rejected(await finalize(), rollup, RollupErrors.keyAlreadyFinalized);
            rejected(await finalize(rollup, { ...key, ic0: GENERATOR }), rollup, RollupErrors.keyAlreadyFinalized);
            const part = await rollup.sendUploadKeyPart(owner.getSender(), {
                slot: KeySlots.table0,
                part: beginCell().endCell(),
                value: KEY_PART_VALUE,
            });
            rejected(part, rollup, RollupErrors.keyAlreadyFinalized);
            expect(await rollup.getKeyHash()).toBe(expectedKey.keyHash);
            expect(Rollup.uploadedKeySlots(await dataOf())).toEqual([]);
        });

        it('до фиксации ключа контракт не принимает ни батчи, ни депозиты, ни принудительные транзакции', async () => {
            // Иначе владелец мог бы дождаться депозитов и зафиксировать ключ другой программы.
            const batch = await rollup.sendSubmitBatch(sequencer.getSender(), {
                proof: mockProof(),
                hints: beginCell().endCell(),
                roots: batchRoots(blockchain, sha256Int(2n), 0),
                value: SUBMIT_BATCH_VALUE,
            });
            rejected(batch, rollup, RollupErrors.keyNotFinalized);
            const deposit = await rollup.sendDeposit(stranger.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') });
            rejected(deposit, rollup, RollupErrors.keyNotFinalized);
            expect(deposit.transactions).toHaveTransaction({ from: rollup.address, to: stranger.address, inMessageBounced: true });
            const forced = await rollup.sendForceTransaction(stranger.getSender(), {
                l2Transaction: forcedTransactionCell(Buffer.alloc(100, 1)),
                value: FORCE_TRANSACTION_VALUE,
            });
            rejected(forced, rollup, RollupErrors.keyNotFinalized);
            expect((await rollup.getRollupState()).batchIndex).toBe(0);
            expect((await rollup.getDepositQueue()).head.count).toBe(0n);

            // После фиксации те же депозит и транзакция принимаются.
            accepted(await finalize(), rollup);
            accepted(await rollup.sendDeposit(stranger.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') }), rollup);
            const forcedAgain = await rollup.sendForceTransaction(stranger.getSender(), {
                l2Transaction: forcedTransactionCell(Buffer.alloc(100, 1)),
                value: FORCE_TRANSACTION_VALUE,
            });
            accepted(forcedAgain, rollup);
            expect((await rollup.getDepositQueue()).head.count).toBe(2n);
        });

        it('неизвестное сообщение отклоняется; пустое тело — пополнение баланса', async () => {
            expect(RollupErrors.unknownMessage).toBe(7301);
            const send = (body: Cell) => stranger.send({ to: rollup.address, value: toNano('0.05'), body });
            // Опкоды сообщений протокола v1 (ForceExit, SetExitKey) настоящему контракту неизвестны.
            expect(Object.values(RollupOpcodes)).not.toEqual(expect.arrayContaining(REMOVED_OPCODES));
            for (const opcode of [...REMOVED_OPCODES, 0xdeadbeef, 0]) {
                const unknown = await send(beginCell().storeUint(opcode, 32).storeUint(0, 64).endCell());
                rejected(unknown, rollup, RollupErrors.unknownMessage);
            }
            // Тело короче опкода — тоже не пополнение.
            rejected(await send(beginCell().storeUint(1, 8).endCell()), rollup, RollupErrors.unknownMessage);
            const before = (await blockchain.getContract(rollup.address)).balance;
            accepted(await send(beginCell().endCell()), rollup);
            expect((await blockchain.getContract(rollup.address)).balance).toBeGreaterThan(before);
        });

        it('в замороженном контракте ключ не фиксируется', async () => {
            // Сообщениями заморозить контракт до фиксации ключа нельзя (без ключа очередь пуста),
            // поэтому состояние подложено. Защита — от начальных данных с уже включённым аварийным
            // режимом: с ними rollup не начинает работу.
            const frozen = await uploadedWith({ chainId: CHAIN_ID + 9n }, { frozen: true });
            expect((await frozen.getEscapeState()).frozen).toBe(true);
            rejected(await finalize(frozen), frozen, RollupErrors.rollupFrozen);
            expect(await frozen.getKeyHash()).toBe(0n);
            // Тот же контракт без подлога ключ фиксирует.
            const thawed = await uploadedWith({ chainId: CHAIN_ID + 9n });
            accepted(await finalize(thawed), thawed);
        });
    });

    describe('параметры развёртывания и генезис на настоящем контракте', () => {
        it('с тестовым сроком в минуты rollup не начинает работу; наименьший допустимый срок годится', async () => {
            // Срок короче наименьшего: ключ не фиксируется, а без ключа контракт не принимает ни
            // депозиты, ни принудительные транзакции. Деньги в такой rollup не попадут.
            const short = await uploadedWith({
                escapeTimeout: constants.minEscapeTimeout - 1,
                maxBlockAge: constants.minMaxBlockAge,
            });
            rejected(await finalize(short), short, RollupErrors.badDeployment);
            expect(await short.getKeyHash()).toBe(0n);
            const deposit = await short.sendDeposit(stranger.getSender(), { l2Recipient: L2_RECIPIENT, value: toNano('1') });
            rejected(deposit, short, RollupErrors.keyNotFinalized);

            // Параметры стенда testnet — наименьшие, с которыми контракт фиксирует ключ.
            expect(TESTNET_ESCAPE_TIMEOUT_SECONDS).toBe(constants.minEscapeTimeout);
            expect(TESTNET_MAX_BLOCK_AGE_SECONDS).toBe(constants.minMaxBlockAge);
            const edge = await uploadedWith({
                escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS,
                maxBlockAge: TESTNET_MAX_BLOCK_AGE_SECONDS,
            });
            accepted(await finalize(edge), edge);
        });

        it('возраст блока вне границ и неканоническое начальное состояние — ключ не фиксируется', async () => {
            const young = await uploadedWith({ maxBlockAge: constants.minMaxBlockAge - 1 });
            rejected(await finalize(young), young, RollupErrors.badDeployment);
            const old = await uploadedWith({ maxBlockAge: ESCAPE_TIMEOUT_SECONDS + 1 });
            rejected(await finalize(old), old, RollupErrors.badDeployment);
            // Подложенный долг — заготовка выплаты из чужих депозитов (REVIEW.md, 14-3).
            const owed = Rollup.owedDictionary();
            owed.set(1n, { recipient: stranger.address, amount: toNano('100') });
            const indebted = await uploadedWith({}, { owed });
            rejected(await finalize(indebted), indebted, RollupErrors.badGenesis);
            expect(await indebted.getKeyHash()).toBe(0n);
        });
    });
});
