import { readFileSync } from 'fs';
import path from 'path';
import { Address, Cell, fromNano, OpenedContract } from '@ton/core';
import { compile, NetworkProvider, sleep, UIProvider } from '@ton/blueprint';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import { evmHeaderCell, evmNodeItems, evmProofCell, evmProofSteps, evmSignatureCell, evmSignatureFromHex } from '../wrappers/evmExit';
import {
    dataChunksOf,
    loadEvmRollupKey,
    loadProvenRethBatch,
    loadRethBatchReport,
    loadRethExpected,
    ProvenEvmBatch,
    RETH_PROVEN_BLOCKS,
    RethExpected,
    rethProofStatus,
} from '../wrappers/evmProofs';
import { proofFixturesBlocker } from '../wrappers/protocolVersion';
import { exitNullifierKey, Rollup, RollupConfig } from '../wrappers/Rollup';
import { deploymentBoundMismatches, deploymentMismatches, ExpectedRollupKey, readOnchainRollup } from '../wrappers/rollupDeployment';
import { RollupNullifier } from '../wrappers/RollupNullifier';
import { dataHashStep, depositHash, forcedTransactionCell, forcedTransactionHash, merkleProofCell, withdrawalTree } from '../wrappers/rollupMath';
import { TESTNET_ESCAPE_TIMEOUT_SECONDS, TESTNET_MAX_BLOCK_AGE_SECONDS } from '../wrappers/rollupValues';
import { assertTestnetWithMnemonic } from '../wrappers/testnetGuard';
import {
    CyclePrices,
    ESTIMATED_PRICES,
    estimateWalletFees,
    exitGaps,
    ForwardPrices,
    payoutArrived,
    preflightRefusals,
    queuePlan,
    QueueStep,
    recipientProblems,
    timeConfigProblems,
    timeDecision,
    TimeDecision,
    walletNeed,
    WalletNeed,
} from '../wrappers/testnetPlan';

// Полный цикл протокола v2 в testnet на блоках узла Reth (zkvm-evm/scenario/reth-scenario.mjs) и
// их Groth16-пруфах SP1 (fixtures/sp1_evm_reth1..3). То же самое в Sandbox —
// tests/RollupEvmRethProof.spec.ts.
//
//   npx blueprint run runRethCycleTestnet --testnet --mnemonic [check | escape]
//       [wait=<с>] [pace=<с>] [margin=<с>] [escapeTimeout=<с>] [maxBlockAge=<с>] [<адрес контракта>]
//
// Порядок: предполётные проверки → развёртывание, части ключа, FinalizeKey → сверка развёртывания
// → ожидание окна времени → перед каждым батчем: элементы очереди L1 (депозиты и принудительные
// транзакции — по порядку номеров, до headAtBatch блока), данные блока, батч по пруфу → вывод
// через мост по каждому листу → поздний депозит → срок заморозки → заморозка → аварийные выходы
// счетов против последнего блока → возврат позднего депозита → итог.
//
// Скрипт возобновляемый: что уже сделано, он узнаёт по состоянию контракта (адрес выводится из
// кошелька и параметров) и продолжает с первого несделанного шага. После каждой отправки ждёт
// подтверждения по состоянию контракта, а не по таймеру; ошибка отправки останавливает прогон.
//
// Время. Контракт принимает батч k, только пока blockTimestamp_k ≤ now ≤ blockTimestamp_k +
// maxBlockAge: у цепочки есть окно, вне которого её пруфы бесполезны. До окна скрипт развёртывает
// контракт и ждёт (не дольше wait секунд); очередь L1 ставит только в окне — поставленная заранее,
// она лишь приближала бы заморозку (элемент старше escapeTimeout позволяет заморозить rollup кому
// угодно). Если до закрытия окна не успеть дойти до последнего батча, скрипт не отправляет ничего.
//
// Режимы:
//   check  — только предполётные проверки и разбивка потребности кошелька; ничего не отправляет;
//   escape — обычный путь встал: заморозить rollup (дождавшись срока) и вернуть всё, что
//            возвращается. Пруфы для этого режима не нужны.
// Параметры: wait — сколько ждать открытия окна (по умолчанию 900 с); pace — оценка времени на
// одно сообщение (20 с); margin — запас на расхождение часов и оценку (60 с); escapeTimeout и
// maxBlockAge — параметры развёртывания (по умолчанию 3600 и 1800 с). Адрес контракта зависит от
// них: для нового контракта тем же кошельком после законченного прогона задай другое значение
// (например, escapeTimeout=3601). Адрес аргументом — только для сверки с вычисленным.
//
// Получатель выплат — кошелёк прогона: его адрес зашит в цепочку (в вызовы моста и в согласия на
// выход), поэтому фикстуры годятся только этому кошельку.

const POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 3000;
/** 1 нанотон = 1 gwei (EVM_WEI_PER_NANOTON в evm_exit.tolk). */
const WEI_PER_NANOTON = 1_000_000_000n;
const LAST = RETH_PROVEN_BLOCKS[RETH_PROVEN_BLOCKS.length - 1];
const ESCAPE_ADVICE =
    'Что делать: запусти скрипт ещё раз с аргументом escape. Он дождётся срока заморозки, заморозит rollup и вернёт то, что ' +
    'возвращается: необработанные депозиты по квитанциям, выводы через мост по принятым батчам и балансы счетов L2 против ' +
    'последнего принятого блока — если под него есть согласие на выход. Плата за места в очереди и газ не возвращаются.';

type Options = {
    mode: 'run' | 'check' | 'escape';
    maxWaitSeconds: number;
    secondsPerMessage: number;
    marginSeconds: number;
    escapeTimeout: number;
    maxBlockAge: number;
    address: Address | null;
};

type Run = {
    provider: NetworkProvider;
    ui: UIProvider;
    owner: Address;
    rollup: OpenedContract<Rollup>;
    expected: RethExpected;
    options: Options;
    /** Число порций данных батчей 1…LAST. */
    dataChunks: number[];
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const hexBytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex');
const ton = (nano: bigint) => `${fromNano(nano)} TON`;

function parseOptions(args: string[]): Options {
    const options: Options = {
        mode: 'run',
        maxWaitSeconds: 900,
        secondsPerMessage: 20,
        marginSeconds: 60,
        escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS,
        maxBlockAge: TESTNET_MAX_BLOCK_AGE_SECONDS,
        address: null,
    };
    const numeric: Record<string, 'maxWaitSeconds' | 'secondsPerMessage' | 'marginSeconds' | 'escapeTimeout' | 'maxBlockAge'> = {
        wait: 'maxWaitSeconds', pace: 'secondsPerMessage', margin: 'marginSeconds', escapeTimeout: 'escapeTimeout', maxBlockAge: 'maxBlockAge',
    };
    for (const arg of args) {
        const [name, value] = arg.split('=', 2);
        if (arg === 'check' || arg === 'escape') {
            if (options.mode !== 'run') throw new Error('Режим задан дважды: нужен один из check и escape.');
            options.mode = arg;
        } else if (name in numeric && value !== undefined) {
            if (!/^\d+$/.test(value)) throw new Error(`Параметр ${name} — целое число секунд, получено «${value}».`);
            options[numeric[name]] = Number(value);
        } else {
            const unknown = `Непонятный аргумент «${arg}»: см. комментарий в начале scripts/runRethCycleTestnet.ts.`;
            if (arg.includes('=') || options.address !== null || !Address.isFriendly(arg)) throw new Error(unknown);
            options.address = Address.parse(arg);
        }
    }
    if (options.secondsPerMessage < 1) throw new Error('Параметр pace обязан быть положительным.');
    return options;
}

async function waitFor(description: string, check: () => Promise<boolean>) {
    let lastError = '';
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_DELAY_MS);
        try {
            if (await check()) return;
        } catch (error) {
            // Публичный API testnet иногда отвечает ошибкой или отказом по частоте запросов: это не
            // повод бросать прогон на середине, но и молча глотать ошибку нельзя — она уйдёт в отказ.
            lastError = error instanceof Error ? error.message : String(error);
        }
    }
    throw new Error(
        `Не дождался: ${description}.${lastError ? ` Последняя ошибка запроса: ${lastError}.` : ''} ` +
            'Проверь транзакции контракта в обозревателе и запусти скрипт ещё раз: он продолжит с этого шага.',
    );
}

const balanceOf = async (run: Run, address: Address) => (await run.provider.getContractState(address)).balance;

/** Хеши очереди цепочки: hashes[n] — после n элементов (формулы контракта, wrappers/rollupMath.ts). */
function queueHashes(expected: RethExpected): bigint[] {
    const hashes = [0n];
    for (const item of expected.queue) {
        const previous = hashes[hashes.length - 1];
        hashes.push(
            item.kind === 'deposit'
                ? depositHash(previous, BigInt(item.l2Recipient), BigInt(item.amount))
                : forcedTransactionHash(previous, hexBytes(item.bytes)),
        );
    }
    return hashes;
}

/** Листья дерева выводов после блока `block` включительно. */
const leavesUpTo = (expected: RethExpected, block: number) =>
    expected.withdrawals
        .filter((leaf) => leaf.block <= block)
        .map((leaf) => ({ leafIndex: leaf.leafIndex, recipientHash: BigInt(leaf.recipientHash), amount: BigInt(leaf.amount) }));

/** Заголовок блока (RLP) из данных батча: данные — RLP блока, заголовок — его первый элемент. */
const headerOf = (block: number) => evmNodeItems(hexBytes(loadRethBatchReport(block).dataChunksHex.join('')))[0];

/** Ячейки сообщения ForceExitEvm для выхода счёта против блока. */
const exitCells = (block: number, exit: RethExpected['exitsByBlock'][number]['exits'][number]) => ({
    header: evmHeaderCell(headerOf(block)),
    proof: evmProofCell(evmProofSteps(exit.accountProof.map(hexBytes))),
    signature: evmSignatureCell(evmSignatureFromHex(exit.signature)),
});

