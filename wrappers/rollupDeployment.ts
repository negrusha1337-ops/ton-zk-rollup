import { Address, Cell } from '@ton/core';
import { KeyUpload, KeyUploadJson, keyUploadFromJson } from './Bn254Groth16Verifier';
import { PROTOCOL_VERSION } from './protocolVersion';
import { Rollup, RollupConfig } from './Rollup';

// Сверка развёрнутого rollup-контракта с тем, что должно быть развёрнуто.
//
// Контракт в TON не может проверить собственные начальные данные: их задаёт тот, кто
// развёртывает. Подложить можно код нуллификатора (тогда «пометка» ничего не значит),
// уже зафиксированный ключ своей программы, ненулевой корень выводов, чужого секвенсора,
// срок заморозки в минуты. Часть этого контракт протокола v2 отсекает сам: FinalizeKey
// отказывает, если начальное слово состояния — не хеш закреплённого генезиса, если уже есть
// батчи, выводы или элементы очереди, если срок заморозки или возраст блока вне границ. Но
// подложенный ключ и чужой код нуллификатора он не увидит. Поэтому доверять rollup'у можно
// только после сверки:
//
//   1) адрес контракта = хеш (код, начальные данные). Если адрес, вычисленный из ОЖИДАЕМЫХ
//      кода и параметров, совпал с настоящим, то начальные данные были ровно каноническими:
//      пустой ключ, нулевые корень и счётчик выводов, пустая очередь, заявленные владелец,
//      секвенсор, chainId, срок, возраст блока и код нуллификатора;
//   2) ключ, зафиксированный уже после развёртывания, — это ключ из файла ключа, а тот
//      выводится из закреплённого верификатора SP1 и исходников программы, без чьего-либо пруфа;
//   3) константа генезиса в коде контракта (get-метод genesisHash) — хеш того генезиса, от
//      которого построена цепочка L2. Ожидаемое значение проверяющий берёт НЕ у контракта:
//      у цепочки (fixtures/evm_batches/reth/expected.json, loadRethExpected) либо из своего
//      источника. Сверять слово состояния с тем, что сообщил сам контракт, бессмысленно.
//
// Ключа программы выхода в протоколе v2 нет: шаг SetExitKey из развёртывания убран.
// Порядок развёртывания: части ключа → сверка частей → FinalizeKey → сверка развёртывания.
//
// Этим пользуются тесты и scripts/verifyRollupDeployment.ts.

/**
 * Файл ключа контракта, выведенного из исходников программы батчей
 * (fixtures/evm_batches/key.json, пишет zk/gen-evm-rollup-key.mjs). Ключ у контракта один:
 * ключа программы выхода в протоколе v2 нет.
 */
export type RollupKeyFile = {
    protocolVersion: number;
    circuitVersion: string;
    verifierHash: string;
    vkRoot: string;
    sourcesSha256: string;
    programVKey: string;
    programElfSha256: string;
    keyHash: string;
    keyUpload: KeyUploadJson;
};

export type ExpectedRollupKey = {
    keyHash: bigint;
    upload: KeyUpload;
    file: RollupKeyFile;
};

/** Разбор файла ключа: хеш собранного ключа и его части для загрузки. */
export function rollupKeyFromFile(file: RollupKeyFile): ExpectedRollupKey {
    return { keyHash: BigInt(file.keyHash), upload: keyUploadFromJson(file.keyUpload), file };
}

/** То, что сообщает о себе развёрнутый контракт (get-методы protocolVersion, genesisHash, deployment, keyHash). */
export type OnchainRollup = {
    address: Address;
    protocolVersion: number;
    genesisHash: bigint;
    deployment: {
        owner: Address;
        sequencer: Address;
        chainId: bigint;
        escapeTimeout: number;
        maxBlockAge: number;
        nullifierCodeHash: bigint;
    };
    keyHash: bigint;
};

/** Наименьший срок заморозки, с которым контракт соглашается зафиксировать ключ. */
export const MIN_ESCAPE_TIMEOUT_SECONDS = 3600;
/** Наименьший возраст блока, с которым контракт соглашается зафиксировать ключ. */
export const MIN_MAX_BLOCK_AGE_SECONDS = 1800;

/**
 * Список расхождений между развёрнутым контрактом и ожидаемым; пустой — всё сошлось.
 * `code` — код rollup-контракта, собранный из исходников проверяющим.
 */
