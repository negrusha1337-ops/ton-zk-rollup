import { Address, Cell, fromNano, toNano } from '@ton/core';
import { compile, NetworkProvider, sleep } from '@ton/blueprint';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import {
    evmHeaderCell,
    evmNodeItems,
    evmProofCell,
    evmProofSteps,
    evmSignatureCell,
    evmSignatureFromHex,
} from '../wrappers/evmExit';
import { loadEvmRollupKey, loadProvenRethBatch, loadRethExpected, RETH_PROVEN_BLOCKS, rethProofStatus } from '../wrappers/evmProofs';
import { exitNullifierKey, Rollup, RollupConfig } from '../wrappers/Rollup';
import { RollupNullifier } from '../wrappers/RollupNullifier';
import { dataHashStep, merkleProofCell, withdrawalTree } from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    ESCAPE_SERVICE_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    LATE_DEPOSIT_VALUE,
    PUBLISH_DATA_VALUE,
    SUBMIT_BATCH_VALUE,
    TESTNET_ESCAPE_TIMEOUT_SECONDS,
} from '../wrappers/rollupValues';
import { assertTestnetWithMnemonic } from '../wrappers/testnetGuard';

// Полный цикл rollup'а на EVM в testnet на блоках узла Reth (zkvm-evm/scenario/reth-scenario.mjs):
// депозиты на L1 → три батча по Groth16-пруфам SP1 (блоки зачисляют эти депозиты) → вывод через
// мост → секвенсор «пропал», заморозка → аварийные выходы обоих счетов L2 → возврат позднего
// депозита. Генезис цепочки пуст: все монеты L2 — из депозитов этого прогона.
//
//   npx blueprint run runRethCycleTestnet --testnet --mnemonic
//
// Получатель вывода и выходов — кошелёк прогона: его адрес зашит в цепочку (в транзакцию моста и
// в согласия на выход), поэтому фикстуры годятся только этому кошельку. То же самое в Sandbox —
// tests/RollupEvmRethProof.spec.ts.
//
// Скрипт продолжает с того места, где остановился: что уже сделано, он узнаёт по состоянию
// контракта. После каждой отправки ждёт подтверждения по состоянию, а не по таймеру.