/** Комиссии кошелька за весь прогон — оценка по размерам тел сообщений и снимку цен пересылки. */
function walletFeesEstimate(expected: RethExpected, key: ExpectedRollupKey, batches: ProvenEvmBatch[], plan: QueueStep[]): bigint {
    const config = JSON.parse(readFileSync(path.join(__dirname, '..', 'bench', 'network-config.json'), 'utf8'));
    const forward: ForwardPrices = config.basechain.forward;
    const leaves = leavesUpTo(expected, LAST);
    const tree = withdrawalTree(leaves);
    const exits = expected.exitsByBlock.find(({ block }) => block === LAST)?.exits ?? [];
    const forced = plan.flatMap(({ item }) => (item.kind === 'forced' ? [forcedTransactionCell(hexBytes(item.bytes))] : []));
    const bodies: Cell[] = [
        ...Bn254Groth16Verifier.keyParts(key.upload).map(({ slot, part }) => Bn254Groth16Verifier.buildUploadBody(slot, part)),
        Bn254Groth16Verifier.buildFinalizeBody(key.upload),
        ...forced,
        ...batches.flatMap((batch) => batch.dataChunks),
        ...batches.map((batch) => Rollup.buildSubmitBatchBody({ proof: batch.proof, hints: Cell.fromBase64(batch.hinted.hintsBoc), roots: batch.roots })),
        ...leaves.map((leaf) => merkleProofCell(tree.proofFor(leaf.leafIndex))),
        ...exits.flatMap((exit) => Object.values(exitCells(LAST, exit))),
    ];
    // Остальные сообщения малы: развёртывание, депозиты, поздний депозит, заморозка, возврат.
    const small = 1 + plan.length - forced.length + 3;
    return estimateWalletFees(bodies, small, forward);
}

function printNeed(ui: UIProvider, need: WalletNeed, balance: bigint) {
    ui.write(`Потребность кошелька на весь путь (${need.messages} сообщений):`);
    for (const line of need.lines) {
        ui.write(`  ${line.what}: ${ton(line.spent)}${line.returns > 0n ? `, вернётся ${ton(line.returns)}` : ''}`);
    }
    ui.write(`  ИТОГО нужно ${ton(need.total)}; вернётся ${ton(need.returns)}; не вернётся ${ton(need.lost)}. На кошельке ${ton(balance)}.`);
}

/** Решение о времени для оставшегося пути: сколько сообщений до приёма последнего батча включительно. */
async function timeFor(run: Run, nextBatch: number, messagesLeft: number): Promise<TimeDecision> {
    const { options, expected } = run;
    const deployed = await run.provider.isContractDeployed(run.rollup.address);
    const oldestPendingAt = deployed ? (await run.rollup.getEscapeState()).oldestPendingAt : 0;
    return timeDecision({
        blockTimestamps: RETH_PROVEN_BLOCKS.filter((block) => block >= nextBatch).map((block) => expected.blocks[block - 1].timestamp),
        maxBlockAge: options.maxBlockAge,
        escapeTimeout: options.escapeTimeout,
        now: nowSeconds(),
        messagesLeft,
        oldestPendingAt,
        secondsPerMessage: options.secondsPerMessage,
        marginSeconds: options.marginSeconds,
        maxWaitSeconds: options.maxWaitSeconds,
    });
}

/** Сколько сообщений осталось до приёма последнего батча: очередь, данные (с запасом — все порции) и батчи. */
const messagesLeft = (run: Run, plan: QueueStep[], head: number, nextBatch: number) =>
    plan.filter(({ item }) => item.number > head).length +
    run.dataChunks.slice(nextBatch - 1).reduce((total, count) => total + count, 0) +
    (LAST - nextBatch + 1);

/** Сколько монет уйдёт с кошелька на оставшийся путь до последнего батча (без комиссий кошелька). */
const normalPathCost = (run: Run, plan: QueueStep[], head: number, nextBatch: number, prices: CyclePrices) =>
    plan.filter(({ item }) => item.number > head).reduce((total, { value }) => total + value, 0n) +
    BigInt(run.dataChunks.slice(nextBatch - 1).reduce((total, count) => total + count, 0)) * prices.publishData +
    BigInt(LAST - nextBatch + 1) * prices.submitBatch;

