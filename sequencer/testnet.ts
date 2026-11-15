import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statfsSync } from 'fs';
import path from 'path';
import { Address, fromNano, toNano } from '@ton/core';
import { loadEvmRollupKey } from '../wrappers/evmProofs';
import { PROTOCOL_VERSION } from '../wrappers/protocolVersion';
import { PUBLISH_DATA_VALUE, SUBMIT_BATCH_VALUE } from '../wrappers/rollupValues';
import { childEnv, installSignalHandlers, ShuttingDown } from './children';
import { DEFAULT_EXPECTED_CHECK_TIME, startBudgetProblem } from './deadline';
import { startNode } from './node';
import { DEFAULT_CIRCUITS_DIR, ProofRejected } from './proofImport';
import { hostIdentity, identityMismatches, loadProgramKeys, ProgramTools } from './program';
import { GENESIS_HASH } from './protocol';
import { DEFAULT_PROVE_SCRIPT, DEFAULT_PROVER_ENV, LocalProver, ProverCancelled, ProverFailure, readEnvFile } from './prover';
import { rateLimiter, TestnetQueueSource } from './queue/toncenter';
import { QueueLagError } from './queue/types';
import { DEFAULT_EXPECTED_PROOF_TIME, DEFAULT_PROGRAM_KEYS, DEFAULT_SUBMIT_MARGIN, Sequencer, SequencerConfig, SequencerStop } from './service';
import { DEFAULT_STATE_DIR, lockStateDir, StateDirBusy } from './state';
import { TestnetSubmitter } from './submitter';
import { rollupOn, SequencerWallet, TESTNET_GLOBAL_ID, TonChain, ToncenterChain } from './ton';

// Сервис-секвенсор против контракта в testnet (команды `check` и `run` в main.ts).
//   check — проверить всё и ничего не отправить: сеть (testnet по global_id), контракт (секвенсор —
//           наш кошелёк, ключ контракта = key.json, генезис, версия протокола, не заморожен),
//           кошелёк (баланс), часы против L1, бюджет времени; локально — ключ программы против
//           исходников (gen-evm-rollup-key --check), хост против program.json, прувер, узел;
//   run   — те же проверки, затем узел reth, очередь toncenter, LocalProver, TestnetSubmitter и
//           шаги сервиса в цикле (`serve`). Остановка, где нужен человек (SequencerStop, отказ и
//           сбой прувера, негодный пруф, чужая блокировка каталога) — код 2 и строка «ОСТАНОВКА»,
//           и при старте, и в цикле; повторяется только сбой сети и индексатора.

const ROOT = path.join(__dirname, '..');
/** Меньше этого на кошельке секвенсора — отказ: не хватит и на один батч с комиссиями. */
export const MIN_WALLET_BALANCE = toNano('0.2');
/** Рекомендуемый запас кошелька: около десяти батчей. */
export const RECOMMENDED_WALLET_BALANCE = toNano('1');
/** Оценка расхода на батч: SubmitBatch, порции данных (обычно до 8) и комиссии кошелька. */
export const BATCH_COST_ESTIMATE = SUBMIT_BATCH_VALUE + 8n * PUBLISH_DATA_VALUE + toNano('0.01');

export type CheckReport = { lines: string[]; problems: string[] };

