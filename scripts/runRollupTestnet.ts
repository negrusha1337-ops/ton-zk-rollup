import { Address, Cell, fromNano, toNano } from '@ton/core';
import { compile, NetworkProvider, sleep } from '@ton/blueprint';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import { BASE_DEPOSIT_FEE, exitNullifierKey, Rollup, RollupConfig } from '../wrappers/Rollup';
import { deploymentMismatches, loadRollupKey, readOnchainRollup } from '../wrappers/rollupDeployment';
import { RollupNullifier } from '../wrappers/RollupNullifier';
import { sp1ProofsStatus } from '../wrappers/sp1Proofs';
import { assertTestnetWithMnemonic } from '../wrappers/testnetGuard';
import {
    batchDataHash,
    dataHashStep,
    depositHash,
    forcedTransactionHash,
    merkleProofCell,
    withdrawalTree,
} from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    ESCAPE_SERVICE_VALUE,
    FORCE_EXIT_VALUE,
    FORCE_TRANSACTION_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    LATE_DEPOSIT_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    WITHDRAW_VALUE,
    TESTNET_ESCAPE_TIMEOUT_SECONDS,
} from '../wrappers/rollupValues';
import {
    forcedTransactionsOf,
    loadProvenBatch,
    loadProvenExit,
    loadZkvmScenario,
    ProvenBatch,
    withdrawalLeavesAfterBatch3Of,
} from '../wrappers/zkvmProofs';

// Полный путь rollup-контракта в testnet на настоящих пруфах SP1:
// развёртывание → ключ частями → депозит и принудительные транзакции L2 → батч 1 →
// второй депозит → данные и батч 2 → данные и батч 3 → выводы,
// затем аварийный путь: поздний депозит → срок → заморозка → выход обоих счетов L2 по
// пруфам программы выхода → возврат необработанных депозитов.
//
//   npx blueprint run runRollupTestnet --testnet --mnemonic
//   npx blueprint run runRollupTestnet --testnet --mnemonic escape   # только аварийный путь
//
// Скрипт идёт от состояния контракта, поэтому его можно запускать повторно: сделанные
// шаги пропускаются. ТОЛЬКО testnet и только кошелёк по мнемонике (wrappers/testnetGuard.ts):
// код не проходил аудит.
//
// Перед первым сообщением скрипт проверяет, что пруфы построены для нынешних программ,
// нынешнего ключа и именно для сценария из fixtures (wrappers/sp1Proofs.ts), а после
// фиксации ключа — что контракт развёрнут ровно с ожидаемыми параметрами и ключами
// (wrappers/rollupDeployment.ts).
//
// Депозит обязан прийти до батча 1: пруф батча 2 привязан к хешу очереди L1, который
// контракт фиксирует в момент приёма батча 1. Если обычный путь остановился (батч не
// прошёл в сети, в очередь вмешался посторонний, шаг отправлен дважды), депозит уже лежит
// на контракте. Его возвращает режим `escape`: он пропускает обычный путь и идёт сразу к
// заморозке и возврату депозитов. Аварийный путь ждёт срок заморозки — час (меньше контракт
// не допускает); если прогон прервётся, повторный запуск продолжит с того же места.

