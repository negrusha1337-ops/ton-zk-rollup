import { Cell, fromNano, toNano } from '@ton/core';
import { compile, NetworkProvider, sleep } from '@ton/blueprint';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import { evmProofStatus, loadEvmRollupKey, loadProvenEvmBatch } from '../wrappers/evmProofs';
import { Rollup, RollupConfig } from '../wrappers/Rollup';
import { batchDataHash, dataHashStep } from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    TESTNET_ESCAPE_TIMEOUT_SECONDS,
} from '../wrappers/rollupValues';
import { assertTestnetWithMnemonic } from '../wrappers/testnetGuard';

// Прогон в testnet одного батча EVM: блок, исполненный Reth внутри SP1 (zkvm-evm/), и его
// Groth16-пруф (fixtures/sp1_evm_batch2) принимает тот же rollup-контракт, что работает с
// игрушечным реестром.
//
//   npx blueprint run runEvmBatchTestnet --testnet --mnemonic
//
// Это ДЕМОНСТРАЦИЯ приёма батча, а не rollup на EVM: ключ выхода в контракте — заглушка
// (аварийного выхода для состояния EVM нет), депозитов нет, монеты L2 в блоке — из генезиса
// anvil. Денег пользователей в этом контракте быть не должно: скрипт их и не вносит.
//
// Скрипт продолжает с того места, где остановился: что уже сделано, он узнаёт по состоянию
// контракта. После каждой отправки ждёт подтверждения по состоянию, а не по таймеру.

/** Комиссии кошелька сверх приложенных сумм — с запасом, только для предполётной оценки. */
const WALLET_FEE = toNano('0.03');
const POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 3000;