/** Сетевая часть проверки: только чтение (снимки счетов и get-методы на них). */
export async function checkTestnet(options: {
    chain: TonChain;
    rollup: Address;
    wallet: SequencerWallet;
    now: () => number;
    maxBlockAge?: number;
    expectedProofTime?: number;
    clockSkewLimit?: number;
}): Promise<CheckReport> {
    const lines: string[] = [];
    const problems: string[] = [];
    const globalId = await options.chain.globalId();
    if (globalId !== TESTNET_GLOBAL_ID) problems.push(`сеть с global_id ${globalId} — не testnet (${TESTNET_GLOBAL_ID})`);
    const snapshot = await options.chain.account(options.rollup);
    const on = rollupOn(options.rollup, snapshot);
    const [deployment, keyHash, genesis, protocol, escape, state] = await on(async (rollup) => [
        await rollup.getDeployment(),
        await rollup.getKeyHash(),
        await rollup.getGenesisHash(),
        await rollup.getProtocolVersion(),
        await rollup.getEscapeState(),
        await rollup.getRollupState(),
    ] as const);
    const key = loadEvmRollupKey();
    lines.push(`контракт ${options.rollup.toString({ testOnly: true })}: принято батчей ${state.batchIndex}, maxBlockAge ${deployment.maxBlockAge} с, chainId ${deployment.chainId}`);
    if (!deployment.sequencer.equals(options.wallet.address))
        problems.push(`секвенсор контракта ${deployment.sequencer.toString({ testOnly: true })}, а кошелёк — ${options.wallet.address.toString({ testOnly: true })}`);
    if (keyHash !== key.keyHash) problems.push(`ключ контракта 0x${keyHash.toString(16)}, а fixtures/evm_batches/key.json — 0x${key.keyHash.toString(16)}`);
    if (genesis !== BigInt(GENESIS_HASH)) problems.push(`генезис контракта 0x${genesis.toString(16)}, а константа протокола ${GENESIS_HASH}`);
    if (protocol !== PROTOCOL_VERSION) problems.push(`версия протокола контракта ${protocol}, а сервиса ${PROTOCOL_VERSION}`);
    if (escape.frozen) problems.push('rollup заморожен: батчи не принимаются');
    if (options.maxBlockAge !== undefined && options.maxBlockAge !== deployment.maxBlockAge)
        problems.push(`maxBlockAge в конфигурации ${options.maxBlockAge} с, у контракта ${deployment.maxBlockAge} с`);
    const budget = startBudgetProblem({
        proofTime: options.expectedProofTime ?? DEFAULT_EXPECTED_PROOF_TIME,
        checkTime: DEFAULT_EXPECTED_CHECK_TIME,
        submitMargin: DEFAULT_SUBMIT_MARGIN,
        maxBlockAge: deployment.maxBlockAge,
    });
    if (budget) problems.push(budget);
    const skew = options.now() - snapshot.utime;
    lines.push(`время L1 ${snapshot.utime}, часы машины ${options.now()} (расхождение ${skew} с)`);
    if (Math.abs(skew) > (options.clockSkewLimit ?? 60)) problems.push(`часы машины расходятся со временем L1 на ${skew} с`);
    const wallet = await options.wallet.state(await options.chain.account(options.wallet.address));
    lines.push(
        `кошелёк секвенсора ${options.wallet.address.toString({ testOnly: true })} (${options.wallet.version}): ${fromNano(wallet.balance)} TON, ` +
            `seqno ${wallet.seqno}${wallet.deployed ? '' : ', не развёрнут (развернётся первым сообщением)'}; батч стоит около ${fromNano(BATCH_COST_ESTIMATE)} TON`,
    );
    // Круг 21, 5а: у v4 нет привязки подписи к сети (у v5r1 — global_id), а мнемоника в окружении
    // сервиса — повод держать для секвенсора отдельный кошелёк.
    if (options.wallet.version === 'v4')
        lines.push('ВНИМАНИЕ: кошелёк секвенсора v4 — рекомендуется WALLET_VERSION=v5r1 и отдельная мнемоника только для секвенсора');
    if (wallet.balance < MIN_WALLET_BALANCE) problems.push(`на кошельке ${fromNano(wallet.balance)} TON, нужно не меньше ${fromNano(MIN_WALLET_BALANCE)} TON`);
    else if (wallet.balance < RECOMMENDED_WALLET_BALANCE) lines.push(`ВНИМАНИЕ: на кошельке меньше рекомендуемых ${fromNano(RECOMMENDED_WALLET_BALANCE)} TON`);
    return { lines, problems };
}

export type TestnetOptions = {
    rollup: Address;
    feeRecipient: string;
    stateDir: string;
    apiKey?: string;
    reth: string;
    tools: ProgramTools;
    ports: { http: number; auth: number; p2p: number };
    expectedProofTime: number;
    includePool: boolean;
    pollSeconds: number;
};

export const defaultTools = (): ProgramTools => ({
    host: path.join(ROOT, 'zkvm-evm', 'target', 'release', 'rollup-evm-host'),
    rsp: path.join(ROOT, '.tools', 'rsp', 'target', 'release', 'rsp'),
    executeInZkvm: false,
});
export const DEFAULT_RETH = path.join(ROOT, '.tools', 'reth', 'bin', 'reth');
export { DEFAULT_STATE_DIR };