// Комиссии кошелька сверх приложенных сумм — оценка по прогону верификатора в testnet
// 12.11.2026: около 0,02 TON на сообщение с частью ключа, около 0,035 TON на батч.
const WALLET_FEE_LARGE = toNano('0.022');
const WALLET_FEE_BATCH = toNano('0.035');
const WALLET_FEE_SMALL = toNano('0.01');
const POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 3000;
/** Запас над минимумом монет, который сообщает контракт (цены сети могут слегка отличаться). */
const MINIMUM_MARGIN_PERCENT = 10n;
const ESCAPE_HINT =
    'Депозит, уже лежащий на контракте, возвращает аварийный путь: запусти скрипт с аргументом escape.';

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

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    assertTestnetWithMnemonic(provider);
    const escapeOnly = args.includes('escape');
    const sender = provider.sender();
    const owner = sender.address;
    if (!owner) throw new Error('У отправителя нет адреса: подключи кошелёк.');

    // --- предполётная проверка: пруфы есть, они для нынешних программ и для этого сценария ---
    const scenario = loadZkvmScenario();
    const proofs = sp1ProofsStatus();
    if (!proofs.current && !escapeOnly) {
        throw new Error(`Пруфы SP1 не годятся для прогона: ${proofs.reason}`);
    }
    // В режиме escape пруфы не обязательны: без них скрипт заморозит rollup и вернёт
    // депозиты, а выход счетов L2 по пруфам пропустит.
    const batches = proofs.current ? [loadProvenBatch(1), loadProvenBatch(2), loadProvenBatch(3)] : [];
    const exits = proofs.current ? [loadProvenExit('alice'), loadProvenExit('bob')] : [];
    // Пруф обязан быть построен именно под те публичные значения, которые выдаёт сценарий:
    // сценарий (zkvm/native) в хеш исходников программ не входит, и после его правки пруфы
    // остались бы «годными», а контракт отказал бы уже после депозита.
    for (const [index, batch] of batches.entries()) {
        if (batch.publicInputs[1] !== BigInt(batch.output.publicInput)) {
            throw new Error(`Пруф батча ${index + 1} построен не для сценария из fixtures/zkvm_batches/batches.json`);
        }
    }
    for (const exit of exits) {
        if (exit.publicInputs[1] !== BigInt(exit.output.publicInput)) {
            throw new Error(`Пруф выхода ${exit.output.name} построен не для заявки из fixtures/zkvm_exit/claims.json`);
        }
    }
    // Ключ контракта выведен из исходников (zk/gen-rollup-key.mjs), а не взят из фикстуры пруфа.
    const expectedKey = loadRollupKey();
    const key = expectedKey.upload;
    const exitKeyIc0 = expectedKey.exitIc0;
    const parts = Bn254Groth16Verifier.keyParts(key);
    const depositValue = BigInt(scenario.deposit.value);
    const secondDepositValue = BigInt(scenario.secondDeposit.value);
    const expectedDepositHash = depositHash(0n, BigInt(scenario.deposit.l2Recipient), BigInt(scenario.deposit.amount));

    const config: RollupConfig = {
        owner,
        sequencer: owner,
        nullifierCode: await compile('RollupNullifier'),
        genesisStateRoot: BigInt(scenario.genesisStateRoot),
        chainId: BigInt(scenario.chainId),
        escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS,
    };
    const code = await compile('Rollup');
    const rollup = provider.open(Rollup.createFromConfig(config, code));
    ui.write(`Rollup-контракт: ${rollup.address.toString()}`);

    const contractData = async (): Promise<Cell> => {
        const { state } = await provider.getContractState(rollup.address);
        if (state.type !== 'active' || !state.data) throw new Error('контракт не развёрнут');
        return Cell.fromBoc(state.data)[0];
    };
    const balanceOf = async (address: Address) => (await provider.getContractState(address)).balance;
    /**
     * Погашена ли заявка в нуллификаторе. Развёрнутый нуллификатор ещё ничего не значит:
     * развернуть его может кто угодно, а отклонённая заявка тоже оставляет его развёрнутым.
     */
    const isClaimed = async (nullifier: Address) =>
        (await provider.isContractDeployed(nullifier)) &&
        (await provider.open(RollupNullifier.createFromAddress(nullifier)).getIsClaimed());
    /** Части ключа, которых в контракте нет или которые отличаются от ожидаемых. */
    const partsToUpload = async () => {
        const uploaded = Rollup.uploadedKeyPartHashes(await contractData());
        return parts.filter(({ slot, part }) => uploaded.get(slot) !== part.hash().toString('hex'));
    };
    /**
     * Доводит заявку (вывод или аварийный выход) до исхода. Заявка считается сделанной,
     * только когда нуллификатор её погасил И выплата дошла получателю. Погашенная, но не
     * оплаченная заявка — долг в контракте: в честном прогоне его быть не должно.
     */
    const settleClaim = async (
        what: string,
        claim: { key: bigint; nullifier: Address; recipient: Address; amount: bigint },
        send: () => Promise<void>,
    ) => {
        if (!(await isClaimed(claim.nullifier))) {
            const before = await balanceOf(claim.recipient);
            await send();
            await waitFor(
                `${what}: заявка погашена в нуллификаторе (код 7203 у нуллификатора — мало монет, 7320 у rollup — нет баланса)`,
                () => isClaimed(claim.nullifier),
            );
            // Подтверждение от нуллификатора rollup обрабатывает следующей транзакцией: ждём
            // исхода — выплату получателю либо запись долга.
            await waitFor(
                `${what}: выплата получателю или запись долга`,
                async () =>
                    (await balanceOf(claim.recipient)) >= before + claim.amount ||
                    (await rollup.getOwedPayout(claim.key)) !== null,
            );
        }
        if ((await rollup.getOwedPayout(claim.key)) !== null) {
            throw new Error(
                `${what}: заявка погашена, но не оплачена — контракту не хватило баланса. ` +
                    'Долг записан в контракте и выплачивается сообщением PayOwed после пополнения.',
            );
        }
    };

    // Плата за место в очереди L1 растёт с её длиной. Суммы депозитов сценария зашиты в пруфы
    // (на L2 зачитывается «значение − базовая комиссия»), поэтому депозит сценария возможен
    // только по базовой комиссии: если очередь перегружена (в неё встал кто-то посторонний),
    // скрипт останавливается с объяснением, а не шлёт депозит, который вернётся.
    const assertBaseDepositFee = async (what: string) => {
        const { depositFee, pending } = await rollup.getQueueFees();
        if (depositFee !== BASE_DEPOSIT_FEE) {
            throw new Error(
                `${what}: комиссия депозита сейчас ${fromNano(depositFee)} TON вместо базовой — в окне очереди уже ` +
                    `${pending} элементов. Сумма депозита зашита в пруф, с другой комиссией он не сойдётся. ${ESCAPE_HINT}`,
            );
        }
    };
    /** Сколько приложить к принудительной транзакции: текущая плата плюс запас на газ шага. */
    const forceTransactionValue = async () => {
        const { forceTransactionFee } = await rollup.getQueueFees();
        return forceTransactionFee + (FORCE_TRANSACTION_VALUE - toNano('0.05'));
    };

    // --- что осталось сделать и сколько это стоит ---
    const deployed = await provider.isContractDeployed(rollup.address);
    const keyReady = deployed && (await rollup.getKeyHash()) !== 0n;
    const missingParts = keyReady ? [] : deployed ? await partsToUpload() : parts;
    const batchIndex = deployed ? (await rollup.getRollupState()).batchIndex : 0;
    const queuedBefore = deployed ? Number((await rollup.getDepositQueue()).head.count) : 0;
    const leaves = withdrawalLeavesAfterBatch3Of(scenario);
    const forced = forcedTransactionsOf(scenario);
    // Хеши очереди L1 сценария: после депозита, после каждой принудительной транзакции и
    // после второго депозита (он приходит между батчами 1 и 2, его обрабатывает батч 3).
    const queueHashes = forced.reduce(
        (hashes, cell) => [...hashes, forcedTransactionHash(hashes[hashes.length - 1], cell)],
        [expectedDepositHash],
    );
    const queueHashWithSecondDeposit = depositHash(
        queueHashes[queueHashes.length - 1],
        BigInt(scenario.secondDeposit.l2Recipient),
        BigInt(scenario.secondDeposit.amount),
    );
    // Очередь L1 сценария до батча 1: депозит и принудительные транзакции.
    const forcedLeft = batchIndex > 0 ? 0 : Math.max(0, 1 + forced.length - Math.max(queuedBefore, 1));
    const batchesLeft = BigInt(Math.max(0, batches.length - batchIndex));
    // Порции данных ещё не принятых батчей; уже опубликованные не вычитаем — оценка сверху.
    const chunksLeft = BigInt(batches.slice(batchIndex).reduce((sum, batch) => sum + batch.dataChunks.length, 0));
    // Сделанные выводы и шаги аварийного пути не вычитаем — оценка сверху.
    const normalNeeded = escapeOnly
        ? 0n
        : (deployed ? 0n : DEPLOY_VALUE + WALLET_FEE_SMALL) +
          BigInt(missingParts.length) * (KEY_PART_VALUE + WALLET_FEE_LARGE) +
          (keyReady ? 0n : 2n * (KEY_FINALIZE_VALUE + WALLET_FEE_SMALL)) +
          (queuedBefore > 0 || batchIndex > 0 ? 0n : depositValue + WALLET_FEE_SMALL) +
          (queuedBefore > queueHashes.length || batchIndex > 1 ? 0n : secondDepositValue + WALLET_FEE_SMALL) +
          chunksLeft * (PUBLISH_DATA_VALUE + WALLET_FEE_SMALL) +
          batchesLeft * (SUBMIT_BATCH_VALUE + WALLET_FEE_BATCH) +
          BigInt(forcedLeft) * (FORCE_TRANSACTION_VALUE + WALLET_FEE_SMALL) +
          BigInt(leaves.length) * (WITHDRAW_VALUE + WALLET_FEE_SMALL);
    const escapeNeeded =
        LATE_DEPOSIT_VALUE +
        ESCAPE_SERVICE_VALUE +
        2n * WALLET_FEE_SMALL +
        BigInt(exits.length) * (FORCE_EXIT_VALUE + WALLET_FEE_BATCH) +
        2n * (ESCAPE_SERVICE_VALUE + WALLET_FEE_SMALL);
    const needed = normalNeeded + escapeNeeded;
    const { balance } = await provider.getContractState(owner);
    ui.write(`Осталось шагов примерно на ${fromNano(needed)} TON, на кошельке ${fromNano(balance)} TON.`);
    if (balance < needed) {
        throw new Error(
            `Не хватает ${fromNano(needed - balance)} TON. Пополни тестовый кошелёк ${owner.toString({ testOnly: true, bounceable: false })} и запусти скрипт снова: ` +
                'прогон, оборванный на середине, оставит монеты на контракте без пользы.',
        );
    }
    if (escapeOnly && !deployed) {
        throw new Error('Режим escape: контракт не развёрнут, возвращать нечего.');
    }

    // --- развёртывание ---
    if (!deployed) {
        ui.write('Развёртывание');
        await rollup.sendDeploy(sender, DEPLOY_VALUE);
        await provider.waitForDeploy(rollup.address);
    }

    // --- суммы против цен сети: до первого дорогого шага ---
    // Минимумы монет контракт считает сам из газа по ценам сети; шлём их с небольшим запасом.
    const minimums = await rollup.getMinimumValues();
    const withMargin = (minimum: bigint, limit: bigint, what: string) => {
        const value = minimum + (minimum * MINIMUM_MARGIN_PERCENT) / 100n;
        if (value > limit) {
            throw new Error(
                `${what}: минимум контракта ${fromNano(minimum)} TON с запасом ${MINIMUM_MARGIN_PERCENT}% — это ` +
                    `${fromNano(value)} TON, больше заложенных ${fromNano(limit)} TON. ` +
                    'Цены сети изменились: пересмотри wrappers/rollupValues.ts.',
            );
        }
        return value;
    };
    const withdrawValue = withMargin(minimums.withdraw, WITHDRAW_VALUE, 'Вывод');
    const forceExitValue = withMargin(minimums.forceExit, FORCE_EXIT_VALUE, 'Аварийный выход');
    // Батчу нужен газ до лимита транзакции. Минимум аварийного выхода контракт считает из
    // того же лимита (плюс цепочка нуллификатора), поэтому он — верхняя оценка и для батча:
    // если суммы батча не хватает, батч сгорел бы с кодом −14 уже после депозита.
    if (SUBMIT_BATCH_VALUE < minimums.forceExit) {
        throw new Error(
            `Батч: приложенных ${fromNano(SUBMIT_BATCH_VALUE)} TON не хватит на лимит газа при ценах сети ` +
                `(нужно не меньше ${fromNano(minimums.forceExit)} TON): пересмотри wrappers/rollupValues.ts.`,
        );
    }

    if (!escapeOnly) {
        // --- ключ ---
        if (!keyReady) {
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
                // Ключ программы выхода: без него контракт не даст зафиксировать основной ключ.
                ui.write('Ключ программы аварийного выхода');
                await rollup.sendSetExitKey(sender, { ic0: exitKeyIc0, value: KEY_FINALIZE_VALUE });
                await waitFor('ключ программы выхода задан', async () => Rollup.isExitKeySet(await contractData()));
            }
            // После фиксации ключи неизменяемы: всё сверяем ДО неё — ключ выхода и содержимое
            // каждой части (до фиксации часть можно перезаписать, и сверки по номеру мало).
            const storedExitKey = Rollup.exitKeyIc0(await contractData());
            if (storedExitKey[0] !== exitKeyIc0[0] || storedExitKey[1] !== exitKeyIc0[1]) {
                throw new Error(
                    'Ключ программы выхода в контракте не тот, что выведен из исходников. Он неизменяем: ' +
                        'этот контракт для прогона негоден (его адрес задан кошельком и сценарием — нужен другой кошелёк).',
                );
            }
            if ((await partsToUpload()).length > 0) {
                throw new Error('Части ключа в контракте изменились во время загрузки: запусти скрипт ещё раз.');
            }
            ui.write('Фиксация ключа');
            await rollup.sendFinalizeKey(sender, { key, value: KEY_FINALIZE_VALUE });
            await waitFor('ключ зафиксирован', async () => (await rollup.getKeyHash()) !== 0n);
        }
        // Сверка развёртывания целиком: адрес выводится из ожидаемых кода и параметров, ключи
        // батчей и выхода — те, что выведены из исходников программ.
        const mismatches = deploymentMismatches(await readOnchainRollup(rollup), { config, code, key: expectedKey });
        if (mismatches.length > 0) {
            throw new Error(`Развёрнутый контракт не тот, что ожидался: ${mismatches.join('; ')}`);
        }
        ui.write('Ключи зафиксированы; параметры развёртывания и оба хеша ключей совпали с ожидаемыми.');

        // --- очередь L1 сценария: до батча 1 ---
        if ((await rollup.getRollupState()).batchIndex === 0) {
            if ((await rollup.getDepositQueue()).head.count === 0n) {
                await assertBaseDepositFee('Депозит');
                ui.write(`Депозит ${fromNano(depositValue)} TON`);
                await rollup.sendDeposit(sender, {
                    l2Recipient: BigInt(scenario.deposit.l2Recipient),
                    value: depositValue,
                });
                await waitFor('депозит в очереди', async () => (await rollup.getDepositQueue()).head.count > 0n);
            }
            // Принудительные транзакции сценария встают в очередь после депозита: вывод Алисы в
            // обход секвенсора и мусор, который программа обязана пропустить.
            for (const [index, l2Transaction] of forced.entries()) {
                const position = BigInt(index + 2); // депозит — первый элемент очереди
                if ((await rollup.getDepositQueue()).head.count >= position) continue;
                ui.write(`Принудительная транзакция L2, ${index + 1} из ${forced.length}`);
                await rollup.sendForceTransaction(sender, { l2Transaction, value: await forceTransactionValue() });
                await waitFor(
                    `принудительная транзакция ${index + 1} в очереди`,
                    async () => (await rollup.getDepositQueue()).head.count >= position,
                );
            }
            const queue = await rollup.getDepositQueue();
            if (
                queue.head.count !== BigInt(queueHashes.length) ||
                queue.head.hash !== queueHashes[queueHashes.length - 1]
            ) {
                // Причины: в очередь встал кто-то посторонний либо шаг ушёл дважды.
                throw new Error(`Очередь L1 не та, под которую построен пруф батча 2. ${ESCAPE_HINT}`);
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
            let published = prefixes.indexOf(await rollup.getBatchDataHash(number));
            if (published < 0) {
                // Опубликовано не то (например, порция ушла дважды): сбрасываем и публикуем заново.
                ui.write(`Батч ${number}: в контракте другие данные — сбрасываю их`);
                await rollup.sendDiscardBatchData(sender, { batchIndex: number, value: ESCAPE_SERVICE_VALUE });
                await waitFor(
                    `данные батча ${number} сброшены`,
                    async () => (await rollup.getBatchDataHash(number)) === 0n,
                );
                published = 0;
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
                throw new Error(`Батч ${number}: хеш опубликованных данных не совпал с ожидаемым. ${ESCAPE_HINT}`);
            }
        };
        const submit = async (batch: ProvenBatch, number: number) => {
            await publishData(batch, number);
            if ((await rollup.getExpectedPublicInput(batch.roots)) !== BigInt(batch.output.publicInput)) {
                throw new Error(
                    `Батч ${number}: контракт ждёт другой публичный вход, пруф к его состоянию не подходит. ${ESCAPE_HINT}`,
                );
            }
            ui.write(`Батч ${number}: отправляю пруф SP1`);
            await rollup.sendSubmitBatch(sender, {
                proof: batch.proof,
                hints: Cell.fromBase64(batch.hinted.hintsBoc),
                roots: batch.roots,
                value: SUBMIT_BATCH_VALUE,
            });
            await waitFor(
                `батч ${number} принят (код выхода -14 в обозревателе — не хватило газа, 7003–7010 — отказ ` +
                    `верификатора на подсказках, 7300 — пруф не подтвердил утверждение). ${ESCAPE_HINT}`,
                async () => (await rollup.getRollupState()).batchIndex >= number,
            );
            ui.write(`Батч ${number} принят.`);
        };
        // Второй депозит сценария встаёт в очередь после батча 1 и до батча 2: тогда его цель —
        // батч 3, а его хеш очереди входит в пруф батча 3.
        const queueSecondDeposit = async () => {
            const before = BigInt(queueHashes.length);
            if ((await rollup.getDepositQueue()).head.count === before) {
                await assertBaseDepositFee('Второй депозит');
                ui.write(`Второй депозит ${fromNano(secondDepositValue)} TON`);
                await rollup.sendDeposit(sender, {
                    l2Recipient: BigInt(scenario.secondDeposit.l2Recipient),
                    value: secondDepositValue,
                });
                await waitFor(
                    'второй депозит в очереди',
                    async () => (await rollup.getDepositQueue()).head.count > before,
                );
            }
            const queue = await rollup.getDepositQueue();
            if (queue.head.count !== before + 1n || queue.head.hash !== queueHashWithSecondDeposit) {
                throw new Error(`Очередь L1 не та, под которую построен пруф батча 3. ${ESCAPE_HINT}`);
            }
        };
        for (const [index, batch] of batches.entries()) {
            if ((await rollup.getRollupState()).batchIndex !== index) continue;
            if (index === 1) await queueSecondDeposit();
            await submit(batch, index + 1);
        }

        // --- выводы по корню, который опубликовал последний батч ---
        const state = await rollup.getRollupState();
        const last = batches[batches.length - 1];
        if (state.stateRoot !== last.roots.newStateRoot || state.withdrawalsRoot !== last.roots.withdrawalsRoot) {
            throw new Error(`Состояние контракта после батчей не совпало с тем, что выдала программа. ${ESCAPE_HINT}`);
        }
        // Лист 0 — принудительный вывод Алисы из очереди L1, лист 1 — вывод Боба через секвенсор,
        // лист 2 — вывод Алисы в батче 3.
        // Получатели — адреса из сценария, ключей от них нет ни у кого: тестовые монеты там и останутся.
        const tree = withdrawalTree(leaves);
        for (const { leafIndex, recipientHash, amount } of leaves) {
            const recipient = new Address(0, Buffer.from(recipientHash.toString(16).padStart(64, '0'), 'hex'));
            await settleClaim(
                `Вывод ${leafIndex}`,
                { key: BigInt(leafIndex), nullifier: await rollup.getNullifierAddress(leafIndex), recipient, amount },
                async () => {
                    ui.write(`Вывод ${fromNano(amount)} TON на ${recipient.toString()}`);
                    await rollup.sendWithdraw(sender, {
                        leafIndex,
                        recipient,
                        amount,
                        merkleProof: merkleProofCell(tree.proofFor(leafIndex)),
                        value: withdrawValue,
                    });
                },
            );
        }
        ui.write('Обычный путь пройден: депозиты, принудительные транзакции, три батча с пруфами SP1 и выводы.');
    }

    // --- аварийный путь: секвенсор «пропал» ---
    if (!(await rollup.getEscapeState()).frozen) {
        const queue = await rollup.getDepositQueue();
        if (queue.head.count === queue.processed.count) {
            // Депозит, который никто не обработает: с него начинается срок заморозки.
            // Этот депозит в пруфы не входит: соглашаемся на текущую комиссию, какой бы она ни была.
            const { depositFee } = await rollup.getQueueFees();
            const lateValue = LATE_DEPOSIT_VALUE + (depositFee - BASE_DEPOSIT_FEE);
            ui.write(`Поздний депозит ${fromNano(lateValue)} TON — его никто не обработает`);
            await rollup.sendDeposit(sender, { l2Recipient: 0xdeadn, value: lateValue, maxFee: depositFee });
            await waitFor('поздний депозит в очереди', async () => {
                const now = await rollup.getDepositQueue();
                return now.head.count > now.processed.count;
            });
        }
        // Срок берём у контракта при каждой проверке: чтение могло быть устаревшим.
        for (;;) {
            const escape = await rollup.getEscapeState();
            if (escape.oldestPendingAt === 0) {
                throw new Error('В очереди нет необработанного элемента: срок заморозки не идёт. Запусти скрипт ещё раз.');
            }
            // Запас в минуту: время блока отстаёт от часов этой машины.
            const left = escape.oldestPendingAt + escape.timeout + 60 - Math.floor(Date.now() / 1000);
            if (left <= 0) break;
            ui.write(`Жду срок заморозки: осталось ${Math.ceil(left / 60)} мин`);
            await sleep(Math.min(left, 300) * 1000);
        }
        ui.write("Заморозка rollup'а");
        await rollup.sendActivateEscapeHatch(sender, ESCAPE_SERVICE_VALUE);
        await waitFor(
            'rollup заморожен (код 7314 в обозревателе — срок по часам сети ещё не вышел: повтори запуск)',
            async () => (await rollup.getEscapeState()).frozen,
        );
    }

    for (const exit of exits) {
        const what = `Выход ${exit.output.name}`;
        const claim = {
            key: exitNullifierKey(exit.claim.l2Account),
            nullifier: await rollup.getExitNullifierAddress(exit.claim.l2Account),
            recipient: exit.claim.recipient,
            amount: exit.claim.amount,
        };
        if (
            !(await isClaimed(claim.nullifier)) &&
            (await rollup.getExpectedExitInput(exit.claim)) !== BigInt(exit.output.publicInput)
        ) {
            // Rollup заморожен не в том состоянии, для которого построен пруф выхода (например,
            // батчи не были приняты): этот пруф не подойдёт, новый можно построить только для
            // нынешнего корня состояния.
            ui.write(`${what}: пруф построен для другого состояния, пропускаю.`);
            continue;
        }
        await settleClaim(what, claim, async () => {
            ui.write(`${what}: ${fromNano(exit.claim.amount)} TON на ${exit.claim.recipient.toString()}`);
            await rollup.sendForceExit(sender, {
                proof: exit.proof,
                hints: Cell.fromBase64(exit.hinted.hintsBoc),
                claim: exit.claim,
                value: forceExitValue,
            });
        });
    }

    // Депозиты, не попавшие в батч, возвращаются вносителям. Их номера берём из очереди
    // контракта (всё, что стоит после отметки «обработано»), а не из предположений о том,
    // сколько элементов было в сценарии.
    const finalQueue = await rollup.getDepositQueue();
    for (let index = Number(finalQueue.processed.count) + 1; index <= Number(finalQueue.head.count); index++) {
        if ((await rollup.getDepositReceipt(index)) === null) continue; // принудительная транзакция или уже возвращён
        ui.write(`Возврат необработанного депозита №${index}`);
        await rollup.sendCancelDeposit(sender, { depositIndex: index, value: ESCAPE_SERVICE_VALUE });
        await waitFor(
            `депозит №${index} возвращён (код 7320 в обозревателе — контракту не хватило баланса)`,
            async () => (await rollup.getDepositReceipt(index)) === null,
        );
    }

    // Итоговая сверка долгов по всем заявкам сценария: погашенная, но не оплаченная заявка —
    // не «готово».
    const claimKeys = [
        ...leaves.map((leaf) => BigInt(leaf.leafIndex)),
        ...exits.map((exit) => exitNullifierKey(exit.claim.l2Account)),
    ];
    for (const claimKey of claimKeys) {
        if ((await rollup.getOwedPayout(claimKey)) !== null) {
            throw new Error(`В контракте остался долг по заявке с ключом ${claimKey}: прогон не завершён.`);
        }
    }

    ui.write(
        escapeOnly
            ? 'Аварийный путь пройден: rollup заморожен, что можно было вернуть — возвращено.'
            : 'Готово: обычный путь и аварийный выход прошли в testnet.',
    );
    ui.write(`Газ и коды выхода: node zk/testnet-rollup-report.mjs ${rollup.address.toString()}`);
}
