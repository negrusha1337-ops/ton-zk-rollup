import { Address, Cell, fromNano, toNano } from '@ton/core';
import { compile, NetworkProvider, sleep } from '@ton/blueprint';
import { Bn254Groth16Verifier, keyUploadFromJson } from '../wrappers/Bn254Groth16Verifier';
import { Rollup } from '../wrappers/Rollup';
import { batchDataHash, dataHashStep, depositHash, merkleProofCell, withdrawalTree } from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    ESCAPE_SERVICE_VALUE,
    FORCE_EXIT_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    LATE_DEPOSIT_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    WITHDRAW_VALUE,
    TESTNET_ESCAPE_TIMEOUT_SECONDS,
} from '../wrappers/rollupValues';
import { loadProvenBatch, loadProvenExit, loadZkvmScenario, ProvenBatch, ProvenExit } from '../wrappers/zkvmProofs';

// Полный путь rollup-контракта в testnet на настоящих пруфах SP1:
// развёртывание → ключ частями → депозит → батч 1 → данные батча 2 → батч 2 → вывод,
// затем аварийный путь: поздний депозит → срок → заморозка → выход обоих счетов L2 по
// пруфам программы выхода → возврат необработанного депозита.
//
//   npx blueprint run runRollupTestnet --testnet --mnemonic
//
// Скрипт идёт от состояния контракта, поэтому его можно запускать повторно: сделанные
// шаги пропускаются. ТОЛЬКО testnet: код не проходил аудит.
//
// Депозит обязан прийти до батча 1: пруф батча 2 привязан к хешу очереди депозитов,
// который контракт фиксирует в момент приёма батча 1.

// Комиссии кошелька сверх приложенных сумм — оценка по прогону верификатора в testnet
// 12.11.2026: около 0,02 TON на сообщение с частью ключа, около 0,035 TON на батч.
const WALLET_FEE_LARGE = toNano('0.022');
const WALLET_FEE_BATCH = toNano('0.035');
const WALLET_FEE_SMALL = toNano('0.01');
const POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 3000;

async function waitFor(description: string, check: () => Promise<boolean>) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_DELAY_MS);
        // Публичный API testnet иногда отвечает ошибкой или отказом по частоте запросов:
        // это не повод бросать прогон на середине.
        if (await check().catch(() => false)) return;
    }
    throw new Error(
        `Не дождался: ${description}. Проверь транзакции контракта в обозревателе и запусти скрипт ещё раз.`,
    );
}