/** Локальная часть проверки: ключ, хост, прувер, диск. Узел — в checkNode. */
export async function checkLocal(options: TestnetOptions): Promise<CheckReport> {
    const lines: string[] = [];
    const problems: string[] = [];
    try {
        execFileSync(process.execPath, [path.join(ROOT, 'zk', 'gen-evm-rollup-key.mjs'), '--check'], { cwd: ROOT, stdio: 'pipe', env: childEnv() });
        lines.push('key.json сходится с исходниками программы и закреплённым верификатором (gen-evm-rollup-key --check)');
    } catch (error) {
        problems.push(`key.json не сходится с исходниками: ${String((error as { stderr?: Buffer }).stderr ?? error).trim().split('\n').pop()}`);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(options.feeRecipient)) problems.push(`адрес получателя чаевых «${options.feeRecipient}» — не адрес L2 (0x и 40 hex)`);
    for (const [what, file] of [['reth', options.reth], ['rsp', options.tools.rsp], ['хост', options.tools.host], ['сторож прувера', DEFAULT_PROVE_SCRIPT]])
        if (!existsSync(file)) problems.push(`нет ${what}: ${file} (PROVING.md)`);
    if (existsSync(options.tools.host)) {
        const mismatches = identityMismatches(await hostIdentity(options.tools), loadProgramKeys(DEFAULT_PROGRAM_KEYS));
        if (mismatches.length > 0) problems.push(`хост не тот, под который выведен ключ: ${mismatches.join('; ')}`);
        else lines.push('хост собран из тех исходников и ELF, что в program.json');
    }
    readEnvFile(DEFAULT_PROVER_ENV);
    for (const file of ['Groth16Verifier.sol', 'SP1VerifierGroth16.sol'])
        if (!existsSync(path.join(DEFAULT_CIRCUITS_DIR, file))) problems.push(`нет ${path.join(DEFAULT_CIRCUITS_DIR, file)}`);
    const free = statfsSync(ROOT);
    const freeGb = Math.floor((free.bavail * free.bsize) / 2 ** 30);
    lines.push(`свободно на диске ${freeGb} ГБ (пруфу нужно 20+, сторож не стартует меньше чем при 16)`);
    if (freeGb < 20) problems.push(`свободно ${freeGb} ГБ, для пруфа нужно 20+`);
    return { lines, problems };
}

const nodeOptions = (options: TestnetOptions, chainId: bigint) => ({
    reth: options.reth,
    dir: path.join(options.stateDir, 'node'),
    chainId,
    httpPort: options.ports.http,
    authPort: options.ports.auth,
    p2pPort: options.ports.p2p,
});

async function connect(options: TestnetOptions) {
    const limit = rateLimiter(options.apiKey ? 9 : 1);
    const chain = new ToncenterChain({ apiKey: options.apiKey, limit });
    const wallet = await SequencerWallet.fromProcessEnv();
    return { chain, wallet, limit };
}

/** `check`: всё проверить, ничего не отправить. Узел поднимается и гасится (под блокировкой каталога). */
export async function check(options: TestnetOptions, print: (line: string) => void): Promise<boolean> {
    const { chain, wallet } = await connect(options);
    const network = await checkTestnet({ chain, rollup: options.rollup, wallet, now: () => Math.floor(Date.now() / 1000), expectedProofTime: options.expectedProofTime });
    const local = await checkLocal(options);
    const lines = [...network.lines, ...local.lines];
    const problems = [...network.problems, ...local.problems];
    if (problems.length === 0) {
        const release = lockStateDir(options.stateDir);
        const node = await startNode(nodeOptions(options, (await new TestnetSubmitter({ chain, rollup: options.rollup, wallet, stateDir: options.stateDir }).deployment()).chainId));
        try {
            lines.push(`узел reth поднят на 127.0.0.1:${options.ports.http}, генезис протокола сверен`);
        } finally {
            await node.stop();
            release();
        }
        const state = path.join(options.stateDir, 'state.json');
        if (existsSync(state)) lines.push(`состояние сервиса: ${state} (${readFileSync(state, 'utf8').length} байт) — run продолжит с него`);
    }
    lines.forEach((line) => print(line));
    problems.forEach((problem) => print(`ПРОБЛЕМА: ${problem}`));
    print(problems.length === 0 ? 'Проверки пройдены. Режим check: ничего не отправлено.' : 'Проверки НЕ пройдены. Ничего не отправлено.');
    return problems.length === 0;
}

