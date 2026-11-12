import { Address, Cell, fromNano, toNano } from '@ton/core';
import { compile, NetworkProvider, sleep } from '@ton/blueprint';
import { Bn254Groth16Verifier, keyUploadFromJson } from '../wrappers/Bn254Groth16Verifier';
import { Rollup } from '../wrappers/Rollup';
import { depositHash, merkleProofCell, withdrawalTree } from '../wrappers/rollupMath';
import {
    DEPLOY_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    SUBMIT_BATCH_VALUE,
    WITHDRAW_VALUE,
} from '../wrappers/rollupValues';
import { loadProvenBatch, loadZkvmScenario, ProvenBatch } from '../wrappers/zkvmProofs';

// Полный путь rollup-контракта в testnet на настоящих пруфах SP1:
// развёртывание → ключ частями → депозит → батч 1 → батч 2 → вывод.
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
            },
            await compile('Rollup'),
        ),
    );
    ui.write(`Rollup-контракт: ${rollup.address.toString()}`);

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
    const needed =
        (deployed ? 0n : DEPLOY_VALUE + WALLET_FEE_SMALL) +
        BigInt(missingParts.length) * (KEY_PART_VALUE + WALLET_FEE_LARGE) +
        (keyReady ? 0n : KEY_FINALIZE_VALUE + WALLET_FEE_SMALL) +
        (depositQueued || batchIndex > 0 ? 0n : depositValue + WALLET_FEE_SMALL) +
        batchesLeft * (SUBMIT_BATCH_VALUE + WALLET_FEE_BATCH) +
        (withdrawn ? 0n : WITHDRAW_VALUE + WALLET_FEE_SMALL);
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
    const submit = async (batch: ProvenBatch, number: number) => {
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

    ui.write('Готово: депозит, два батча с пруфами SP1 и вывод прошли в testnet.');
    ui.write(`Газ и коды выхода: node zk/testnet-rollup-report.mjs ${rollup.address.toString()}`);
}