export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    if (provider.network() !== 'testnet') {
        throw new Error('Этот контракт — стенд без аудита. Скрипт работает только с testnet.');
    }
    const sender = provider.sender();
    const owner = sender.address;
    if (!owner) throw new Error('У отправителя нет адреса: подключи кошелёк.');

    const scenario = loadZkvmScenario();
    const batches = [loadProvenBatch(1), loadProvenBatch(2)];
    const key = keyUploadFromJson(batches[0].hinted.keyUpload);
    const exits = [loadProvenExit('alice'), loadProvenExit('bob')];
    const exitKeyIc0 = keyUploadFromJson(exits[0].hinted.keyUpload).ic0;
    const expectedKeyHash = BigInt('0x' + Cell.fromBase64(batches[0].hinted.vkDataBoc).hash().toString('hex'));
    const parts = Bn254Groth16Verifier.keyParts(key);
    const depositValue = BigInt(scenario.deposit.value);
    const expectedDepositHash = depositHash(0n, BigInt(scenario.deposit.l2Recipient), BigInt(scenario.deposit.amount));

    const rollup = provider.open(
        Rollup.createFromConfig(
            {
                owner,
                sequencer: owner,
                nullifierCode: await compile('RollupNullifier'),
                genesisStateRoot: BigInt(scenario.genesisStateRoot),
                chainId: BigInt(scenario.chainId),
                escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS,
            },
            await compile('Rollup'),
        ),
    );
    ui.write(`Rollup-контракт: ${rollup.address.toString()}`);

    const exitKeySet = async (): Promise<boolean> => {
        const { state } = await provider.getContractState(rollup.address);
        return state.type === 'active' && !!state.data && Rollup.isExitKeySet(Cell.fromBoc(state.data)[0]);
    };
    const uploadedSlots = async (): Promise<number[]> => {
        const { state } = await provider.getContractState(rollup.address);
        if (state.type !== 'active' || !state.data) return [];
        return Rollup.uploadedKeySlots(Cell.fromBoc(state.data)[0]);
    };

    // --- что осталось сделать и сколько это стоит ---
    const deployed = await provider.isContractDeployed(rollup.address);
    const keyReady = deployed && (await rollup.getKeyHash()) !== 0n;
    const loaded = deployed && !keyReady ? await uploadedSlots() : [];
    const missingParts = keyReady ? [] : parts.filter(({ slot }) => !loaded.includes(slot));
    const batchIndex = deployed ? (await rollup.getRollupState()).batchIndex : 0;
    const depositQueued = deployed && (await rollup.getDepositQueue()).head.count > 0n;
    const withdrawal = scenario.withdrawal;
    const nullifier = deployed ? await rollup.getNullifierAddress(withdrawal.leafIndex) : null;
    const withdrawn = nullifier !== null && (await provider.isContractDeployed(nullifier));

    const batchesLeft = BigInt(Math.max(0, batches.length - batchIndex));
    // Порции данных ещё не принятых батчей; уже опубликованные не вычитаем — оценка сверху.
    const chunksLeft = BigInt(batches.slice(batchIndex).reduce((sum, batch) => sum + batch.dataChunks.length, 0));
    const normalNeeded =
        (deployed ? 0n : DEPLOY_VALUE + WALLET_FEE_SMALL) +
        BigInt(missingParts.length) * (KEY_PART_VALUE + WALLET_FEE_LARGE) +
        (keyReady ? 0n : 2n * (KEY_FINALIZE_VALUE + WALLET_FEE_SMALL)) +
        (depositQueued || batchIndex > 0 ? 0n : depositValue + WALLET_FEE_SMALL) +
        chunksLeft * (PUBLISH_DATA_VALUE + WALLET_FEE_SMALL) +
        batchesLeft * (SUBMIT_BATCH_VALUE + WALLET_FEE_BATCH) +
        (withdrawn ? 0n : WITHDRAW_VALUE + WALLET_FEE_SMALL);
    // Аварийный путь: поздний депозит, заморозка, выход двух счетов, возврат депозита.
    // Сделанные шаги не вычитаем — оценка сверху.
    const frozenAlready = deployed && (await rollup.getEscapeState()).frozen;
    const escapeNeeded =
        (frozenAlready ? 0n : LATE_DEPOSIT_VALUE + ESCAPE_SERVICE_VALUE + 2n * WALLET_FEE_SMALL) +
        BigInt(exits.length) * (FORCE_EXIT_VALUE + WALLET_FEE_BATCH) +
        ESCAPE_SERVICE_VALUE +
        WALLET_FEE_SMALL;
    const needed = normalNeeded + escapeNeeded;
    const { balance } = await provider.getContractState(owner);
    ui.write(`Осталось шагов примерно на ${fromNano(needed)} TON, на кошельке ${fromNano(balance)} TON.`);
    if (balance < needed) {
        throw new Error(
            `Не хватает ${fromNano(needed - balance)} TON. Пополни тестовый кошелёк ${owner.toString({ testOnly: true, bounceable: false })} и запусти скрипт снова: ` +
                'прогон, оборванный на середине, оставит монеты на контракте без пользы.',
        );
    }

    // --- развёртывание и ключ ---
    if (!deployed) {
        ui.write('Развёртывание');
        await rollup.sendDeploy(sender, DEPLOY_VALUE);
        await provider.waitForDeploy(rollup.address);
    }
    if (!keyReady) {
        for (const [index, { slot, part }] of parts.entries()) {
            if (!missingParts.some((missing) => missing.slot === slot)) continue;
            ui.write(`Часть ключа ${index + 1} из ${parts.length} (номер ${slot})`);
            await rollup.sendUploadKeyPart(sender, { slot, part, value: KEY_PART_VALUE });
            await waitFor(`часть ${slot} в контракте`, async () => (await uploadedSlots()).includes(slot));
        }
        if (!(await exitKeySet())) {
            // Ключ программы выхода: без него контракт не даст зафиксировать основной ключ.
            ui.write('Ключ программы аварийного выхода');
            await rollup.sendSetExitKey(sender, { ic0: exitKeyIc0, value: KEY_FINALIZE_VALUE });
            await waitFor('ключ программы выхода задан', exitKeySet);
        }
        ui.write('Фиксация ключа');
        await rollup.sendFinalizeKey(sender, { key, value: KEY_FINALIZE_VALUE });
        await waitFor('ключ зафиксирован', async () => (await rollup.getKeyHash()) !== 0n);
    }
    if ((await rollup.getKeyHash()) !== expectedKeyHash) {
        throw new Error('Хеш ключа в контракте не совпал с ожидаемым: подсказки из фикстур к нему не подойдут.');
    }
    ui.write('Ключ зафиксирован, хеш совпал.');

    // --- депозит: до батча 1 ---
    if (batchIndex === 0) {
        if (!depositQueued) {
            ui.write(`Депозит ${fromNano(depositValue)} TON`);
            await rollup.sendDeposit(sender, {
                l2Recipient: BigInt(scenario.deposit.l2Recipient),
                value: depositValue,
            });
            await waitFor('депозит в очереди', async () => (await rollup.getDepositQueue()).head.count > 0n);
        }
        const queue = await rollup.getDepositQueue();
        if (queue.head.count !== 1n || queue.head.hash !== expectedDepositHash) {
            throw new Error('Очередь депозитов не та, под которую построен пруф батча 2: нужен новый контракт.');
        }
    }

    // --- батчи ---
    // Данные батча публикуются в TON до пруфа: контракт копит хеш порций, а пруф привязан
    // к нему. Уже опубликованные порции определяются по накопленному хешу и пропускаются.
    const publishData = async (batch: ProvenBatch, number: number) => {
        const prefixes = batch.dataChunks.reduce(
            (hashes, chunk) => [...hashes, dataHashStep(hashes[hashes.length - 1], chunk)],
            [0n],
        );
        const published = prefixes.indexOf(await rollup.getBatchDataHash(number));
        if (published < 0) {
            throw new Error(`Батч ${number}: в контракте опубликованы другие данные, пруф к ним не подойдёт.`);
        }
        for (let index = published; index < batch.dataChunks.length; index++) {
            ui.write(`Батч ${number}: данные, порция ${index + 1} из ${batch.dataChunks.length}`);
            await rollup.sendPublishData(sender, {
                batchIndex: number,
                data: batch.dataChunks[index],
                value: PUBLISH_DATA_VALUE,
            });
            await waitFor(
                `порция ${index + 1} данных батча ${number} учтена`,
                async () => (await rollup.getBatchDataHash(number)) === prefixes[index + 1],
            );
        }
        if ((await rollup.getBatchDataHash(number)) !== batchDataHash(batch.dataChunks)) {
            throw new Error(`Батч ${number}: хеш опубликованных данных не совпал с ожидаемым.`);
        }
    };
    const submit = async (batch: ProvenBatch, number: number) => {
        await publishData(batch, number);
        if ((await rollup.getExpectedPublicInput(batch.roots)) !== BigInt(batch.output.publicInput)) {
            throw new Error(`Батч ${number}: контракт ждёт другой публичный вход, пруф к его состоянию не подходит.`);
        }
        ui.write(`Батч ${number}: отправляю пруф SP1`);
        await rollup.sendSubmitBatch(sender, {
            proof: batch.proof,
            hints: Cell.fromBase64(batch.hinted.hintsBoc),
            roots: batch.roots,
            value: SUBMIT_BATCH_VALUE,
        });
        await waitFor(
            `батч ${number} принят (код выхода -14 в обозревателе — не хватило газа, 7002–7010 — отказ верификатора)`,
            async () => (await rollup.getRollupState()).batchIndex >= number,
        );
        ui.write(`Батч ${number} принят.`);
    };
    for (const [index, batch] of batches.entries()) {
        if ((await rollup.getRollupState()).batchIndex === index) await submit(batch, index + 1);
    }

    // --- вывод по корню, который опубликовал батч 2 ---
    const state = await rollup.getRollupState();
    if (
        state.stateRoot !== batches[1].roots.newStateRoot ||
        state.withdrawalsRoot !== batches[1].roots.withdrawalsRoot
    ) {
        throw new Error('Состояние контракта после батчей не совпало с тем, что выдала программа.');
    }
    const recipientHash = BigInt(withdrawal.recipientHash);
    const amount = BigInt(withdrawal.amount);
    const leafNullifier = await rollup.getNullifierAddress(withdrawal.leafIndex);
    if (!(await provider.isContractDeployed(leafNullifier))) {
        const tree = withdrawalTree([{ leafIndex: withdrawal.leafIndex, recipientHash, amount }]);
        // Получатель — адрес из сценария, ключа от него нет ни у кого: тестовые монеты там и останутся.
        const recipient = new Address(0, Buffer.from(recipientHash.toString(16).padStart(64, '0'), 'hex'));
        ui.write(`Вывод ${fromNano(amount)} TON на ${recipient.toString()}`);
        await rollup.sendWithdraw(sender, {
            leafIndex: withdrawal.leafIndex,
            recipient,
            amount,
            merkleProof: merkleProofCell(tree.proofFor(withdrawal.leafIndex)),
            value: WITHDRAW_VALUE,
        });
        await waitFor('нуллификатор вывода развёрнут', () => provider.isContractDeployed(leafNullifier));
    }

    ui.write('Обычный путь пройден: депозит, два батча с пруфами SP1 и вывод.');

    // --- аварийный путь: секвенсор «пропал» ---
    if (!(await rollup.getEscapeState()).frozen) {
        const queue = await rollup.getDepositQueue();
        if (queue.head.count === queue.processed.count) {
            // Депозит, который никто не обработает: с него начинается срок заморозки.
            ui.write(`Поздний депозит ${fromNano(LATE_DEPOSIT_VALUE)} TON — его никто не обработает`);
            await rollup.sendDeposit(sender, { l2Recipient: 0xdeadn, value: LATE_DEPOSIT_VALUE });
            await waitFor('поздний депозит в очереди', async () => {
                const now = await rollup.getDepositQueue();
                return now.head.count > now.processed.count;
            });
        }
        const escape = await rollup.getEscapeState();
        // Запас в полминуты: время блока отстаёт от часов этой машины.
        const waitSeconds = escape.oldestPendingAt + escape.timeout + 30 - Math.floor(Date.now() / 1000);
        if (waitSeconds > 0) {
            ui.write(`Жду срок заморозки: ${waitSeconds} с`);
            await sleep(waitSeconds * 1000);
        }
        ui.write("Заморозка rollup'а");
        await rollup.sendActivateEscapeHatch(sender, ESCAPE_SERVICE_VALUE);
        await waitFor('rollup заморожен', async () => (await rollup.getEscapeState()).frozen);
    }

    const forceExit = async (exit: ProvenExit) => {
        const exitNullifier = await rollup.getExitNullifierAddress(exit.claim.l2Account);
        if (await provider.isContractDeployed(exitNullifier)) return;
        if ((await rollup.getExpectedExitInput(exit.claim)) !== BigInt(exit.output.publicInput)) {
            throw new Error(`Выход ${exit.output.name}: контракт ждёт другой публичный вход, пруф не подходит.`);
        }
        ui.write(`Выход ${exit.output.name}: ${fromNano(exit.claim.amount)} TON на ${exit.claim.recipient.toString()}`);
        await rollup.sendForceExit(sender, {
            proof: exit.proof,
            hints: Cell.fromBase64(exit.hinted.hintsBoc),
            claim: exit.claim,
            value: FORCE_EXIT_VALUE,
        });
        await waitFor(`выход ${exit.output.name} оплачен`, () => provider.isContractDeployed(exitNullifier));
    };
    for (const exit of exits) await forceExit(exit);

    // Поздний депозит — второй в очереди; он не попал в батч и возвращается вносителю.
    const lateDepositIndex = 2;
    if ((await rollup.getDepositReceipt(lateDepositIndex)) !== null) {
        ui.write('Возврат необработанного депозита');
        await rollup.sendCancelDeposit(sender, { depositIndex: lateDepositIndex, value: ESCAPE_SERVICE_VALUE });
        await waitFor('депозит возвращён', async () => (await rollup.getDepositReceipt(lateDepositIndex)) === null);
    }

    ui.write('Готово: обычный путь и аварийный выход прошли в testnet.');
    ui.write(`Газ и коды выхода: node zk/testnet-rollup-report.mjs ${rollup.address.toString()}`);
}