/** `run`: проверки, затем узел и шаги сервиса в цикле. Возвращает код выхода. */
export async function run(options: TestnetOptions, print: (line: string) => void): Promise<number> {
    installSignalHandlers();
    const { chain, wallet, limit } = await connect(options);
    const network = await checkTestnet({ chain, rollup: options.rollup, wallet, now: () => Math.floor(Date.now() / 1000), expectedProofTime: options.expectedProofTime });
    const local = await checkLocal(options);
    const problems = [...network.problems, ...local.problems];
    if (problems.length > 0) {
        problems.forEach((problem) => print(`ПРОБЛЕМА: ${problem}`));
        print('Сервис не запущен: сначала check.');
        return 1;
    }
    let service: Sequencer | null = null;
    const submitter = new TestnetSubmitter({
        chain,
        rollup: options.rollup,
        wallet,
        stateDir: options.stateDir,
        log: print,
        // Перед каждой отправкой — своя ли ещё блокировка каталога (круг 21, 5в).
        assertHeld: () => {
            if (!service) throw new StateDirBusy('сервис ещё не создан: отправлять нечем');
            service.assertLockHeld();
        },
    });
    const deployment = await submitter.deployment();
    const queueProbe = new TestnetQueueSource(options.rollup, { maxForcedTxCells: 0, maxForcedTxBytes: 0 }, { apiKey: options.apiKey, limit });
    const limits = await queueProbe.contract.getQueueLimits();
    const node = await startNode(nodeOptions(options, deployment.chainId));
    const config: SequencerConfig = {
        chainId: deployment.chainId,
        feeRecipient: options.feeRecipient,
        stateDir: options.stateDir,
        rpcUrl: node.rpcUrl,
        genesisPath: node.genesisPath,
        includePool: options.includePool,
        tools: options.tools,
        maxBatchQueueItems: limits.maxBatchQueueItems,
        maxBlockAge: deployment.maxBlockAge,
        expectedProofTime: options.expectedProofTime,
    };
    service = new Sequencer(config, {
        node: node.rpc,
        queue: new TestnetQueueSource(options.rollup, limits, { apiKey: options.apiKey, limit }),
        prover: new LocalProver({ dir: path.join(options.stateDir, 'proofs'), log: print }),
        submitter,
        l1Now: () => submitter.l1Now(),
        log: print,
    });
    try {
        return await serve(service, { pollSeconds: options.pollSeconds }, print);
    } finally {
        await node.stop();
    }
}

/**
 * Где нужен человек: повтор не поможет (круг 21, пункты 2 и 5в). Негодный пруф (ProofRejected)
 * повтор построил бы заново тем же входом — 15 минут и своп ради того же отказа; чужая
 * блокировка каталога значит второй экземпляр сервиса.
 */
const needsHuman = (error: unknown): error is Error =>
    error instanceof SequencerStop ||
    error instanceof ProverFailure ||
    error instanceof ProverCancelled ||
    error instanceof ProofRejected ||
    error instanceof StateDirBusy;

/**
 * Цикл сервиса: старт и шаги. Возвращает код выхода: 2 — остановка, где нужен человек (строка
 * «ОСТАНОВКА: …»), 1 — остановка по сигналу. Сбой сети и индексатора повторяется; подряд
 * `maxFailures` (10) — тоже остановка. Сервис закрывается в любом случае.
 */
export async function serve(
    service: Pick<Sequencer, 'start' | 'step' | 'close'>,
    options: { pollSeconds: number; maxFailures?: number },
    print: (line: string) => void,
): Promise<number> {
    const pause = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const stop = (error: Error) => (print(`ОСТАНОВКА: ${error.message}`), 2);
    const maxFailures = options.maxFailures ?? 10;
    try {
        try {
            await service.start();
        } catch (error) {
            if (needsHuman(error)) return stop(error);
            if (error instanceof ShuttingDown) return 1;
            throw error;
        }
        let failures = 0;
        for (;;) {
            try {
                const result = await service.step();
                failures = 0;
                if (result.kind === 'waiting' || result.kind === 'idle') await pause(options.pollSeconds);
            } catch (error) {
                if (needsHuman(error)) return stop(error);
                if (error instanceof ShuttingDown) return 1;
                // Сеть, индексатор, сбой отправки: шаг повторяется; подряд много — остановка.
                failures++;
                print(`шаг не удался (${failures} подряд): ${(error as Error).message}${error instanceof QueueLagError ? ' — индексатор отстаёт' : ''}`);
                if (failures >= maxFailures) {
                    print(`ОСТАНОВКА: ${maxFailures} сбоев подряд — нужен человек`);
                    return 2;
                }
                await pause(options.pollSeconds);
            }
        }
    } finally {
        service.close();
    }
}