async function deployAndKey(run: Run, key: ExpectedRollupKey, prices: CyclePrices) {
    const { provider, ui, rollup } = run;
    const sender = provider.sender();
    if (!(await provider.isContractDeployed(rollup.address))) {
        ui.write('Развёртывание');
        await rollup.sendDeploy(sender, prices.deploy);
        await provider.waitForDeploy(rollup.address);
    }
    if ((await rollup.getKeyHash()) !== 0n) return;
    const parts = Bn254Groth16Verifier.keyParts(key.upload);
    const contractData = async (): Promise<Cell> => {
        const { state } = await provider.getContractState(rollup.address);
        if (state.type !== 'active' || !state.data) throw new Error('контракт не развёрнут');
        return Cell.fromBoc(state.data)[0];
    };
    const missing = async () => {
        const uploaded = Rollup.uploadedKeyPartHashes(await contractData());
        return parts.filter(({ slot, part }) => uploaded.get(slot) !== part.hash().toString('hex'));
    };
    for (const { slot, part } of await missing()) {
        ui.write(`Часть ключа, номер ${slot}`);
        await rollup.sendUploadKeyPart(sender, { slot, part, value: prices.keyPart });
        const hash = part.hash().toString('hex');
        await waitFor(`часть ключа ${slot} в контракте`, async () => Rollup.uploadedKeyPartHashes(await contractData()).get(slot) === hash);
    }
    // До фиксации часть можно перезаписать, после — ключ неизменяем: сверка всех частей заново.
    if ((await missing()).length > 0) throw new Error('Части ключа в контракте изменились во время загрузки: запусти скрипт ещё раз.');
    ui.write('Фиксация ключа');
    await rollup.sendFinalizeKey(sender, { key: key.upload, value: prices.keyFinalize });
    await waitFor(
        'ключ зафиксирован (7321 в обозревателе — параметры развёртывания вне границ, 7333 — начальное состояние не каноническое)',
        async () => (await rollup.getKeyHash()) !== 0n,
    );
}

/** Сверка развёртывания: код, начальные данные, параметры и ключ — те, что ожидаются (wrappers/rollupDeployment.ts). */
async function verifyDeployment(run: Run, config: RollupConfig, code: Cell, key: ExpectedRollupKey) {
    const onchain = await readOnchainRollup(run.rollup);
    const problems = [
        ...deploymentMismatches(onchain, { config, code, key }),
        ...deploymentBoundMismatches(onchain.deployment, {
            minEscapeTimeout: config.escapeTimeout,
            maxEscapeTimeout: config.escapeTimeout,
            maxBlockAge: config.maxBlockAge,
        }),
    ];
    if (problems.length > 0) throw new Error(`Развёртывание НЕ сошлось с ожидаемым:\n  - ${problems.join('\n  - ')}`);
    run.ui.write('Развёртывание сверено: код, начальные данные, параметры и ключ — ожидаемые.');
}

/** Ставит в очередь L1 элементы цепочки, нужные батчу `batch`: по порядку номеров, с ожиданием отметки после каждого. */
async function enqueueFor(run: Run, batch: number, plan: QueueStep[], hashes: bigint[]) {
    const { rollup, ui } = run;
    const sender = run.provider.sender();
    let head = (await rollup.getDepositQueue()).head;
    const steps = plan.filter(({ item, beforeBatch }) => beforeBatch <= batch && item.number > Number(head.count));
    if (steps.length === 0) return;
    // Плата за место — из расчёта (та же формула, что в контракте); базовые значения сверяются с
    // контрактом один раз на отрезок, чтобы не тратить окно на запрос перед каждым элементом.
    const fees = await rollup.getQueueFees();
    if (steps[0].fee !== (steps[0].item.kind === 'deposit' ? fees.depositFee : fees.forceTransactionFee)) {
        throw new Error(`Плата за место в очереди у контракта (${ton(fees.depositFee)} / ${ton(fees.forceTransactionFee)}) не та, что в расчёте: цены сети изменились либо очередь не та.`);
    }
    for (const { item, fee, value } of steps) {
        if (item.kind === 'deposit') {
            ui.write(`Очередь L1, элемент ${item.number} (батч ${item.batch}): депозит ${ton(BigInt(item.amount))} на счёт L2 ${item.l2Recipient}`);
            await rollup.sendDeposit(sender, { l2Recipient: BigInt(item.l2Recipient), value, maxFee: fee });
        } else {
            ui.write(`Очередь L1, элемент ${item.number} (батч ${item.batch}): принудительная транзакция «${item.label}»`);
            await rollup.sendForceTransaction(sender, { l2Transaction: forcedTransactionCell(hexBytes(item.bytes)), value });
        }
        await waitFor(
            `элемент ${item.number} в очереди (7326 в обозревателе — плата выросла, 7307 — мало монет, 7319 — форма транзакции, 7312 — rollup заморожен)`,
            async () => (await rollup.getDepositQueue()).head.count >= BigInt(item.number),
        );
        head = (await rollup.getDepositQueue()).head;
        if (head.count !== BigInt(item.number) || head.hash !== hashes[item.number]) {
            throw new Error(`Очередь L1 после элемента ${item.number} не та, что у цепочки (в неё встал посторонний элемент): батчи этой цепочки контракт не примет.`);
        }
    }
}

