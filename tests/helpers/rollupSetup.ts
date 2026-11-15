import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { Bn254Proof, KeySlots } from '../../wrappers/Bn254Groth16Verifier';
import { BatchRoots, Rollup, RollupConfig } from '../../wrappers/Rollup';

/**
 * Фиксирует в контракте ключ-пустышку. Нужно тестам логики на двойнике: настоящий ключ
 * им ни к чему (пруф заменён заглушкой), но без зафиксированного ключа контракт не
 * принимает ни депозиты, ни принудительные транзакции.
 */
export async function finalizeDummyKeys(rollup: SandboxContract<Rollup>, owner: SandboxContract<TreasuryContract>) {
    const result = await sendDummyKeys(rollup, owner);
    if ((await rollup.getKeyHash()) === 0n) throw new Error('finalizeDummyKeys: ключ не зафиксировался');
    return result;
}

/** То же без проверки исхода: для тестов, где фиксация обязана отказать. Возвращает результат FinalizeKey. */
export async function sendDummyKeys(rollup: SandboxContract<Rollup>, owner: SandboxContract<TreasuryContract>) {
    const part = beginCell().endCell();
    const value = toNano('0.05');
    const sender = owner.getSender();
    await rollup.sendUploadKeyPart(sender, { slot: KeySlots.fixedLines, part, value });
    await rollup.sendUploadKeyPart(sender, { slot: KeySlots.table0, part, value });
    return rollup.sendFinalizeKey(sender, {
        key: { ic0: [1n, 2n], alphaBeta: part, fixedLines: part, table0Parts: [part], table1Parts: [] },
        value,
    });
}

/** Заглушка пруфа для двойника: «первое число пруфа равно 1». */
export const mockProof = (valid = true): Bn254Proof => ({
    a: [valid ? 1n : 2n, 0n],
    b: [
        [0n, 0n],
        [0n, 0n],
    ],
    c: [0n, 0n],
});

/** Константы протокола, как их сообщает сам контракт. Тесты берут их отсюда, а не копируют. */
export type ProtocolConstants = {
    protocolVersion: number;
    genesisHash: bigint;
    maxBatchQueueItems: number;
    maxTrackedItems: number;
    maxForcedTxCells: number;
    prunePerPush: number;
    depositAmountLimit: bigint;
    minMaxBlockAge: number;
    minEscapeTimeout: number;
};

/**
 * Читает константы протокола get-методами контракта с этим кодом. Нужны ДО развёртывания
 * (хеш генезиса входит в начальные данные), поэтому контракт-зонд разворачивается в отдельной
 * песочнице; его начальные данные значения не имеют: get-методы возвращают константы кода.
 */
export async function readProtocolConstants(code: Cell, nullifierCode: Cell): Promise<ProtocolConstants> {
    const blockchain = await Blockchain.create();
    const deployer = await blockchain.treasury('probe');
    const probe = blockchain.openContract(
        Rollup.createFromConfig(
            {
                owner: deployer.address,
                sequencer: deployer.address,
                nullifierCode,
                genesisStateRoot: 0n,
                chainId: 1n,
                escapeTimeout: 0,
                maxBlockAge: 0,
            },
            code,
        ),
    );
    await probe.sendDeploy(deployer.getSender(), toNano('0.1'));
    return {
        protocolVersion: await probe.getProtocolVersion(),
        genesisHash: await probe.getGenesisHash(),
        ...(await probe.getQueueLimits()),
        ...(await probe.getTimeLimits()),
    };
}

/** Батч с пустыми выводами и временем блока «сейчас»: то, что в большинстве тестов не важно. */
export const batchRoots = (
    blockchain: Blockchain,
    newStateRoot: bigint,
    queueProcessedUpTo: bigint | number,
    overrides: Partial<BatchRoots> = {},
): BatchRoots => ({
    newStateRoot,
    withdrawalsRoot: 0n,
    withdrawalsCount: 0n,
    queueProcessedUpTo: BigInt(queueProcessedUpTo),
    blockTimestamp: BigInt(blockchain.now ?? Math.floor(Date.now() / 1000)),
    ...overrides,
});

/**
 * ТОЛЬКО ДЛЯ ТЕСТОВ: подменяет слово состояния уже развёрнутого контракта прямо в хранилище
 * песочницы. Настоящий контракт меняет его только батчем с верным пруфом, а тестам выхода
 * счёта EVM нужно слово состояния, равное хешу заголовка из фикстуры. Раскладка — RollupStorage
 * и RollupState (contracts/rollup/storage.tolk): слово состояния — первые 256 бит ячейки
 * состояния, третьей ссылки корня.
 */
export async function plantStateRoot(blockchain: Blockchain, address: Address, stateRoot: bigint) {
    const contract = await blockchain.getContract(address);
    const shard = contract.account;
    const storageState = shard.account?.storage.state;
    if (storageState?.type !== 'active' || !storageState.state.data) {
        throw new Error('plantStateRoot: контракт не развёрнут');
    }
    const root = storageState.state.data.beginParse();
    const rootBits = root.loadBits(root.remainingBits);
    const [keys, nullifier, state] = [root.loadRef(), root.loadRef(), root.loadRef()];
    const stateSlice = state.beginParse();
    stateSlice.skip(256);
    storageState.state.data = beginCell()
        .storeBits(rootBits)
        .storeRef(keys)
        .storeRef(nullifier)
        .storeRef(beginCell().storeUint(stateRoot, 256).storeSlice(stateSlice).endCell())
        .endCell();
    await blockchain.setShardAccount(address, shard);
}

/** Параметры развёртывания для тестов логики: остальное задаёт сам тест. */
export const testConfig = (
    constants: ProtocolConstants,
    fields: Pick<RollupConfig, 'owner' | 'sequencer' | 'nullifierCode' | 'chainId' | 'escapeTimeout'> &
        Partial<Pick<RollupConfig, 'maxBlockAge' | 'genesisStateRoot'>>,
): RollupConfig => ({
    genesisStateRoot: constants.genesisHash,
    // Наименьший возраст блока, с которым контракт фиксирует ключ; срок заморозки в тестах — час.
    maxBlockAge: constants.minMaxBlockAge,
    ...fields,
});
