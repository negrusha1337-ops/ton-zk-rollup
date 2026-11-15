import { keccak_256 } from '@noble/hashes/sha3';

// Константы протокола версии 2, которые нужны сборщику блоков. Источник правды — программа
// (zkvm-evm/lib/src) и контракт (contracts/rollup/); здесь копии, и каждая сверяется при запуске:
// хеш генезиса — с узлом и с get-методом genesisHash контракта, код моста — с узлом, предел
// отрезка очереди — get-методом queueLimits (его сервис не копирует вовсе).

/** Адрес моста-предустановки: 20 байт строки «ton-zk-rollup-bridge» (BRIDGE_ADDRESS). */
export const BRIDGE_ADDRESS = '0x' + Buffer.from('ton-zk-rollup-bridge').toString('hex');
/** keccak-256 от «Withdrawal(address,bytes32,uint256)» (WITHDRAWAL_TOPIC). */
export const WITHDRAWAL_TOPIC =
    '0x' + Buffer.from(keccak_256(Buffer.from('Withdrawal(address,bytes32,uint256)'))).toString('hex');
/** Код моста (BRIDGE_CODE в zkvm-evm/lib/src/bridge.rs, разбор по шагам там же). */
export const BRIDGE_CODE =
    '0x36602018605357' +
    '633b9aca003406605357' +
    '633b9aca003404806302faf08011605357' +
    '602052600035600052' +
    '337f' +
    WITHDRAWAL_TOPIC.slice(2) +
    '60406000a200' +
    '5b60006000fd';
/** Хеш заголовка генезиса (GENESIS_HASH в zkvm-evm/lib/src/genesis.rs и в контракте). */
export const GENESIS_HASH = '0xc0284e91570e7f1314f6e4460a613225f49b46deeebd2be3c463fb1c1e0e7883';
/** Лимит газа блока закреплён программой (GAS_LIMIT). */
export const GAS_LIMIT = 30_000_000n;
/** Предел газа принудительной транзакции (FORCED_TX_GAS_CAP): им зарезервирован газ отрезка. */
export const FORCED_TX_GAS_CAP = 40_000n;
/** Базовая комиссия генезиса, wei. */
const GENESIS_BASE_FEE = 1_000_000_000n;
export const ZERO_HASH = '0x' + '00'.repeat(32);

const quantity = (value: bigint) => '0x' + value.toString(16);

/**
 * Генезис цепочки rollup'а для узла Reth: правила по Cancun с нулевого блока (как зашито в
 * программе, chain_config), единственный счёт — мост. То же, что пишет
 * zkvm-evm/scenario/reth-scenario.mjs; совпадение закрепляет хеш генезиса.
 */
export function genesisJson(chainId: bigint): object {
    const forks = [
        'homestead',
        'daoFork',
        'eip150',
        'eip155',
        'eip158',
        'byzantium',
        'constantinople',
        'petersburg',
        'istanbul',
        'muirGlacier',
        'berlin',
        'london',
    ];
    return {
        config: {
            chainId: Number(chainId),
            ...Object.fromEntries(forks.map((fork) => [`${fork}Block`, 0])),
            daoForkSupport: true,
            mergeNetsplitBlock: 0,
            terminalTotalDifficulty: '0',
            terminalTotalDifficultyPassed: true,
            shanghaiTime: 0,
            cancunTime: 0,
        },
        nonce: '0x0',
        timestamp: '0x0',
        extraData: '0x',
        gasLimit: quantity(GAS_LIMIT),
        difficulty: '0x0',
        mixHash: ZERO_HASH,
        coinbase: '0x' + '00'.repeat(20),
        baseFeePerGas: quantity(GENESIS_BASE_FEE),
        alloc: { [BRIDGE_ADDRESS]: { code: BRIDGE_CODE, nonce: '0x1', balance: '0x0' } },
    };
}