/** Публикует данные блока и отправляет батч по пруфу; перед отправкой — сверка публичного входа и времени. */
async function publishAndSubmit(run: Run, number: number, batch: ProvenEvmBatch, plan: QueueStep[], prices: CyclePrices) {
    const { rollup, ui } = run;
    const sender = run.provider.sender();
    const prefixes = batch.dataChunks.reduce((hashes, chunk) => [...hashes, dataHashStep(hashes[hashes.length - 1], chunk)], [0n]);
    const published = prefixes.indexOf(await rollup.getBatchDataHash(number));
    if (published < 0) throw new Error(`В контракте опубликованы другие данные батча ${number}.`);
    for (let index = published; index < batch.dataChunks.length; index++) {
        ui.write(`Данные батча ${number}: порция ${index + 1} из ${batch.dataChunks.length}`);
        await rollup.sendPublishData(sender, { batchIndex: number, data: batch.dataChunks[index], value: prices.publishData });
        await waitFor('порция данных учтена', async () => (await rollup.getBatchDataHash(number)) === prefixes[index + 1]);
    }
    // Пруф привязан к очереди L1, данным и хранилищу: если контракт соберёт другой публичный
    // вход, слать пруф бессмысленно (отказ 7006 за полный газ).
    if ((await rollup.getExpectedPublicInput(batch.roots)) !== batch.publicInputs[1]) {
        throw new Error(`Батч ${number}: контракт ждёт другой публичный вход, чем в пруфе (очередь L1, данные или состояние не те).`);
    }
    // Находка 16-2: батч отправляется, только если до закрытия окна успеть принять и все следующие.
    const head = Number((await rollup.getDepositQueue()).head.count);
    const left = messagesLeft(run, plan, head, number) - batch.dataChunks.length;
    const time = await timeFor(run, number, left);
    if (time.action !== 'go') throw new Error(`Батч ${number} НЕ отправлен: ${time.reason}.`);
    ui.write(`Батч ${number}: пруф SP1 блока ${number} (${time.reason})`);
    await rollup.sendSubmitBatch(sender, { proof: batch.proof, hints: Cell.fromBase64(batch.hinted.hintsBoc), roots: batch.roots, value: prices.submitBatch });
    await waitFor(
        `батч ${number} принят (в обозревателе: −14 — не хватило газа, 7003–7010 — отказ верификатора, 7300 — пруф не подтвердил утверждение, 7329 — время блока ещё не наступило, 7330 — блок старше maxBlockAge)`,
        async () => (await rollup.getRollupState()).batchIndex >= number,
    );
    const state = await rollup.getRollupState();
    if (state.batchIndex !== number || state.stateRoot !== batch.roots.newStateRoot || state.withdrawalsRoot !== batch.roots.withdrawalsRoot) {
        throw new Error(`После батча ${number} состояние контракта не то, что заявлял батч.`);
    }
}

/** Обычный путь: окно времени, затем для каждого непринятого батча — очередь, данные, пруф. */
async function normalPath(run: Run, plan: QueueStep[], prices: CyclePrices) {
    const { rollup, ui, expected } = run;
    const batches = RETH_PROVEN_BLOCKS.map(loadProvenRethBatch);
    const hashes = queueHashes(expected);
    for (let number = (await rollup.getRollupState()).batchIndex + 1; number <= LAST; number++) {
        const head = (await rollup.getDepositQueue()).head;
        const lastHead = expected.blocks[LAST - 1].headAtBatch;
        if (Number(head.count) > lastHead || head.hash !== hashes[Number(head.count)]) {
            throw new Error('Очередь L1 контракта — не начало очереди цепочки: в неё встал посторонний элемент.');
        }
        let time = await timeFor(run, number, messagesLeft(run, plan, Number(head.count), number));
        if (time.action === 'wait') {
            ui.write(`Жду открытия окна: ${time.reason}`);
            await sleep(time.waitSeconds * 1000);
            time = await timeFor(run, number, messagesLeft(run, plan, Number(head.count), number));
        }
        if (time.action !== 'go') throw new Error(`Перед батчем ${number}: ${time.reason}.`);
        ui.write(`Батч ${number}: ${time.reason}`);
        await enqueueFor(run, number, plan, hashes);
        await publishAndSubmit(run, number, batches[RETH_PROVEN_BLOCKS.indexOf(number)], plan, prices);
    }
}

/** Развёрнутый нуллификатор ещё ничего не значит: смотрим, погашена ли заявка. */
const isClaimed = async (run: Run, nullifier: Address) =>
    (await run.provider.isContractDeployed(nullifier)) && (await run.provider.open(RollupNullifier.createFromAddress(nullifier)).getIsClaimed());

/**
 * Заявка на выплату кошельку прогона: отправить, дождаться пометки в нуллификаторе, затем —
 * самой выплаты (по балансу кошелька, с допуском) либо записи долга. Долг — отказ.
 */
