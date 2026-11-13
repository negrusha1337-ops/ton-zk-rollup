import { readFileSync } from 'fs';
import path from 'path';
import { Address, Cell } from '@ton/core';
import { KeyUpload, KeyUploadJson, keyUploadFromJson } from './Bn254Groth16Verifier';
import { Rollup, RollupConfig } from './Rollup';

// Сверка развёрнутого rollup-контракта с тем, что должно быть развёрнуто.
//
// Контракт в TON не может проверить собственные начальные данные: их задаёт тот, кто
// развёртывает. Подложить можно код нуллификатора (тогда «пометка» ничего не значит),
// уже зафиксированный ключ своей программы, ненулевой корень выводов, чужого секвенсора,
// срок заморозки в минуты. Поэтому доверять rollup'у можно только после сверки:
//
//   1) адрес контракта = хеш (код, начальные данные). Если адрес, вычисленный из ОЖИДАЕМЫХ
//      кода и параметров, совпал с настоящим, то начальные данные были ровно каноническими:
//      пустые ключи, нулевые корни, пустая очередь, заявленные владелец, секвенсор, chainId,
//      срок и код нуллификатора;
//   2) ключи, зафиксированные уже после развёртывания, — это ключи из fixtures/zkvm_batches/key.json,
//      а тот выводится из закреплённого верификатора SP1 и исходников программ
//      (zk/gen-rollup-key.mjs), без чьего-либо пруфа.
//
// Этим пользуются тесты и scripts/verifyRollupDeployment.ts.

/** Ключ контракта, выведенный из исходников (fixtures/zkvm_batches/key.json). */
export type RollupKeyFile = {
    circuitVersion: string;
    sourcesSha256: string;
    programVKey: string;
    exitProgramVKey: string;
    keyHash: string;
    exitKeyHash: string;
    exitIc0: [string, string];
    keyUpload: KeyUploadJson;
};

export type ExpectedRollupKey = {
    keyHash: bigint;
    exitKeyHash: bigint;
    exitIc0: [bigint, bigint];
    upload: KeyUpload;
    file: RollupKeyFile;
};

export function loadRollupKey(): ExpectedRollupKey {
    const file = JSON.parse(
        readFileSync(path.join(__dirname, '..', 'fixtures', 'zkvm_batches', 'key.json'), 'utf8'),
    ) as RollupKeyFile;
    return {
        keyHash: BigInt(file.keyHash),
        exitKeyHash: BigInt(file.exitKeyHash),
        exitIc0: [BigInt(file.exitIc0[0]), BigInt(file.exitIc0[1])],
        upload: keyUploadFromJson(file.keyUpload),
        file,
    };
}

/** То, что сообщает о себе развёрнутый контракт (get-методы deployment, keyHash, exitKeyHash). */
export type OnchainRollup = {
    address: Address;
    deployment: { owner: Address; sequencer: Address; chainId: bigint; escapeTimeout: number; nullifierCodeHash: bigint };
    keyHash: bigint;
    exitKeyHash: bigint;
};

/** Наименьший срок заморозки, с которым контракт соглашается зафиксировать ключи. */
export const MIN_ESCAPE_TIMEOUT_SECONDS = 3600;

/**
 * Список расхождений между развёрнутым контрактом и ожидаемым; пустой — всё сошлось.
 * `code` — код rollup-контракта, собранный из исходников проверяющим.
 */
export function deploymentMismatches(
    onchain: OnchainRollup,
    expected: { config: RollupConfig; code: Cell; key: Pick<ExpectedRollupKey, 'keyHash' | 'exitKeyHash'> },
): string[] {
    const problems: string[] = [];
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
    if (deployment.nullifierCodeHash !== hashOf(config.nullifierCode)) problems.push('код нуллификатора не тот');
    if (onchain.keyHash === 0n) {
        problems.push('ключ не зафиксирован: rollup ещё не принимает депозиты');
    } else {
        if (onchain.keyHash !== expected.key.keyHash) problems.push('ключ программы батчей не тот');
        if (onchain.exitKeyHash !== expected.key.exitKeyHash) problems.push('ключ программы выхода не тот');
    }
    return problems;
}

/** Снимок развёрнутого контракта для сверки. */
export async function readOnchainRollup(rollup: {
    address: Address;
    getDeployment(): Promise<OnchainRollup['deployment']>;
    getKeyHash(): Promise<bigint>;
    getExitKeyHash(): Promise<bigint>;
}): Promise<OnchainRollup> {
    return {
        address: rollup.address,
        deployment: await rollup.getDeployment(),
        keyHash: await rollup.getKeyHash(),
        exitKeyHash: await rollup.getExitKeyHash(),
    };
}
