// @ts-nocheck
// СКРИПТ ПРОТОКОЛА v1, см. тег protocol-v1. С контрактом протокола v2 несовместим: контракт развёртывался со словом состояния, равным хешу блока из фикстуры; протокол v2 фиксирует ключ только на генезисе протокола, а слово состояния меняет только батч с пруфом.
// Не удалён и не подогнан: отказывается стартовать (assertProtocolV1Script в начале run) и не
// типизируется, пока пруфы в fixtures/ не перестроены под v2 (wrappers/protocolVersion.ts).
// Перенос на v2 — вместе с шагом программы и пруфов (PROTOCOL-V2.md, раздел 11).
import { assertProtocolV1Script } from '../wrappers/protocolVersion';
import { Address, Cell, fromNano, toNano } from '@ton/core';
import { compile, NetworkProvider, sleep } from '@ton/blueprint';
import { readFileSync } from 'fs';
import path from 'path';
import { keccak_256 } from '@noble/hashes/sha3';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import { evmHeaderCell, evmProofCell, evmProofSteps, evmSignatureCell, evmSignatureFromHex } from '../wrappers/evmExit';
import { loadEvmRollupKey } from '../wrappers/evmProofs';
import { exitNullifierKey, Rollup, RollupConfig } from '../wrappers/Rollup';
import { RollupNullifier } from '../wrappers/RollupNullifier';
import {
    DEPLOY_VALUE,
    ESCAPE_SERVICE_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    LATE_DEPOSIT_VALUE,
    TESTNET_ESCAPE_TIMEOUT_SECONDS,
} from '../wrappers/rollupValues';
import { assertTestnetWithMnemonic } from '../wrappers/testnetGuard';

// Прогон в testnet аварийного выхода счёта EVM без пруфа zkVM (contracts/rollup/evm_exit.tolk):
// секвенсор «пропал», rollup заморожен, владелец счёта L2 забирает баланс сам — контракт
// проверяет заголовок блока, доказательство счёта Merkle-Patricia и подпись Ethereum.
//
//   npx blueprint run runEvmExitTestnet --testnet --mnemonic address   # адрес кошелька прогона
//   node zk/gen-evm-exit-fixture.mjs <этот адрес>                       # фикстура с согласием под него
//   npx blueprint run runEvmExitTestnet --testnet --mnemonic            # сам прогон (ждёт час)
//
// Что это показывает и чего нет. Слово состояния контракта — хеш заголовка настоящего блока
// цепочки anvil из фикстуры (fixtures/evm_exit/exit.json), заданный при развёртывании как
// генезис: батчей в этом прогоне нет. Баланс счёта L2 существует только в этой цепочке —
// обеспечения на L1 у него нет, выплату покрывает запас развёртывания контракта. Проверяется
// механизм выхода в настоящей сети (опкоды HASHEXT_KECCAK256 и ECRECOVER, газ, цепочка через
// нуллификатор), а не полный цикл «внёс → получил на L2 → вышел». Денег пользователей в этом
// контракте быть не должно.
//
// Скрипт продолжает с того места, где остановился: что уже сделано, он узнаёт по состоянию
// контракта. После каждой отправки ждёт подтверждения по состоянию, а не по таймеру.

/** Комиссии кошелька сверх приложенных сумм — с запасом, только для предполётной оценки. */
const WALLET_FEE = toNano('0.03');
const POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 3000;
/** 1 нанотон = 1 gwei (EVM_WEI_PER_NANOTON в evm_exit.tolk). */
const WEI_PER_NANOTON = 1_000_000_000n;