async function settle(run: Run, what: string, claim: { key: bigint; nullifier: Address; amount: bigint; value: bigint }, send: () => Promise<void>) {
    const { rollup, ui, owner } = run;
    const owed = async () => (await rollup.getOwedPayout(claim.key)) !== null;
    if (await isClaimed(run, claim.nullifier)) {
        if (await owed()) throw new Error(`${what}: заявка погашена, но не оплачена — за контрактом записан долг (сообщение PayOwed после пополнения контракта).`);
        ui.write(`${what}: погашено в прежнем запуске, долга нет (выплата — в отчёте zk/testnet-reth-report.mjs).`);
        return;
    }
    const before = await balanceOf(run, owner);
    ui.write(`${what}: ${ton(claim.amount)}`);
    await send();
    await waitFor(
        `${what}: заявка погашена в нуллификаторе (в обозревателе: 7320 у rollup — нет баланса, 7203 у нуллификатора — мало монет, 7308 — доказательство Merkle, 7400–7406 — отказ проверки счёта EVM)`,
        () => isClaimed(run, claim.nullifier),
    );
    // Допуск: комиссии кошелька за отправку и плата за хранение, удержанная с получателя.
    const tolerance = claim.amount / 2n < 20_000_000n ? claim.amount / 2n : 20_000_000n;
    let indebted = false;
    await waitFor(`${what}: выплата дошла на кошелёк`, async () => {
        indebted = await owed();
        return indebted || payoutArrived({ before, after: await balanceOf(run, owner), sent: claim.value, amount: claim.amount, tolerance });
    });
    if (indebted) throw new Error(`${what}: заявка погашена, но не оплачена — контракту не хватило баланса, долг записан в контракте.`);
}

/** Вывод через мост по каждому листу дерева выводов, принятому батчами. */
async function withdrawLeaves(run: Run, batchIndex: number, prices: CyclePrices) {
    const { rollup, owner } = run;
    const leaves = leavesUpTo(run.expected, batchIndex);
    if (leaves.length === 0) return 0n;
    const tree = withdrawalTree(leaves);
    if (tree.root !== (await rollup.getRollupState()).withdrawalsRoot) throw new Error('Корень дерева выводов в контракте не тот, что дают листья цепочки.');
    for (const leaf of leaves) {
        const claim = { key: BigInt(leaf.leafIndex), nullifier: await rollup.getNullifierAddress(leaf.leafIndex), amount: leaf.amount, value: prices.withdraw };
        await settle(run, `Вывод через мост, лист ${leaf.leafIndex}`, claim, () =>
            rollup.sendWithdraw(run.provider.sender(), {
                leafIndex: leaf.leafIndex, recipient: owner, amount: leaf.amount,
                merkleProof: merkleProofCell(tree.proofFor(leaf.leafIndex)), value: prices.withdraw,
            }),
        );
    }
    return leaves.reduce((total, leaf) => total + leaf.amount, 0n);
}

/** Секвенсор «пропал»: необработанный элемент очереди ждёт дольше срока, rollup замораживается. */
async function freeze(run: Run, prices: CyclePrices) {
    const { rollup, ui } = run;
    const sender = run.provider.sender();
    if ((await rollup.getEscapeState()).frozen) return;
    const queue = await rollup.getDepositQueue();
    if (queue.head.count === queue.processed.count) {
        const { depositFee } = await rollup.getQueueFees();
        ui.write(`Поздний депозит ${ton(prices.lateDeposit)} — его никто не обработает`);
        await rollup.sendDeposit(sender, { l2Recipient: 0xdeadn, value: prices.lateDeposit, maxFee: depositFee });
        await waitFor('поздний депозит в очереди', async () => (await rollup.getDepositQueue()).head.count > queue.head.count);
    }
    for (;;) {
        const escape = await rollup.getEscapeState();
        if (escape.oldestPendingAt === 0) throw new Error('В очереди нет необработанного элемента: срок заморозки не идёт. Запусти скрипт ещё раз.');
        // Запас: время блока L1 отстаёт от часов этой машины, а контракт требует строго больше срока.
        const left = escape.oldestPendingAt + escape.timeout + run.options.marginSeconds - nowSeconds();
        if (left <= 0) break;
        ui.write(`Жду срок заморозки: осталось ${Math.ceil(left / 60)} мин`);
        await sleep(Math.min(left, 300) * 1000);
    }
    ui.write("Заморозка rollup'а");
    await rollup.sendActivateEscapeHatch(sender, prices.escapeService);
    await waitFor('rollup заморожен (7314 в обозревателе — срок по часам сети ещё не вышел: повтори запуск)', async () => (await rollup.getEscapeState()).frozen);
}

