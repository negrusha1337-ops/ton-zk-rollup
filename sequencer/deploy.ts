import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { Address, beginCell, Cell, fromNano, SenderArguments } from '@ton/core';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import { PROTOCOL_VERSION } from '../wrappers/protocolVersion';
import { Rollup, RollupConfig } from '../wrappers/Rollup';
import { deploymentBoundMismatches, deploymentMismatches, ExpectedRollupKey, readOnchainRollup } from '../wrappers/rollupDeployment';
import { DEPLOY_VALUE, KEY_FINALIZE_VALUE, KEY_PART_VALUE } from '../wrappers/rollupValues';
import { estimateWalletFees, ForwardPrices, timeConfigProblems } from '../wrappers/testnetPlan';
import { childEnv } from './children';
import { DEFAULT_EXPECTED_CHECK_TIME, startBudgetProblem } from './deadline';
import { GENESIS_HASH } from './protocol';
import { DEFAULT_SUBMIT_MARGIN } from './service';
import { lockStateDir } from './state';
import { Effect, TestnetSubmitter, TestnetSubmitterOptions } from './submitter';
import { AccountSnapshot, rollupOn, SequencerWallet, TESTNET_GLOBAL_ID, TonChain } from './ton';

// Развёртывание rollup-контракта протокола v2 кошельком сервиса (`sequencer/main.ts deploy`):
// владелец и секвенсор — этот кошелёк; chainId и генезис — цепочки Reth
// (fixtures/evm_batches/reth/expected.json): узел сервиса строит свою цепочку от того же генезиса
// протокола (sequencer/protocol.ts, GENESIS_HASH) с тем chainId, что прочитает у контракта; ключ —
// fixtures/evm_batches/key.json частями и FinalizeKey; в конце — сверка развёртывания
// (wrappers/rollupDeployment.ts, как scripts/verifyRollupDeployment.ts).
//
// Сообщения идут тем же отправщиком, что батчи (TestnetSubmitter.send): исходящий журнал
// stateDir/outbox.json ДО отправки, монотонные снимки, ожидание следствия по состоянию контракта.
// Поэтому прерванное развёртывание продолжается без дублей: что уже сделано, видно у контракта
// (счёт активен, хеши загруженных частей, хеш ключа), а сообщение в пути доводится журналом.
//
// Адрес контракта = хеш (код, начальные данные), а в данных — кошелёк, chainId, срок заморозки и
// возраст блока: другие параметры — другой адрес. Адрес печатается до первой отправки.

/** Срок заморозки по умолчанию: 6 ч — суточный прогон на ноутбуке не замёрзнет от короткого простоя. */
export const DEFAULT_ESCAPE_TIMEOUT = 6 * 3600;
/** Возраст блока по умолчанию: час — пруф (1800 с), проверка (300 с) и запас (300 с) помещаются. */
export const DEFAULT_MAX_BLOCK_AGE = 3600;
/** Наибольшее значение полей срока в начальных данных (uint32). */
const UINT32_MAX = 2 ** 32 - 1;

/** Отказ до первой отправки (или посреди, если контракт повёл себя не так): причина — в тексте. */
export class DeployRefused extends Error {}

export type DeployParams = { escapeTimeout: number; maxBlockAge: number; expectedProofTime: number };

/** Цепочка, под которую развёртывается контракт: chainId и хеш генезиса (подмножество expected.json). */
export type ChainSource = { chainId: string; genesisHash: string };

export type DeployInputs = {
    chain: TonChain;
    wallet: SequencerWallet;
    stateDir: string;
    params: DeployParams;
    dryRun: boolean;
    log: (line: string) => void;
    code: Cell;
    nullifierCode: Cell;
    key: ExpectedRollupKey;
    chainSource: ChainSource;
    forward: ForwardPrices;
    /** Наименьший остаток на кошельке после развёртывания: сервису на первые батчи (MIN_WALLET_BALANCE). */
    reserve: bigint;
    /** Сверка key.json с исходниками; null — сходится. По умолчанию — zk/gen-evm-rollup-key.mjs --check. */
    keyCheck?: () => string | null;
    /** Параметры отправщика для тестов: пауза опроса, часы. */
    submitter?: Partial<Pick<TestnetSubmitterOptions, 'pollMs' | 'pollAttempts' | 'now' | 'messageTtl'>>;
};