type TestnetExit = {
    account: string;
    balanceWei: string;
    accountProof: string[];
    recipient: string;
    recipientHash: string;
    consentHash: string;
    signature: string;
};

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
    assertProtocolV1Script('runEvmExitTestnet');
    const ui = provider.ui();
    assertTestnetWithMnemonic(provider);
    const sender = provider.sender();
    const owner = sender.address;
    if (!owner) throw new Error('У отправителя нет адреса: подключи кошелёк.');
    if (args.includes('address')) {
        ui.write(`Адрес кошелька прогона: ${owner.toString({ testOnly: true })}`);
        ui.write(`Дальше: node zk/gen-evm-exit-fixture.mjs ${owner.toString({ testOnly: true })}`);
        return;
    }

    // --- предполётная проверка фикстуры: всё, что можно сверить до первой отправки ---
    const bytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex');
    const fixture = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'evm_exit', 'exit.json'), 'utf8'));
    const exit: TestnetExit | undefined = fixture.testnet;
    if (!exit) {
        throw new Error(
            'В фикстуре нет раздела testnet. Узнай адрес кошелька (аргумент address) и запусти ' +
                'node zk/gen-evm-exit-fixture.mjs <адрес>, затем tests/RollupEvmExit.spec.ts.',
        );
    }
    const recipient = Address.parse(exit.recipient);
    if (!recipient.equals(owner)) {
        throw new Error(
            `Согласие в фикстуре подписано под ${exit.recipient}, а прогон идёт кошельком ` +
                `${owner.toString({ testOnly: true })}: перегенерируй фикстуру под этот кошелёк.`,
        );
    }
    const header = bytes(fixture.headerRlp);
    const blockHash = BigInt(fixture.blockHash);
    if (BigInt('0x' + Buffer.from(keccak_256(header)).toString('hex')) !== blockHash) {
        throw new Error('Фикстура испорчена: keccak заголовка не равен хешу блока.');
    }
    const account = BigInt(exit.account);
    const amount = BigInt(exit.balanceWei) / WEI_PER_NANOTON;
    const expectedKey = loadEvmRollupKey();
    const key = expectedKey.upload;
    const parts = Bn254Groth16Verifier.keyParts(key);

    const config: RollupConfig = {
        owner,
        sequencer: owner,
        nullifierCode: await compile('RollupNullifier'),
        // Слово состояния — хеш заголовка блока, против которого построено доказательство счёта.
        genesisStateRoot: blockHash,
        chainId: BigInt(fixture.chainId),
        escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS,
    };
    const code = await compile('Rollup');
    const rollup = provider.open(Rollup.createFromConfig(config, code));
    ui.write(`Rollup-контракт (выход счёта EVM): ${rollup.address.toString()}`);

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

    const deployed = await provider.isContractDeployed(rollup.address);
    const nullifier = deployed ? await rollup.getExitNullifierAddress(account) : null;
    const exited = nullifier !== null && (await isClaimed(nullifier));

    // --- хватит ли монет: прогон, оборванный на середине, оставит их на контракте без пользы ---
    // Минимум на сам выход считает контракт; до развёртывания берём оценку сверху.
    const exitEstimate = deployed ? (await rollup.getEvmExitBudget()).minValue : toNano('0.06');
    const needed = exited
        ? 2n * (ESCAPE_SERVICE_VALUE + WALLET_FEE)
        : DEPLOY_VALUE +
          BigInt(parts.length) * KEY_PART_VALUE +
          2n * KEY_FINALIZE_VALUE +
          LATE_DEPOSIT_VALUE +
          2n * ESCAPE_SERVICE_VALUE +
          exitEstimate +
          BigInt(parts.length + 7) * WALLET_FEE;
    const balance = (await provider.getContractState(owner)).balance;
    ui.write(`Шагов примерно на ${fromNano(needed)} TON (оценка сверху), на кошельке ${fromNano(balance)} TON.`);
    if (balance < needed) {
        throw new Error(
            `Не хватает ${fromNano(needed - balance)} TON. Пополни тестовый кошелёк ` +
                `${owner.toString({ testOnly: true, bounceable: false })} и запусти скрипт ещё раз.`,
        );
    }

    // --- развёртывание и ключ: без зафиксированных ключей контракт не принимает депозит ---
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
            // Ключ выхода по пруфу для EVM — заглушка; в этом прогоне он не используется.
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

    // --- сверка до заморозки: контракт ждёт ровно тот заголовок и то согласие, что в фикстуре ---
    const state = await rollup.getRollupState();
    if (state.stateRoot !== blockHash || state.batchIndex !== 0) {
        throw new Error('Слово состояния контракта — не хеш блока из фикстуры: доказательство к нему не подойдёт.');
    }
    if ((await rollup.getEvmExitConsentHash(BigInt(exit.recipientHash))) !== BigInt(exit.consentHash)) {
        throw new Error('Контракт считает хеш согласия иначе, чем фикстура: подпись не подойдёт.');
    }
    const budget = await rollup.getEvmExitBudget();
    ui.write(`Минимум монет на выход по ценам сети: ${fromNano(budget.minValue)} TON (запас газа шага ${budget.stepGas}).`);

    // --- секвенсор «пропал»: депозит, который никто не обработает, запускает срок заморозки ---
    if (!(await rollup.getEscapeState()).frozen) {
        const queue = await rollup.getDepositQueue();
        if (queue.head.count === queue.processed.count) {
            const { depositFee } = await rollup.getQueueFees();
            ui.write(`Депозит ${fromNano(LATE_DEPOSIT_VALUE)} TON — его никто не обработает`);
            await rollup.sendDeposit(sender, { l2Recipient: 0xdeadn, value: LATE_DEPOSIT_VALUE, maxFee: depositFee });
            await waitFor('депозит в очереди', async () => {
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

    // --- выход счёта EVM: заголовок, доказательство счёта и подпись владельца ---
    const claimKey = exitNullifierKey(account);
    const exitNullifier = await rollup.getExitNullifierAddress(account);
    if (!(await isClaimed(exitNullifier))) {
        ui.write(`Выход счёта ${exit.account}: ${fromNano(amount)} TON на ${recipient.toString({ testOnly: true })}`);
        await rollup.sendForceExitEvm(sender, {
            recipient,
            header: evmHeaderCell(header),
            proof: evmProofCell(evmProofSteps(exit.accountProof.map(bytes))),
            signature: evmSignatureCell(evmSignatureFromHex(exit.signature)),
            value: budget.minValue,
        });
        await waitFor(
            'заявка выхода погашена в нуллификаторе (коды 7400–7406 у rollup — отказ проверки счёта EVM, ' +
                '7320 — нет баланса, 7203 у нуллификатора — мало монет)',
            () => isClaimed(exitNullifier),
        );
    }
    // Получатель — сам кошелёк прогона, по его балансу выплату не узнать (он же платит комиссии).
    // Исход шага выплаты один из двух: выплата либо запись долга; отсутствие долга после
    // погашенной заявки и есть выплата. Сама транзакция выплаты — в отчёте из сети.
    await sleep(10 * POLL_DELAY_MS);
    if ((await rollup.getOwedPayout(claimKey)) !== null) {
        throw new Error('Заявка погашена, но не оплачена — контракту не хватило баланса: долг записан в контракте.');
    }

    // --- возврат необработанного депозита ---
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
    if ((await rollup.getOwedPayout(claimKey)) !== null) {
        throw new Error('В контракте остался долг по выходу: прогон не завершён.');
    }
    ui.write('Готово: rollup заморожен, счёт EVM вышел по доказательству, депозит возвращён.');
    ui.write(`Газ и коды выхода: node zk/testnet-evm-exit-report.mjs ${rollup.address.toString()}`);
}