export function deploymentMismatches(
    onchain: OnchainRollup,
    expected: { config: RollupConfig; code: Cell; key: Pick<ExpectedRollupKey, 'keyHash'> },
): string[] {
    const problems: string[] = [];
    if (onchain.protocolVersion !== PROTOCOL_VERSION) {
        problems.push(`версия протокола контракта ${onchain.protocolVersion}, ожидалась ${PROTOCOL_VERSION}`);
    }
    const canonical = Rollup.createFromConfig(expected.config, expected.code).address;
    if (!canonical.equals(onchain.address)) {
        problems.push(
            `адрес ${onchain.address.toString()} не выводится из ожидаемых кода и параметров ` +
                `(получился бы ${canonical.toString()}): начальные данные или код другие`,
        );
    }
    const { config } = expected;
    const hashOf = (cell: Cell) => BigInt('0x' + cell.hash().toString('hex'));
    const { deployment } = onchain;
    if (!deployment.owner.equals(config.owner)) problems.push('владелец не тот');
    if (!deployment.sequencer.equals(config.sequencer)) problems.push('секвенсор не тот');
    if (deployment.chainId !== config.chainId) problems.push('chainId не тот');
    if (deployment.escapeTimeout !== config.escapeTimeout) problems.push('срок заморозки не тот');
    if (deployment.escapeTimeout < MIN_ESCAPE_TIMEOUT_SECONDS) problems.push('срок заморозки меньше допустимого');
    if (deployment.maxBlockAge !== config.maxBlockAge) problems.push('наибольший возраст блока не тот');
    if (deployment.maxBlockAge < MIN_MAX_BLOCK_AGE_SECONDS || deployment.maxBlockAge > deployment.escapeTimeout) {
        problems.push('наибольший возраст блока вне допустимых границ');
    }
    if (deployment.nullifierCodeHash !== hashOf(config.nullifierCode)) problems.push('код нуллификатора не тот');
    // Генезис: адрес выше связал начальное слово состояния с ожидаемым; здесь — что константа
    // в коде контракта (с ней он сверяет слово состояния при фиксации ключа) равна ожидаемому
    // генезису. Ожидаемое обязано прийти не от контракта, иначе сравнение ничего не значит.
    if (config.genesisStateRoot !== onchain.genesisHash) problems.push('начальное слово состояния — не хеш генезиса протокола');
    if (onchain.keyHash === 0n) {
        problems.push('ключ не зафиксирован: rollup ещё не принимает депозиты');
    } else if (onchain.keyHash !== expected.key.keyHash) {
        problems.push('ключ программы батчей не тот');
    }
    return problems;
}

/**
 * Границы, на которые согласен ПРОВЕРЯЮЩИЙ: их задаёт он сам, не контракт и не развернувший.
 * Срок заморозки и возраст блока входят в начальные данные контракта, поэтому адресная сверка
 * (`deploymentMismatches`) подставляет те, что сообщает контракт, — приемлемы ли они, решают
 * эти границы. Верхняя граница срока заморозки обязательна: контракт её не ставит, и срок в
 * 2^32 − 1 секунд (136 лет) означал бы, что заморозить rollup и вернуть депозиты нельзя никогда.
 */
export type DeploymentBounds = {
    /** Наименьший срок заморозки, секунд. */
    minEscapeTimeout: number;
    /** Наибольший срок заморозки, секунд. */
    maxEscapeTimeout: number;
    /** Наибольший возраст блока L2, секунд. */
    maxBlockAge: number;
};

/** Расхождения параметров развёрнутого контракта с границами проверяющего; пустой список — приемлемы. */
export function deploymentBoundMismatches(
    deployment: Pick<OnchainRollup['deployment'], 'escapeTimeout' | 'maxBlockAge'>,
    bounds: DeploymentBounds,
): string[] {
    for (const [name, value] of Object.entries(bounds)) {
        if (!Number.isInteger(value) || value <= 0) throw new Error(`deploymentBoundMismatches: ${name} — не целое положительное число секунд`);
    }
    if (bounds.minEscapeTimeout > bounds.maxEscapeTimeout) {
        throw new Error('deploymentBoundMismatches: наименьший срок заморозки больше наибольшего');
    }
    const problems: string[] = [];
    if (deployment.escapeTimeout < bounds.minEscapeTimeout) {
        problems.push(`срок заморозки ${deployment.escapeTimeout} с меньше требуемых ${bounds.minEscapeTimeout} с`);
    }
    if (deployment.escapeTimeout > bounds.maxEscapeTimeout) {
        problems.push(`срок заморозки ${deployment.escapeTimeout} с больше допустимых ${bounds.maxEscapeTimeout} с`);
    }
    if (deployment.maxBlockAge > bounds.maxBlockAge) {
        problems.push(`наибольший возраст блока ${deployment.maxBlockAge} с больше допустимых ${bounds.maxBlockAge} с`);
    }
    return problems;
}

/** Снимок развёрнутого контракта для сверки. */
export async function readOnchainRollup(rollup: {
    address: Address;
    getProtocolVersion(): Promise<number>;
    getGenesisHash(): Promise<bigint>;
    getDeployment(): Promise<OnchainRollup['deployment']>;
    getKeyHash(): Promise<bigint>;
}): Promise<OnchainRollup> {
    return {
        address: rollup.address,
        protocolVersion: await rollup.getProtocolVersion(),
        genesisHash: await rollup.getGenesisHash(),
        deployment: await rollup.getDeployment(),
        keyHash: await rollup.getKeyHash(),
    };
}