/** Аварийные выходы счетов L2 против блока последнего принятого батча: заголовок, доказательство счёта, подпись. */
async function exitAccounts(run: Run, batchIndex: number, prices: CyclePrices) {
    const { rollup, ui, owner, expected } = run;
    const entry = expected.exitsByBlock.find(({ block }) => block === batchIndex);
    if (!entry || entry.exits.length === 0) {
        if (batchIndex > 0) ui.write(`Против блока ${batchIndex} согласий на выход в цепочке нет (REVIEW.md, 16-2): балансы счетов L2 этим прогоном не вернуть.`);
        return 0n;
    }
    if ((await rollup.getEvmExitConsentHash(BigInt(expected.exitRecipientHash))) !== BigInt(entry.consentHash)) {
        throw new Error('Контракт считает хеш согласия на выход иначе, чем цепочка: подписи не подойдут.');
    }
    let exited = 0n;
    for (const exit of entry.exits) {
        const account = BigInt(exit.account);
        const amount = BigInt(exit.balanceWei) / WEI_PER_NANOTON;
        const claim = { key: exitNullifierKey(account), nullifier: await rollup.getExitNullifierAddress(account), amount, value: prices.evmExit };
        await settle(run, `Аварийный выход счёта ${exit.account}`, claim, () =>
            rollup.sendForceExitEvm(run.provider.sender(), { recipient: owner, ...exitCells(batchIndex, exit), value: prices.evmExit }),
        );
        exited += amount;
    }
    return exited;
}

/** Возврат вносителю депозитов, не попавших в батч до заморозки (по квитанциям). */
async function refundDeposits(run: Run, prices: CyclePrices) {
    const { rollup, ui } = run;
    const queue = await rollup.getDepositQueue();
    let refunded = 0n;
    for (let index = Number(queue.processed.count) + 1; index <= Number(queue.head.count); index++) {
        const receipt = await rollup.getDepositReceipt(index);
        if (receipt === null) continue; // принудительная транзакция либо уже возвращённый депозит
        if (!receipt.depositor.equals(run.owner)) {
            ui.write(`Депозит №${index} внесён не этим кошельком: его возвращает вноситель.`);
            continue;
        }
        ui.write(`Возврат необработанного депозита №${index}: ${ton(receipt.amount)}`);
        await rollup.sendCancelDeposit(run.provider.sender(), { depositIndex: index, value: prices.escapeService });
        await waitFor(`депозит №${index} возвращён (7320 в обозревателе — контракту не хватило баланса)`, async () => (await rollup.getDepositReceipt(index)) === null);
        refunded += receipt.amount;
    }
    return refunded;
}

/** Цены по get-методам развёрнутого контракта: минимумы шагов выплаты и базовая плата за место. */
async function onchainPrices(rollup: OpenedContract<Rollup>): Promise<CyclePrices> {
    const [budgets, minimums, exitBudget] = [await rollup.getQueueBudgets(), await rollup.getMinimumValues(), await rollup.getEvmExitBudget()];
    return { ...ESTIMATED_PRICES, forceTransactionFee: budgets.forceTransactionFee, withdraw: minimums.withdraw, evmExit: exitBudget.minValue };
}