async function waitFor(description: string, check: () => Promise<boolean>) {
    let lastError = '';
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_DELAY_MS);
        try {
            if (await check()) return;
        } catch (error) {
            // Публичный API testnet иногда отвечает ошибкой или отказом по частоте запросов:
            // это не повод бросать прогон на середине, но и молча глотать ошибку нельзя.
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    throw new Error(
        `Не дождался: ${description}.${lastError ? ` Последняя ошибка запроса: ${lastError}.` : ''} ` +
            'Проверь транзакции контракта в обозревателе и запусти скрипт ещё раз.',
    );
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    assertTestnetWithMnemonic(provider);
    const sender = provider.sender();
    const owner = sender.address;
    if (!owner) throw new Error('У отправителя нет адреса: подключи кошелёк.');

    // --- предполётная проверка: пруф есть и он для нынешней программы и этого батча ---
    const status = evmProofStatus();
    if (!status.current) throw new Error(`Пруф блока EVM не годится для прогона: ${status.reason}`);
    const batch = loadProvenEvmBatch();
    const words = batch.report.publicValues;
    const expectedKey = loadEvmRollupKey();
    const key = expectedKey.upload;
    const parts = Bn254Groth16Verifier.keyParts(key);

    const config: RollupConfig = {
        owner,
        sequencer: owner,
        nullifierCode: await compile('RollupNullifier'),
        // «Корень состояния генезиса» для EVM — хеш заголовка блока-родителя.
        genesisStateRoot: BigInt(words.prevStateRoot),
        chainId: BigInt(words.chainId),
        escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS,
    };
    const code = await compile('Rollup');
    const rollup = provider.open(Rollup.createFromConfig(config, code));
    ui.write(`Rollup-контракт (батч EVM): ${rollup.address.toString()}`);

    const contractData = async (): Promise<Cell> => {
        const { state } = await provider.getContractState(rollup.address);
        if (state.type !== 'active' || !state.data) throw new Error('контракт не развёрнут');
        return Cell.fromBoc(state.data)[0];
    };
    const partsToUpload = async () => {
        const uploaded = Rollup.uploadedKeyPartHashes(await contractData());
        return parts.filter(({ slot, part }) => uploaded.get(slot) !== part.hash().toString('hex'));
    };

    const deployed = await provider.isContractDeployed(rollup.address);
    if (deployed && (await rollup.getRollupState()).batchIndex >= 1) {
        ui.write('Батч EVM в этом контракте уже принят — делать нечего.');
        return;
    }

    // --- хватит ли монет: прогон, оборванный на середине, оставит их на контракте без пользы ---
    const needed =
        DEPLOY_VALUE +
        BigInt(parts.length) * KEY_PART_VALUE +
        2n * KEY_FINALIZE_VALUE +
        BigInt(batch.dataChunks.length) * PUBLISH_DATA_VALUE +
        SUBMIT_BATCH_VALUE +
        BigInt(parts.length + batch.dataChunks.length + 4) * WALLET_FEE;
    const balance = (await provider.getContractState(owner)).balance;
    ui.write(`Шагов примерно на ${fromNano(needed)} TON, на кошельке ${fromNano(balance)} TON.`);
    if (balance < needed) {
        throw new Error(
            `Не хватает ${fromNano(needed - balance)} TON. Пополни тестовый кошелёк ` +
                `${owner.toString({ testOnly: true, bounceable: false })} и запусти скрипт ещё раз.`,
        );
    }

    // --- развёртывание ---
    if (!deployed) {
        ui.write('Развёртывание');
        await rollup.sendDeploy(sender, DEPLOY_VALUE);
        await provider.waitForDeploy(rollup.address);
    }
    // Батчу нужен газ до лимита транзакции: минимум аварийного выхода контракт считает из того
    // же лимита, поэтому он — верхняя оценка и для батча (как в scripts/runRollupTestnet.ts).
    const minimums = await rollup.getMinimumValues();
    if (SUBMIT_BATCH_VALUE < minimums.forceExit) {
        throw new Error(
            `Батч: приложенных ${fromNano(SUBMIT_BATCH_VALUE)} TON не хватит на лимит газа при ценах сети ` +
                `(нужно не меньше ${fromNano(minimums.forceExit)} TON): пересмотри wrappers/rollupValues.ts.`,
        );
    }

    // --- ключ ---
    if ((await rollup.getKeyHash()) === 0n) {
        for (const { slot, part } of await partsToUpload()) {
            ui.write(`Часть ключа, номер ${slot}`);
            await rollup.sendUploadKeyPart(sender, { slot, part, value: KEY_PART_VALUE });
            const expectedHash = part.hash().toString('hex');
            await waitFor(
                `часть ${slot} в контракте`,
                async () => Rollup.uploadedKeyPartHashes(await contractData()).get(slot) === expectedHash,
            );
        }
        if (!Rollup.isExitKeySet(await contractData())) {
            // Контракт не фиксирует ключи без ключа выхода. Для EVM это заглушка: см. шапку.
            ui.write('Ключ программы выхода (заглушка)');
            await rollup.sendSetExitKey(sender, { ic0: expectedKey.exitIc0, value: KEY_FINALIZE_VALUE });
            await waitFor('ключ выхода задан', async () => Rollup.isExitKeySet(await contractData()));
        }
        const storedExitKey = Rollup.exitKeyIc0(await contractData());
        if (storedExitKey[0] !== expectedKey.exitIc0[0] || storedExitKey[1] !== expectedKey.exitIc0[1]) {
            throw new Error('Ключ выхода в контракте не тот, что в fixtures/evm_batches/key.json; он неизменяем.');
        }
        if ((await partsToUpload()).length > 0) {
            throw new Error('Части ключа в контракте изменились во время загрузки: запусти скрипт ещё раз.');
        }
        ui.write('Фиксация ключа');
        await rollup.sendFinalizeKey(sender, { key, value: KEY_FINALIZE_VALUE });
        await waitFor('ключ зафиксирован', async () => (await rollup.getKeyHash()) !== 0n);
    }
    if ((await rollup.getKeyHash()) !== expectedKey.keyHash) {
        throw new Error('Ключ в контракте не тот, что выведен из исходников программы EVM (key.json).');
    }
    if ((await rollup.getChainId()) !== config.chainId) throw new Error('chainId контракта не тот.');

    // --- данные батча: блок EVM публикуется в TON до пруфа ---
    const prefixes = batch.dataChunks.reduce(
        (hashes, chunk) => [...hashes, dataHashStep(hashes[hashes.length - 1], chunk)],
        [0n],
    );
    const published = prefixes.indexOf(await rollup.getBatchDataHash(1));
    if (published < 0) {
        throw new Error('В контракте опубликованы другие данные батча 1: этот контракт для прогона негоден.');
    }
    for (let index = published; index < batch.dataChunks.length; index++) {
        ui.write(`Данные батча: порция ${index + 1} из ${batch.dataChunks.length}`);
        await rollup.sendPublishData(sender, { batchIndex: 1, data: batch.dataChunks[index], value: PUBLISH_DATA_VALUE });
        await waitFor(
            `порция ${index + 1} данных учтена`,
            async () => (await rollup.getBatchDataHash(1)) === prefixes[index + 1],
        );
    }
    if ((await rollup.getBatchDataHash(1)) !== batchDataHash(batch.dataChunks)) {
        throw new Error('Хеш опубликованных данных не совпал с ожидаемым.');
    }
    if (batchDataHash(batch.dataChunks) !== BigInt(words.batchHash)) {
        throw new Error('Хеш данных на стороне TON не совпал с тем, что считала программа в zkVM.');
    }

    // --- батч ---
    if ((await rollup.getExpectedPublicInput(batch.roots)) !== batch.publicInputs[1]) {
        throw new Error('Контракт ждёт другой публичный вход: пруф к его состоянию не подходит.');
    }
    ui.write('Отправляю пруф SP1 блока EVM');
    await rollup.sendSubmitBatch(sender, {
        proof: batch.proof,
        hints: Cell.fromBase64(batch.hinted.hintsBoc),
        roots: batch.roots,
        value: SUBMIT_BATCH_VALUE,
    });
    await waitFor(
        'батч принят (код выхода -14 в обозревателе — не хватило газа, 7003–7010 — отказ верификатора на ' +
            'подсказках, 7300 — пруф не подтвердил утверждение)',
        async () => (await rollup.getRollupState()).batchIndex >= 1,
    );
    const state = await rollup.getRollupState();
    if (state.stateRoot !== batch.roots.newStateRoot || state.withdrawalsRoot !== batch.roots.withdrawalsRoot) {
        throw new Error('Батч принят, но состояние контракта не то, что в пруфе.');
    }
    ui.write(`Готово: контракт ${rollup.address.toString()} принял блок EVM ${batch.report.blockNumber}.`);
    ui.write(`Хеш блока в контракте: 0x${state.stateRoot.toString(16).padStart(64, '0')}`);
}