/** Комиссии кошелька сверх приложенных сумм — с запасом, только для предполётной оценки. */
const WALLET_FEE = toNano('0.03');
const POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 3000;
/** 1 нанотон = 1 gwei (EVM_WEI_PER_NANOTON в evm_exit.tolk). */
const WEI_PER_NANOTON = 1_000_000_000n;

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

    // --- предполётная проверка: пруфы годны, цепочка собрана под этот кошелёк ---
    const status = rethProofStatus();
    if (!status.current) throw new Error(`Пруфы блоков Reth не годятся для прогона: ${status.reason}`);
    const expected = loadRethExpected();
    const batches = RETH_PROVEN_BLOCKS.map(loadProvenRethBatch);
    const bytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex');
    const ownerHash = '0x' + owner.hash.toString('hex');
    if (expected.exitRecipientHash !== ownerHash || expected.withdrawal.recipientHash !== ownerHash) {
        throw new Error(
            'Цепочка Reth собрана под другого получателя: вывод и выходы ушли бы не этому кошельку. ' +
                `Пересобери её: node zkvm-evm/scenario/reth-scenario.mjs ${owner.toString({ testOnly: true })} — и построй пруфы заново.`,
        );
    }
    const deposits = expected.deposits as { l2Recipient: string; amount: string }[];
    const exits = expected.exits as { account: string; balanceWei: string; accountProof: string[]; signature: string }[];
    const expectedKey = loadEvmRollupKey();
    const key = expectedKey.upload;
    const parts = Bn254Groth16Verifier.keyParts(key);

    const config: RollupConfig = {
        owner,
        sequencer: owner,
        nullifierCode: await compile('RollupNullifier'),
        // «Корень состояния генезиса» — хеш заголовка генезиса Reth (в нём нет ни одного счёта).
        genesisStateRoot: BigInt(expected.genesisHash),
        chainId: BigInt(expected.chainId),
        escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS,
    };
    const code = await compile('Rollup');
    const rollup = provider.open(Rollup.createFromConfig(config, code));
    ui.write(`Rollup-контракт (полный цикл на блоках Reth): ${rollup.address.toString()}`);

    const contractData = async (): Promise<Cell> => {
        const { state } = await provider.getContractState(rollup.address);
        if (state.type !== 'active' || !state.data) throw new Error('контракт не развёрнут');
        return Cell.fromBoc(state.data)[0];
    };
    const partsToUpload = async () => {
        const uploaded = Rollup.uploadedKeyPartHashes(await contractData());
        return parts.filter(({ slot, part }) => uploaded.get(slot) !== part.hash().toString('hex'));
    };
    /** Развёрнутый нуллификатор ещё ничего не значит: смотрим, погашена ли заявка. */
    const isClaimed = async (nullifier: Address) =>
        (await provider.isContractDeployed(nullifier)) &&
        (await provider.open(RollupNullifier.createFromAddress(nullifier)).getIsClaimed());
    /** Заявка погашена, и долга по ней нет: исход шага выплаты — выплата либо запись долга. */
    const settle = async (what: string, claimKey: bigint, nullifier: Address, send: () => Promise<void>) => {
        if (!(await isClaimed(nullifier))) {
            await send();
            await waitFor(
                `${what}: заявка погашена в нуллификаторе (7320 у rollup — нет баланса, 7203 у нуллификатора — мало монет, ` +
                    '7400–7406 — отказ проверки счёта EVM)',
                () => isClaimed(nullifier),
            );
        }
        // Получатель — сам кошелёк прогона (он же платит комиссии), по его балансу выплату не
        // узнать. Ждём шага выплаты; сама транзакция выплаты — в отчёте из сети.
        await sleep(10 * POLL_DELAY_MS);
        if ((await rollup.getOwedPayout(claimKey)) !== null) {
            throw new Error(`${what}: заявка погашена, но не оплачена — контракту не хватило баланса, долг записан в контракте.`);
        }
    };

    const deployed = await provider.isContractDeployed(rollup.address);

    // --- хватит ли монет: прогон, оборванный на середине, оставит их на контракте ---
    const depositTotal = deposits.reduce((sum, item) => sum + BigInt(item.amount) + toNano('0.01'), 0n);
    const dataMessages = batches.reduce((count, batch) => count + batch.dataChunks.length, 0);
    const needed =
        DEPLOY_VALUE +
        BigInt(parts.length) * KEY_PART_VALUE +
        2n * KEY_FINALIZE_VALUE +
        depositTotal +
        BigInt(dataMessages) * PUBLISH_DATA_VALUE +
        BigInt(batches.length) * SUBMIT_BATCH_VALUE +
        LATE_DEPOSIT_VALUE +
        toNano('0.2') + // вывод, два выхода, заморозка, возврат: минимумы считает контракт, здесь оценка сверху
        BigInt(parts.length + dataMessages + batches.length + 12) * WALLET_FEE;
    const balance = (await provider.getContractState(owner)).balance;
    ui.write(`На весь путь нужно до ${fromNano(needed)} TON (оценка сверху), на кошельке ${fromNano(balance)} TON.`);
    if (!deployed && balance < needed) {
        throw new Error(
            `Не хватает ${fromNano(needed - balance)} TON. Пополни тестовый кошелёк ` +
                `${owner.toString({ testOnly: true, bounceable: false })} и запусти скрипт ещё раз.`,
        );
    }

    // --- развёртывание и ключ ---
    if (!deployed) {
        ui.write('Развёртывание');
        await rollup.sendDeploy(sender, DEPLOY_VALUE);
        await provider.waitForDeploy(rollup.address);
    }
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
            // Ключ выхода по пруфу для EVM — заглушка; счета выходят без пруфа (ForceExitEvm).
            ui.write('Ключ программы выхода (заглушка)');
            await rollup.sendSetExitKey(sender, { ic0: expectedKey.exitIc0, value: KEY_FINALIZE_VALUE });
            await waitFor('ключ выхода задан', async () => Rollup.isExitKeySet(await contractData()));
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
    const minimums = await rollup.getMinimumValues();
    if (SUBMIT_BATCH_VALUE < minimums.forceExit) {
        throw new Error('Батч: приложенной суммы не хватит на лимит газа при ценах сети: пересмотри wrappers/rollupValues.ts.');
    }

    // --- обычный путь: депозиты и батчи в том порядке, под который собраны блоки ---
    /** Депозит сценария: на L2 зачтётся ровно `amount`, какой бы ни была комиссия очереди. */
    const depositNumber = async (index: number) => {
        if ((await rollup.getDepositQueue()).head.count >= BigInt(index + 1)) return;
        const item = deposits[index];
        const { depositFee } = await rollup.getQueueFees();
        ui.write(`Депозит ${fromNano(BigInt(item.amount))} TON на счёт L2 ${item.l2Recipient}`);
        await rollup.sendDeposit(sender, { l2Recipient: BigInt(item.l2Recipient), value: BigInt(item.amount) + depositFee, maxFee: depositFee });
        await waitFor('депозит в очереди', async () => (await rollup.getDepositQueue()).head.count >= BigInt(index + 1));
    };
    const batchNumber = async (number: number) => {
        const batch = batches[number - 1];
        const prefixes = batch.dataChunks.reduce(
            (hashes, chunk) => [...hashes, dataHashStep(hashes[hashes.length - 1], chunk)],
            [0n],
        );
        const published = prefixes.indexOf(await rollup.getBatchDataHash(number));
        if (published < 0) throw new Error(`В контракте опубликованы другие данные батча ${number}: этот контракт для прогона негоден.`);
        for (let index = published; index < batch.dataChunks.length; index++) {
            ui.write(`Данные батча ${number}: порция ${index + 1} из ${batch.dataChunks.length}`);
            await rollup.sendPublishData(sender, { batchIndex: number, data: batch.dataChunks[index], value: PUBLISH_DATA_VALUE });
            await waitFor('порция данных учтена', async () => (await rollup.getBatchDataHash(number)) === prefixes[index + 1]);
        }
        // Пруф привязан к очереди L1: если в неё встал посторонний депозит, контракт ждёт другой
        // публичный вход, и слать пруф бессмысленно.
        if ((await rollup.getExpectedPublicInput(batch.roots)) !== batch.publicInputs[1]) {
            throw new Error(
                `Батч ${number}: контракт ждёт другой публичный вход, чем в пруфе (очередь L1 не та, под которую собран блок). ` +
                    'Этот контракт для прогона негоден; депозиты вернёт заморозка: запусти скрипт ещё раз через час.',
            );
        }
        ui.write(`Батч ${number}: пруф SP1 блока Reth`);
        await rollup.sendSubmitBatch(sender, {
            proof: batch.proof,
            hints: Cell.fromBase64(batch.hinted.hintsBoc),
            roots: batch.roots,
            value: SUBMIT_BATCH_VALUE,
        });
        await waitFor(
            `батч ${number} принят (код -14 в обозревателе — не хватило газа, 7003–7010 — отказ верификатора, 7300 — пруф не подтвердил утверждение)`,
            async () => (await rollup.getRollupState()).batchIndex >= number,
        );
    };
    const frozenAlready = (await rollup.getEscapeState()).frozen;
    let batchIndex = (await rollup.getRollupState()).batchIndex;
    let normalPathBroken = '';
    if (!frozenAlready) {
        try {
            // Батч k зачисляет то, что встало в очередь между принятием батчей k−2 и k−1.
            if (batchIndex === 0) {
                await depositNumber(0);
                await batchNumber(1);
            }
            if ((await rollup.getRollupState()).batchIndex === 1) {
                await depositNumber(1);
                await batchNumber(2);
            }
            if ((await rollup.getRollupState()).batchIndex === 2) await batchNumber(3);
        } catch (error) {
            // Депозиты уже на контракте: не бросаем их, а идём к заморозке и возврату.
            normalPathBroken = error instanceof Error ? error.message : String(error);
            ui.write(`Обычный путь остановился: ${normalPathBroken}`);
        }
    }
    batchIndex = (await rollup.getRollupState()).batchIndex;
    const state = await rollup.getRollupState();
    const complete = batchIndex === batches.length && state.stateRoot === batches[2].roots.newStateRoot;

    // --- вывод через мост: лист дерева выводов из блока 3 ---
    if (complete) {
        const leaf = {
            leafIndex: expected.withdrawal.leafIndex as number,
            recipientHash: BigInt(expected.withdrawal.recipientHash),
            amount: BigInt(expected.withdrawal.amount),
        };
        const tree = withdrawalTree([leaf]);
        if (tree.root !== state.withdrawalsRoot) throw new Error('Корень дерева выводов в контракте не тот, что даёт лист сценария.');
        await settle('Вывод через мост', BigInt(leaf.leafIndex), await rollup.getNullifierAddress(leaf.leafIndex), async () => {
            ui.write(`Вывод через мост: ${fromNano(leaf.amount)} TON`);
            await rollup.sendWithdraw(sender, {
                leafIndex: leaf.leafIndex,
                recipient: owner,
                amount: leaf.amount,
                merkleProof: merkleProofCell(tree.proofFor(leaf.leafIndex)),
                value: (await rollup.getMinimumValues()).withdraw,
            });
        });
    }

    // --- секвенсор «пропал»: необработанный депозит ждёт дольше срока, rollup замораживается ---
    if (!(await rollup.getEscapeState()).frozen) {
        const queue = await rollup.getDepositQueue();
        if (queue.head.count === queue.processed.count) {
            const { depositFee } = await rollup.getQueueFees();
            ui.write(`Поздний депозит ${fromNano(LATE_DEPOSIT_VALUE)} TON — его никто не обработает`);
            await rollup.sendDeposit(sender, { l2Recipient: 0xdeadn, value: LATE_DEPOSIT_VALUE, maxFee: depositFee });
            await waitFor('поздний депозит в очереди', async () => {
                const now = await rollup.getDepositQueue();
                return now.head.count > now.processed.count;
            });
        }
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

    // --- аварийные выходы счетов L2 против блока 3: заголовок из данных батча, eth_getProof, подпись ---
    if (complete) {
        const header = evmNodeItems(bytes(batches[2].report.dataChunksHex.join('')))[0];
        if ((await rollup.getEvmExitConsentHash(BigInt(expected.exitRecipientHash))) !== BigInt(expected.consentHash)) {
            throw new Error('Контракт считает хеш согласия иначе, чем фикстура: подписи не подойдут.');
        }
        const budget = await rollup.getEvmExitBudget();
        for (const exit of exits) {
            const account = BigInt(exit.account);
            const amount = BigInt(exit.balanceWei) / WEI_PER_NANOTON;
            await settle(`Выход счёта ${exit.account}`, exitNullifierKey(account), await rollup.getExitNullifierAddress(account), async () => {
                ui.write(`Аварийный выход счёта ${exit.account}: ${fromNano(amount)} TON`);
                await rollup.sendForceExitEvm(sender, {
                    recipient: owner,
                    header: evmHeaderCell(header),
                    proof: evmProofCell(evmProofSteps(exit.accountProof.map(bytes))),
                    signature: evmSignatureCell(evmSignatureFromHex(exit.signature)),
                    value: budget.minValue,
                });
            });
        }
    } else {
        ui.write('Батчи приняты не все: аварийные выходы счетов L2 для такого состояния не построены, возвращаю только депозиты.');
    }

    // --- возврат необработанных депозитов ---
    const finalQueue = await rollup.getDepositQueue();
    for (let index = Number(finalQueue.processed.count) + 1; index <= Number(finalQueue.head.count); index++) {
        if ((await rollup.getDepositReceipt(index)) === null) continue;
        ui.write(`Возврат необработанного депозита №${index}`);
        await rollup.sendCancelDeposit(sender, { depositIndex: index, value: ESCAPE_SERVICE_VALUE });
        await waitFor(
            `депозит №${index} возвращён (код 7320 в обозревателе — контракту не хватило баланса)`,
            async () => (await rollup.getDepositReceipt(index)) === null,
        );
    }
    if (normalPathBroken) throw new Error(`Обычный путь не пройден (${normalPathBroken}); депозиты возвращены.`);
    ui.write('Готово: депозиты, три батча по пруфам, вывод через мост, заморозка, два аварийных выхода и возврат депозита.');
    ui.write(`Газ и коды выхода: node zk/testnet-reth-report.mjs ${rollup.address.toString()}`);
}