export async function run(provider: NetworkProvider, args: string[]) {
    assertTestnetWithMnemonic(provider);
    const ui = provider.ui();
    const options = parseOptions(args);
    const owner = provider.sender().address;
    if (!owner) throw new Error('У отправителя нет адреса: подключи кошелёк.');

    // --- предполётные проверки: до любой отправки ---
    const blocker = proofFixturesBlocker();
    const status = blocker ? { current: false, reason: blocker } : rethProofStatus();
    const expected = loadRethExpected();
    const key = loadEvmRollupKey();
    const code = await compile('Rollup');
    const config: RollupConfig = {
        owner,
        sequencer: owner,
        nullifierCode: await compile('RollupNullifier'),
        // Начальное слово состояния — хеш заголовка генезиса цепочки: контракт сверит его со своей константой.
        genesisStateRoot: BigInt(expected.genesisHash),
        chainId: BigInt(expected.chainId),
        escapeTimeout: options.escapeTimeout,
        maxBlockAge: options.maxBlockAge,
    };
    const rollup = provider.open(Rollup.createFromConfig(config, code));
    if (options.address && !options.address.equals(rollup.address)) {
        throw new Error(`Заданный адрес ${options.address.toString()} — не контракт этого кошелька с этими параметрами (получился бы ${rollup.address.toString()}).`);
    }
    const dataChunks = RETH_PROVEN_BLOCKS.map((block) => dataChunksOf(loadRethBatchReport(block)).length);
    const context: Run = { provider, ui, owner, rollup, expected, options, dataChunks };
    ui.write(`Rollup-контракт (полный цикл протокола v2 на блоках Reth): ${rollup.address.toString()}`);

    const deployed = await provider.isContractDeployed(rollup.address);
    const keyed = deployed && (await rollup.getKeyHash()) !== 0n;
    const batchIndex = deployed ? (await rollup.getRollupState()).batchIndex : 0;
    const frozen = deployed && (await rollup.getEscapeState()).frozen;
    const startBalance = await balanceOf(context, owner);
    let prices = keyed ? await onchainPrices(rollup) : ESTIMATED_PRICES;
    let plan = queuePlan(expected, LAST, prices);

    if (options.mode !== 'escape') {
        const batches = status.current ? RETH_PROVEN_BLOCKS.map(loadProvenRethBatch) : [];
        const need = walletNeed(expected, {
            lastBatch: LAST, keyParts: Bn254Groth16Verifier.keyParts(key.upload).length, dataChunks, prices,
            walletFees: status.current ? walletFeesEstimate(expected, key, batches, plan) : 0n,
        });
        const head = deployed ? Number((await rollup.getDepositQueue()).head.count) : 0;
        // Развёртывание и ключ, если их ещё нет, тоже займут время: запуск может прийтись на само окно.
        const setupMessages = keyed ? 0 : Bn254Groth16Verifier.keyParts(key.upload).length + 2;
        const time = batchIndex < LAST ? await timeFor(context, batchIndex + 1, setupMessages + messagesLeft(context, plan, head, batchIndex + 1)) : null;
        printNeed(ui, need, startBalance);
        if (time) ui.write(`Время: ${time.reason}`);
        for (const gap of exitGaps(expected, LAST)) {
            ui.write(`ВНИМАНИЕ (16-2): против блока ${gap.block} согласий на выход нет. Если прогон встанет сразу после батча ${gap.block}, ${ton(gap.lockedNano)} депозитов, уже зачисленных на L2, вернуть будет нечем.`);
        }
        const refusals = preflightRefusals({
            proofs: status,
            timeConfig: timeConfigProblems(options.maxBlockAge, options.escapeTimeout),
            recipient: recipientProblems(expected, owner.hash.toString('hex'), LAST),
            need,
            // Начатый прогон часть потребности уже оплатил: полную сумму требуем только до развёртывания.
            balance: deployed ? need.total : startBalance,
            time,
        });
        // Начатый прогон: на оставшийся путь до последнего батча монеты обязаны быть сейчас —
        // остановка между батчами обходится дороже всего.
        const pathCost = batchIndex < LAST ? normalPathCost(context, plan, head, batchIndex + 1, prices) : 0n;
        if (deployed && startBalance < pathCost) {
            refusals.push(`на кошельке ${ton(startBalance)}, а на оставшийся путь до батча ${LAST} нужно ${ton(pathCost)} и комиссии`);
        }
        if (frozen && batchIndex < LAST) refusals.push('rollup уже заморожен, а батчи приняты не все: обычный путь закрыт');
        if (refusals.length > 0) {
            throw new Error(`Прогон не начат, ничего не отправлено:\n  - ${refusals.join('\n  - ')}${deployed ? `\n${ESCAPE_ADVICE}` : ''}`);
        }
        if (options.mode === 'check') {
            ui.write('Предполётные проверки пройдены. Режим check: ничего не отправлено.');
            return;
        }
    } else if (!deployed) {
        throw new Error('Режим escape: контракт не развёрнут, возвращать нечего.');
    }

    // --- развёртывание, ключ и сверка развёртывания ---
    if (options.mode === 'run') await deployAndKey(context, key, prices);
    await verifyDeployment(context, config, code, key);
    prices = await onchainPrices(rollup);
    plan = queuePlan(expected, LAST, prices);

    // --- обычный путь: очередь L1, данные и батчи ---
    if (options.mode === 'run') {
        try {
            await normalPath(context, plan, prices);
        } catch (error) {
            const cause = error instanceof Error ? error.message : String(error);
            const done = (await rollup.getRollupState()).batchIndex;
            throw new Error(
                `Обычный путь остановился (принято батчей: ${done} из ${LAST}): ${cause}\n` +
                    'Если причина — сбой сети или API, а окно времени ещё открыто, запусти скрипт ещё раз тем же способом: он продолжит с этого шага. ' +
                    `Иначе — аварийный путь. ${ESCAPE_ADVICE}`,
            );
        }
    }
    const accepted = (await rollup.getRollupState()).batchIndex;
    if (options.mode === 'run' && accepted !== LAST) throw new Error(`Принято батчей ${accepted}, ожидалось ${LAST}.\n${ESCAPE_ADVICE}`);

    // --- вывод через мост, заморозка, аварийные выходы, возврат депозитов ---
    const withdrawn = await withdrawLeaves(context, accepted, prices);
    await freeze(context, prices);
    const exited = await exitAccounts(context, accepted, prices);
    const refunded = await refundDeposits(context, prices);

    const endBalance = await balanceOf(context, owner);
    ui.write(
        `Итог: батчей принято ${accepted} из ${LAST}; выводы через мост ${ton(withdrawn)}, аварийные выходы ${ton(exited)}, возвращено депозитов ${ton(refunded)} ` +
            '(суммы — по шагам цепочки, включая сделанные в прежних запусках).',
    );
    ui.write(`Кошелёк: было ${ton(startBalance)}, стало ${ton(endBalance)} за этот запуск.`);
    ui.write(
        options.mode === 'run'
            ? 'Готово: очередь L1, три батча по пруфам, выводы через мост, заморозка, аварийные выходы и возврат депозита.'
            : 'Готово (режим escape): rollup заморожен, возвращено всё, что возвращается.',
    );
    ui.write(`Газ и выплаты: node zk/testnet-reth-report.mjs ${rollup.address.toString()}`);
}