export type DeployResult = { address: Address; status: 'dry-run' | 'deployed' | 'already'; sent: number };

const ROOT = path.join(__dirname, '..');
const ton = (nano: bigint) => `${fromNano(nano)} TON`;
const friendly = (address: Address) => address.toString({ testOnly: true });

/** Сверка key.json с исходниками программы и закреплённым верификатором (то же, что в check). */
export function defaultKeyCheck(): string | null {
    try {
        execFileSync(process.execPath, [path.join(ROOT, 'zk', 'gen-evm-rollup-key.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe', env: childEnv() });
        return null;
    } catch (error) {
        return String((error as { stderr?: Buffer }).stderr ?? error).trim().split('\n').pop() ?? 'gen-evm-rollup-key --check не прошёл';
    }
}

/** Цены пересылки basechain из снимка конфига сети (bench/network-config.json). */
export const networkForwardPrices = (): ForwardPrices =>
    JSON.parse(readFileSync(path.join(ROOT, 'bench', 'network-config.json'), 'utf8')).basechain.forward;

/** Чем параметры и файлы не годятся для развёртывания — без сети. Пустой список — годятся. */
export function deployConfigProblems(params: DeployParams, chainSource: ChainSource, key: ExpectedRollupKey): string[] {
    const problems: string[] = [];
    for (const [name, value] of [['--escape-timeout', params.escapeTimeout], ['--max-block-age', params.maxBlockAge]] as const)
        if (!Number.isInteger(value) || value <= 0 || value > UINT32_MAX) problems.push(`${name} ${value} — не целое число секунд от 1 до ${UINT32_MAX}`);
    // Границы контракта: FinalizeKey откажет (7321) — ключ не зафиксируется, монеты на части уйдут зря.
    problems.push(...timeConfigProblems(params.maxBlockAge, params.escapeTimeout).map((problem) => `контракт не зафиксирует ключ: ${problem}`));
    // Условие сервиса: проверка кандидата, пруф и запас — меньше maxBlockAge (deadline.ts).
    const budget = startBudgetProblem({
        proofTime: params.expectedProofTime,
        checkTime: DEFAULT_EXPECTED_CHECK_TIME,
        submitMargin: DEFAULT_SUBMIT_MARGIN,
        maxBlockAge: params.maxBlockAge,
    });
    if (budget) problems.push(`сервис не запустится: ${budget}`);
    // Генезис цепочки Reth обязан быть генезисом протокола: от него узел сервиса строит свою цепочку,
    // и с ним контракт сверяет начальное слово состояния при FinalizeKey (7333).
    if (BigInt(chainSource.genesisHash) !== BigInt(GENESIS_HASH))
        problems.push(`генезис цепочки Reth (expected.json) ${chainSource.genesisHash}, а константа протокола сервиса ${GENESIS_HASH}`);
    if (!/^\d+$/.test(chainSource.chainId) || BigInt(chainSource.chainId) === 0n || BigInt(chainSource.chainId) >= 2n ** 64n)
        problems.push(`chainId цепочки Reth «${chainSource.chainId}» — не число от 1 до 2^64 − 1`);
    if (key.file.protocolVersion !== PROTOCOL_VERSION)
        problems.push(`key.json выведен для протокола v${key.file.protocolVersion}, а сервис — протокола v${PROTOCOL_VERSION}`);
    return problems;
}

/** Ожидаемая конфигурация контракта: владелец и секвенсор — кошелёк сервиса. */
export const deployConfig = (inputs: Pick<DeployInputs, 'wallet' | 'params' | 'nullifierCode' | 'chainSource'>): RollupConfig => ({
    owner: inputs.wallet.address,
    sequencer: inputs.wallet.address,
    nullifierCode: inputs.nullifierCode,
    genesisStateRoot: BigInt(inputs.chainSource.genesisHash),
    chainId: BigInt(inputs.chainSource.chainId),
    escapeTimeout: inputs.params.escapeTimeout,
    maxBlockAge: inputs.params.maxBlockAge,
});

/** Что уже есть по адресу: ничего, начатое этим кошельком развёртывание, законченное. */
type Existing = { kind: 'absent' } | { kind: 'partial'; uploaded: Map<number, string> } | { kind: 'done' };

/**
 * Состояние счёта по адресу контракта. Активный контракт с другим состоянием — отказ: другой код
 * или параметры (по адресу их быть не может, если адрес выведен из этих же кода и данных, — но
 * проверяется то, что есть, а не то, что должно быть), зафиксирован другой ключ, без ключа уже
 * есть батчи или очередь.
 */
async function existingAt(address: Address, snapshot: AccountSnapshot, inputs: DeployInputs, config: RollupConfig): Promise<Existing> {
    if (snapshot.state === 'frozen') throw new DeployRefused(`по адресу ${friendly(address)} — замороженный счёт (долг за хранение): развёртывать некуда`);
    if (snapshot.state !== 'active' || !snapshot.code || !snapshot.data) return { kind: 'absent' };
    const problems: string[] = [];
    if (!snapshot.code.equals(inputs.code)) problems.push('код не тот, что собран из contracts/rollup.tolk');
    const onchain = await rollupOn(address, snapshot)(async (rollup) => ({
        deployment: await rollup.getDeployment(),
        keyHash: await rollup.getKeyHash(),
        state: await rollup.getRollupState(),
        queue: await rollup.getDepositQueue(),
    })).catch((error) => {
        throw new DeployRefused(`по адресу ${friendly(address)} уже активен контракт, а get-методы rollup'а на нём не исполняются: ${(error as Error).message}`);
    });
    const { deployment } = onchain;
    if (!deployment.owner.equals(config.owner)) problems.push(`владелец ${friendly(deployment.owner)}, а не кошелёк сервиса`);
    if (!deployment.sequencer.equals(config.sequencer)) problems.push(`секвенсор ${friendly(deployment.sequencer)}, а не кошелёк сервиса`);
    if (deployment.chainId !== config.chainId) problems.push(`chainId ${deployment.chainId}, а не ${config.chainId}`);
    if (deployment.escapeTimeout !== config.escapeTimeout) problems.push(`срок заморозки ${deployment.escapeTimeout} с, а не ${config.escapeTimeout} с`);
    if (deployment.maxBlockAge !== config.maxBlockAge) problems.push(`возраст блока ${deployment.maxBlockAge} с, а не ${config.maxBlockAge} с`);
    if (deployment.nullifierCodeHash !== BigInt('0x' + config.nullifierCode.hash().toString('hex'))) problems.push('код нуллификатора не тот');
    if (onchain.keyHash !== 0n && onchain.keyHash !== inputs.key.keyHash)
        problems.push(`зафиксирован ключ 0x${onchain.keyHash.toString(16)}, а не ключ из key.json`);
    if (onchain.keyHash === 0n && (onchain.state.batchIndex > 0 || onchain.queue.head.count > 0n))
        problems.push(`ключа нет, а батчей ${onchain.state.batchIndex} и элементов очереди ${onchain.queue.head.count}`);
    if (problems.length > 0)
        throw new DeployRefused(`по адресу ${friendly(address)} уже активен контракт с другим состоянием: ${problems.join('; ')}. Ничего не отправлено`);
    return onchain.keyHash === 0n ? { kind: 'partial', uploaded: Rollup.uploadedKeyPartHashes(snapshot.data) } : { kind: 'done' };
}

/** Шаги, которые осталось сделать: сообщение, его следствие и сумма. */
type Step = { what: string; message: SenderArguments; effect: Effect };

function remainingSteps(rollup: Rollup, existing: Existing, key: ExpectedRollupKey): Step[] {
    if (existing.kind === 'done') return [];
    const steps: Step[] = [];
    if (existing.kind === 'absent')
        steps.push({
            what: 'развёртывание контракта',
            // bounce: false — у неразвёрнутого адресата отскок вернул бы монеты без StateInit.
            message: { to: rollup.address, value: DEPLOY_VALUE, bounce: false, init: rollup.init, body: beginCell().endCell() },
            effect: { kind: 'deployed' },
        });
    const uploaded = existing.kind === 'partial' ? existing.uploaded : new Map<number, string>();
    for (const { slot, part } of Bn254Groth16Verifier.keyParts(key.upload)) {
        const hash = part.hash().toString('hex');
        if (uploaded.get(slot) === hash) continue;
        steps.push({
            what: `часть ключа ${slot}`,
            message: { to: rollup.address, value: KEY_PART_VALUE, bounce: true, body: Bn254Groth16Verifier.buildUploadBody(slot, part) },
            effect: { kind: 'keyPart', slot, hash },
        });
    }
    steps.push({
        what: 'фиксация ключа (FinalizeKey)',
        message: { to: rollup.address, value: KEY_FINALIZE_VALUE, bounce: true, body: Bn254Groth16Verifier.buildFinalizeBody(key.upload) },
        effect: { kind: 'keyHash', value: key.keyHash },
    });
    return steps;
}

/** Сколько монет уйдёт с кошелька на шаги: суммы сообщений и комиссии кошелька (оценка сверху). */
export function stepsCost(steps: Step[], forward: ForwardPrices): { values: bigint; fees: bigint } {
    const values = steps.reduce((total, step) => total + step.message.value, 0n);
    const bodies = steps.map((step) =>
        step.message.init
            ? beginCell().storeRef(step.message.init.code!).storeRef(step.message.init.data!).endCell()
            : (step.message.body ?? beginCell().endCell()),
    );
    return { values, fees: steps.length === 0 ? 0n : estimateWalletFees(bodies, 0, forward) };
}

/** Номера частей ключа, которых в контракте нет или которые не те (по снимку отправщика). */
async function wrongKeyParts(submitter: TestnetSubmitter, key: ExpectedRollupKey): Promise<number[]> {
    const snapshot = await submitter.snapshot();
    const uploaded = snapshot.data ? Rollup.uploadedKeyPartHashes(snapshot.data) : new Map<number, string>();
    return Bn254Groth16Verifier.keyParts(key.upload)
        .filter(({ slot, part }) => uploaded.get(slot) !== part.hash().toString('hex'))
        .map(({ slot }) => slot);
}

/** Сверка развёртывания: адрес из ожидаемых кода и параметров, ключ, границы — свои, не контракта. */
async function verify(address: Address, snapshot: AccountSnapshot, inputs: DeployInputs, config: RollupConfig): Promise<string[]> {
    const onchain = await rollupOn(address, snapshot)((rollup) => readOnchainRollup(rollup));
    return [
        ...deploymentMismatches(onchain, { config, code: inputs.code, key: inputs.key }),
        ...deploymentBoundMismatches(onchain.deployment, {
            minEscapeTimeout: inputs.params.escapeTimeout,
            maxEscapeTimeout: inputs.params.escapeTimeout,
            maxBlockAge: inputs.params.maxBlockAge,
        }),
    ];
}

/** Команды check и run для развёрнутого контракта. */
export function serviceCommands(address: Address, params: DeployParams, stateDir: string, defaultStateDir: string): string[] {
    const extra = [
        params.expectedProofTime !== 1800 ? ` --proof-time=${params.expectedProofTime}` : '',
        path.resolve(stateDir) !== path.resolve(defaultStateDir) ? ` --state-dir=${stateDir}` : '',
    ].join('');
    const base = `npx ts-node sequencer/main.ts`;
    return [
        `${base} check ${friendly(address)} --fee-recipient=0x<адрес L2 секвенсора>${extra}`,
        `tmux new -s sequencer '${base} run ${friendly(address)} --fee-recipient=0x<адрес L2 секвенсора>${extra}'`,
    ];
}

/**
 * Развернуть (или продолжить развёртывание) контракта. Порядок: проверки без сети → адрес →
 * сеть (testnet по global_id) → что уже есть по адресу → баланс → [dry-run: конец] → шаги
 * отправщиком под блокировкой каталога → сверка развёртывания.
 */
export async function deploy(inputs: DeployInputs): Promise<DeployResult> {
    const { log, wallet, chain } = inputs;
    const local = deployConfigProblems(inputs.params, inputs.chainSource, inputs.key);
    const keyProblem = (inputs.keyCheck ?? defaultKeyCheck)();
    if (keyProblem) local.push(`key.json не сходится с исходниками программы: ${keyProblem}`);
    if (local.length > 0) throw new DeployRefused(`Развёртывание не начато, ничего не отправлено:\n  - ${local.join('\n  - ')}`);

    const config = deployConfig(inputs);
    const rollup = Rollup.createFromConfig(config, inputs.code);
    log(`контракт: ${friendly(rollup.address)} (chainId ${config.chainId}, escapeTimeout ${config.escapeTimeout} с, maxBlockAge ${config.maxBlockAge} с)`);
    log(`кошелёк сервиса (владелец и секвенсор): ${friendly(wallet.address)} (${wallet.version}); для пополнения: ${wallet.address.toString({ testOnly: true, bounceable: false })}`);

    const globalId = await chain.globalId();
    if (globalId !== TESTNET_GLOBAL_ID) throw new DeployRefused(`сеть с global_id ${globalId} — не testnet (${TESTNET_GLOBAL_ID}): ничего не отправлено`);

    const existing = await existingAt(rollup.address, await chain.account(rollup.address), inputs, config);
    const steps = remainingSteps(rollup, existing, inputs.key);
    if (existing.kind === 'partial') log(`развёртывание начато раньше: осталось ${steps.length} сообщений — продолжаю с первого несделанного шага`);
    if (existing.kind === 'done') log('контракт уже развёрнут, ключ зафиксирован: отправлять нечего');
    // Каталог состояния сервиса — от другой цепочки или прежнего контракта того же chainId:
    // сервис продолжил бы с чужой вершины.
    const stateFile = path.join(inputs.stateDir, 'state.json');
    if (steps.length > 0 && existsSync(stateFile))
        throw new DeployRefused(`в каталоге состояния уже есть ${stateFile} — от прежнего контракта: задайте новый --state-dir. Ничего не отправлено`);

    const cost = stepsCost(steps, inputs.forward);
    const need = cost.values + cost.fees + inputs.reserve;
    const account = await chain.account(wallet.address);
    const balance = account.balance;
    log(
        `нужно: сообщения ${ton(cost.values)} + комиссии кошелька около ${ton(cost.fees)} + остаток сервису ${ton(inputs.reserve)} = ${ton(need)}; ` +
            `на кошельке ${ton(balance)}`,
    );
    if (steps.length > 0 && balance < need)
        throw new DeployRefused(`на кошельке ${ton(balance)}, нужно ${ton(need)}: не хватает ${ton(need - balance)}. Ничего не отправлено`);
    if (inputs.dryRun) {
        log(`режим --dry-run: ничего не отправлено (${steps.length} сообщений к отправке)`);
        return { address: rollup.address, status: 'dry-run', sent: 0 };
    }

    // Отправки и сверка — под блокировкой каталога: при работающем сервисе (`run`) — отказ
    // StateDirBusy; снимки — монотонные, у того же отправщика (отстающий сервер не даст ложного
    // «ключ не зафиксирован» после FinalizeKey).
    let sent = 0;
    const lock = lockStateDir(inputs.stateDir);
    try {
        const submitter = new TestnetSubmitter({
            chain,
            rollup: rollup.address,
            wallet,
            stateDir: inputs.stateDir,
            log,
            assertHeld: () => lock.assertHeld(),
            ...inputs.submitter,
        });
        for (const step of steps) {
            // До фиксации часть ключа можно перезаписать, после — ключ неизменяем: все части
            // сверяются по свежему снимку прямо перед FinalizeKey.
            if (step.effect.kind === 'keyHash') {
                const wrong = await wrongKeyParts(submitter, inputs.key);
                if (wrong.length > 0)
                    throw new DeployRefused(`перед фиксацией ключа части ${wrong.join(', ')} в контракте не те, что в key.json: FinalizeKey не отправлен`);
            }
            const failed = await submitter.send(step.what, step.message, step.effect);
            if (failed) throw new DeployRefused(`${step.what}: ${failed}. Запуск deploy с теми же параметрами продолжит с этого шага`);
            sent++;
        }
        const problems = await verify(rollup.address, await submitter.snapshot(), inputs, config);
        if (problems.length > 0) throw new DeployRefused(`развёртывание НЕ сошлось с ожидаемым:\n  - ${problems.join('\n  - ')}`);
    } finally {
        lock();
    }
    log('развёртывание сверено: адрес выводится из кода и параметров, ключ — из key.json, срок и возраст блока — заданные');
    return { address: rollup.address, status: existing.kind === 'done' ? 'already' : 'deployed', sent };
}
