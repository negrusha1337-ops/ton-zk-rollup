import { randomInt } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { writeAtomically } from './state';

// chainId нового развёртывания (круг 23, пункт 2). Привязка пруфа к rollup'у — только chainId
// (первое слово публичных значений и часть подписи каждой транзакции L2); к адресу контракта
// привязки нет. Поэтому каждому развёртыванию — свой chainId: с chainId цепочки сценария Reth
// (362107787851) пруфы и подписанные транзакции прежних прогонов подошли бы новому контракту.
//
// От chainId не зависят: хеш генезиса (GENESIS_HASH; в заголовке генезиса chainId нет — он только
// в config узла, sequencer/protocol.ts) и программа (берёт chainId из входа, коммитит словом 0;
// правила цепочки от него не зависят, кроме сетей Linea — их chain_spec отвергает). Контракт
// хранит свой chainId в данных развёртывания.
//
// Выбор записывается в каталог состояния сервиса (`deploy-chain.json`) до первой отправки и в
// --dry-run: повтор deploy (и после --dry-run) берёт тот же chainId, иначе адрес контракта был бы
// другим. Записанный chainId и другой --chain-id — отказ.

const ROOT = path.join(__dirname, '..');
/** chainId цепочки сценария Reth (fixtures/evm_batches/reth): его пруфы и подписи публичны. */
export const RETH_SCENARIO_CHAIN_ID = 362107787851n;
/** Генезис узла reth пишет chainId JSON-числом (genesisJson): больше 2^53 − 1 не представить точно. */
export const MAX_CHAIN_ID = 2n ** 53n - 1n;
/** Linea, Linea Goerli, Linea Sepolia: для них RSP ослабляет правила заголовка, программа их отвергает. */
export const PROGRAM_REFUSED_CHAIN_IDS = [59144n, 59140n, 59141n];
/** Случайный chainId — 40 бит со старшим единичным: [2^39, 2^40). */
const RANDOM_LOW = 2 ** 39;
const RANDOM_HIGH = 2 ** 40;
export const CHAIN_ID_FILE = 'deploy-chain.json';

/** chainId, уже бывшие в прогонах: сценарий Reth и всё, что записано в bench/testnet-run-*.json. */
export function usedChainIds(benchDir = path.join(ROOT, 'bench')): Set<bigint> {
    const used = new Set<bigint>([RETH_SCENARIO_CHAIN_ID]);
    const visit = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value !== null && typeof value === 'object')
            for (const [key, inner] of Object.entries(value)) {
                if (/^chain_?id$/i.test(key) && (typeof inner === 'string' || typeof inner === 'number') && /^\d+$/.test(String(inner))) used.add(BigInt(inner));
                else visit(inner);
            }
    };
    for (const name of readdirSync(benchDir).filter((file) => /^testnet-run-.*\.json$/.test(file)))
        visit(JSON.parse(readFileSync(path.join(benchDir, name), 'utf8')));
    return used;
}

/** Чем chainId не годится для нового развёртывания. Пусто — годится. */
export function chainIdProblems(chainId: bigint, used: Set<bigint>): string[] {
    const problems: string[] = [];
    if (chainId < 1n || chainId > MAX_CHAIN_ID) problems.push(`chainId ${chainId} — не число от 1 до 2^53 − 1 (генезис узла пишет его JSON-числом)`);
    if (PROGRAM_REFUSED_CHAIN_IDS.includes(chainId)) problems.push(`chainId ${chainId} — сеть Linea: программа батча такие отвергает (chain_spec)`);
    if (used.has(chainId)) problems.push(`chainId ${chainId} уже был в прогонах (сценарий Reth или bench/testnet-run-*.json): пруфы и подписи оттуда подошли бы новому контракту`);
    return problems;
}

/** Случайный 40-битный chainId, которого не было в прогонах. */
export function randomChainId(used: Set<bigint>, random: (low: number, high: number) => number = randomInt): bigint {
    for (let attempt = 0; attempt < 100; attempt++) {
        const candidate = BigInt(random(RANDOM_LOW, RANDOM_HIGH));
        if (chainIdProblems(candidate, used).length === 0) return candidate;
    }
    throw new Error('не удалось выбрать случайный chainId за 100 попыток');
}

type Recorded = { chainId: string; source: 'flag' | 'random'; chosenAt: string };

/**
 * chainId развёртывания: записанный в каталоге состояния, иначе `--chain-id`, иначе случайный.
 * Новый выбор сверяется (chainIdProblems) и записывается сразу. Записанный и другой `--chain-id`
 * — отказ (адрес контракта зависит от chainId: продолжить начатое развёртывание иначе нельзя).
 */
export function resolveDeployChainId(options: {
    stateDir: string;
    flag: string | undefined;
    used: Set<bigint>;
    log: (line: string) => void;
    random?: (low: number, high: number) => number;
    now?: () => Date;
}): bigint {
    const file = path.join(options.stateDir, CHAIN_ID_FILE);
    if (options.flag !== undefined && !/^\d+$/.test(options.flag)) throw new Error(`--chain-id — целое число, получено «${options.flag}»`);
    const flag = options.flag === undefined ? null : BigInt(options.flag);
    if (existsSync(file)) {
        const recorded = JSON.parse(readFileSync(file, 'utf8')) as Recorded;
        if (typeof recorded.chainId !== 'string' || !/^\d+$/.test(recorded.chainId)) throw new Error(`${file}: chainId не число — файл испорчен`);
        const chainId = BigInt(recorded.chainId);
        if (flag !== null && flag !== chainId)
            throw new Error(`в ${file} записан chainId ${chainId}, а --chain-id=${flag}: развёртывание этого каталога начато с другим chainId (новый — с новым --state-dir)`);
        options.log(`chainId ${chainId} — записан в ${file} при первом запуске deploy`);
        return chainId;
    }
    const chainId = flag ?? randomChainId(options.used, options.random);
    const problems = chainIdProblems(chainId, options.used);
    if (problems.length > 0) throw new Error(`chainId не годится: ${problems.join('; ')}`);
    mkdirSync(options.stateDir, { recursive: true });
    const record: Recorded = { chainId: chainId.toString(), source: flag === null ? 'random' : 'flag', chosenAt: (options.now ?? (() => new Date()))().toISOString() };
    writeAtomically(file, JSON.stringify(record, null, 1) + '\n');
    options.log(`chainId ${chainId} (${flag === null ? 'случайный' : 'задан --chain-id'}) записан в ${file}: повтор deploy возьмёт его же`);
    return chainId;
}
