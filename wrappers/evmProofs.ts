import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { Cell } from '@ton/core';
import { Bn254Proof } from './Bn254Groth16Verifier';
import { PROTOCOL_VERSION } from './protocolVersion';
import { BatchRoots } from './Rollup';
import { ExpectedRollupKey, RollupKeyFile, rollupKeyFromFile } from './rollupDeployment';
import { BatchPublicValues, dataChunkCell } from './rollupMath';
import { HintedFixture } from './zkvmProofs';

// Программа батча EVM протокола v2 (zkvm-evm/): её ключ, отчёты о блоках цепочки узла Reth и
// пруфы SP1 этих блоков с привязкой к исходникам:
//   исходники → sourcesSha256 → fixtures/evm_batches/program.json → fixtures/evm_batches/key.json
//   → fixtures/sp1_evm_reth<N> (импорт пруфа: zk/import-sp1-fixture.mjs).
// Батч k контракта — блок k цепочки (fixtures/evm_batches/reth/block-<k>.json).
//
// Загрузчиков протокола v1 (блок anvil fixtures/evm_batches/contract, пруф fixtures/sp1_evm_batch2)
// здесь больше нет: тот пруф построен прежней программой под восемь слов и контракту v2 не
// подходит. Прежняя версия целиком — тег protocol-v1.

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const read = (...parts: string[]) => JSON.parse(readFileSync(path.join(FIXTURES, ...parts), 'utf8'));

export type EvmProgramKeys = { sourcesSha256: string; programVKey: string; programElfSha256: string };

/** Одиннадцать слов публичных значений батча, как их пишет хост (строки: hex либо десятичные). */
export type EvmPublicValues = {
    chainId: string;
    prevStateRoot: string;
    newStateRoot: string;
    batchHash: string;
    prevWithdrawalsRoot: string;
    withdrawalsRoot: string;
    prevDepositHash: string;
    newDepositHash: string;
    prevWithdrawalsCount: string;
    withdrawalsCount: string;
    blockTimestamp: string;
};

/** Отчёт хоста о блоке, исполненном программой: публичные значения и то, что публикуется в TON. */
export type EvmBatchReport = {
    blockNumber: number;
    transactions: number;
    /** Порции данных батча (RLP блока), которые публикуются в TON до отправки батча. */
    dataChunksHex: string[];
    dataBytes: number;
    publicValues: EvmPublicValues;
    /** 352 байта публичных значений программы (hex). */
    publicValuesBytes: string;
    /** Отрезок очереди L1, обработанный блоком: элементы (queueProcessedFrom, queueProcessedUpTo]. */
    queueItems: number;
    queueProcessedFrom: number;
    queueProcessedUpTo: number;
    /** Исход каждой принудительной транзакции отрезка; queueIndex — место в отрезке, с нуля. */
    forced: { queueIndex: number; outcome: 'included' | 'skipped'; reason?: string }[];
    /** Листья дерева выводов, дозаписанные блоком. */
    withdrawals: { leafIndex: number; recipientHash: string; amount: string }[];
    /** Фронтир дерева выводов после блока (32 хеша). */
    withdrawalsFrontierAfter: string[];
    programElfSha256: string;
    zkvmCycles: number | null;
};

export const loadEvmProgramKeys = (): EvmProgramKeys => read('evm_batches', 'program.json');

/** Ключ контракта для программы EVM (zk/gen-evm-rollup-key.mjs). Ключа программы выхода в протоколе v2 нет. */
export const loadEvmRollupKey = (): ExpectedRollupKey => rollupKeyFromFile(read('evm_batches', 'key.json') as RollupKeyFile);

/** Публичные значения отчёта числами — в виде, который понимает batchDigest. */
export const publicValuesOf = (report: EvmBatchReport): BatchPublicValues => ({
    chainId: BigInt(report.publicValues.chainId),
    prevStateRoot: BigInt(report.publicValues.prevStateRoot),
    newStateRoot: BigInt(report.publicValues.newStateRoot),
    batchHash: BigInt(report.publicValues.batchHash),
    prevWithdrawalsRoot: BigInt(report.publicValues.prevWithdrawalsRoot),
    withdrawalsRoot: BigInt(report.publicValues.withdrawalsRoot),
    prevDepositHash: BigInt(report.publicValues.prevDepositHash),
    newDepositHash: BigInt(report.publicValues.newDepositHash),
    prevWithdrawalsCount: BigInt(report.publicValues.prevWithdrawalsCount),
    withdrawalsCount: BigInt(report.publicValues.withdrawalsCount),
    blockTimestamp: BigInt(report.publicValues.blockTimestamp),
});

/** То, что батч с этим блоком заявляет контракту (BatchRoots): четыре слова и отметка очереди. */
export const batchRootsOf = (report: EvmBatchReport): BatchRoots => ({
    newStateRoot: BigInt(report.publicValues.newStateRoot),
    withdrawalsRoot: BigInt(report.publicValues.withdrawalsRoot),
    withdrawalsCount: BigInt(report.publicValues.withdrawalsCount),
    queueProcessedUpTo: BigInt(report.queueProcessedUpTo),
    blockTimestamp: BigInt(report.publicValues.blockTimestamp),
});

/** Порции данных батча ячейками — как их считает программа (dataChunkCell). */
export const dataChunksOf = (report: EvmBatchReport): Cell[] =>
    report.dataChunksHex.map((hex) => dataChunkCell(Buffer.from(hex, 'hex')));

/** Хеш исходников программы EVM по дереву на диске (zk/evm-binding.mjs). */
export const currentEvmSourcesSha256 = (): string =>
    execFileSync('node', [path.join(ROOT, 'zk', 'evm-binding.mjs')], { encoding: 'utf8' }).trim();

/** Публичный вход схемы для байтов публичных значений (352 байта): sha256, обрезанный до 253 бит. */
export const publicInputOf = (publicValuesHex: string): bigint =>
    BigInt('0x' + createHash('sha256').update(Buffer.from(publicValuesHex.replace(/^0x/, ''), 'hex')).digest('hex')) &
    ((1n << 253n) - 1n);

export type ProvenEvmBatch = {
    proof: Bn254Proof;
    hinted: HintedFixture;
    publicInputs: bigint[];
    report: EvmBatchReport;
    roots: BatchRoots;
    /** Порции данных (RLP блока), которые публикуются в TON до отправки батча. */
    dataChunks: Cell[];
};

function provenBatch(directory: string, report: EvmBatchReport): ProvenEvmBatch {
    const raw = read(directory, 'proof.json');
    return {
        proof: {
            a: [BigInt(raw.pi_a[0]), BigInt(raw.pi_a[1])],
            b: [
                [BigInt(raw.pi_b[0][0]), BigInt(raw.pi_b[0][1])],
                [BigInt(raw.pi_b[1][0]), BigInt(raw.pi_b[1][1])],
            ],
            c: [BigInt(raw.pi_c[0]), BigInt(raw.pi_c[1])],
        },
        hinted: (read(directory, 'onchain.json') as { hinted: HintedFixture }).hinted,
        publicInputs: (read(directory, 'public.json') as string[]).map(BigInt),
        report,
        roots: batchRootsOf(report),
        dataChunks: dataChunksOf(report),
    };
}

// --- блоки узла Reth (zkvm-evm/scenario/reth-scenario.mjs) ---

/**
 * Блоки цепочки Reth, под которые строятся пруфы SP1 для настоящего контракта: батч k — блок k.
 * Первые три покрывают депозит, частичную обработку очереди, включённый принудительный вывод,
 * пропуски и выводы через мост. Пруфов v2 пока нет: строятся только по команде пользователя.
 */
export const RETH_PROVEN_BLOCKS = [1, 2, 3];
/** Сколько блоков в цепочке сценария (fixtures/evm_batches/reth/block-<N>.json). */
export const RETH_CHAIN_BLOCKS = 15;
const rethProofDirectory = (block: number) => `sp1_evm_reth${block}`;
export const loadRethBatchReport = (block: number): EvmBatchReport => read('evm_batches', 'reth', `block-${block}.json`);

/** Элемент очереди L1 цепочки: депозит либо принудительная транзакция; `batch` — каким батчем обработан. */
export type RethQueueItem =
    | { number: number; batch: number; kind: 'deposit'; l2Recipient: string; amount: string }
    | { number: number; batch: number; kind: 'forced'; label: string; bytes: string; outcome: string };

export type RethExit = { account: string; balanceWei: string; nonce: number; accountProof: string[]; signature: string };

/** Описание цепочки сценария (fixtures/evm_batches/reth/expected.json). */
export type RethExpected = {
    protocolVersion: number;
    /** Профиль сценария (zkvm-evm/scenario/profile.mjs); у цепочек, собранных до профилей, поля нет. */
    profile?: string;
    chainId: string;
    /** Хеш заголовка генезиса цепочки: с ним обязана совпасть константа GENESIS_HASH контракта. */
    genesisHash: string;
    programElfSha256: string;
    /** Когда сценарий запущен и время первого и последнего блока (unix); блоки идут через секунду. */
    generatedAt: number;
    firstBlockTimestamp: number;
    lastBlockTimestamp: number;
    /** Вызовы моста с негодными подписями: номер элемента очереди, вид и ожидаемый исход. */
    badSignatures: { block: number; queueNumber: number; kind: string; bytes: string; expected: string; recoversTo: string | null }[];
    blocks: {
        number: number;
        note: string;
        hash: string;
        parentHash: string;
        timestamp: number;
        queueProcessedFrom: number;
        queueProcessedUpTo: number;
        /** Сколько элементов стояло в очереди L1, когда батч с этим блоком принят. */
        headAtBatch: number;
        withdrawalsRoot: string;
        withdrawalsCount: number;
    }[];
    queue: RethQueueItem[];
    withdrawals: { leafIndex: number; recipientHash: string; amount: string; block: number }[];
    /** Получатель выплат в basechain (хеш адреса): на него подписаны согласия на выход. */
    exitRecipientHash: string;
    /** Аварийные выходы счетов против состояния после блока: только счета с балансом (у прежних цепочек записи для блока 1 нет). */
    exitsByBlock: { block: number; blockHash: string; consentHash: string; exits: RethExit[] }[];
};
export const loadRethExpected = (): RethExpected => read('evm_batches', 'reth', 'expected.json');

/**
 * Звенья цепочки привязки ДО пруфов: исходники → program.json → key.json и цепочка блоков
 * (expected.json). Список расхождений; пустой — звенья сходятся. Чистая функция: тест подаёт
 * ей подменённые копии объектов, не трогая фикстуры.
 *   • program.json описывает нынешние исходники программы;
 *   • key.json — ключ нынешнего протокола, выведен из тех же исходников, того же ключа
 *     программы и того же ELF, что записаны в program.json;
 *   • блоки цепочки исполнены тем же ELF (иначе пруфы и отчёты — от разных программ).
 */
export function rethBindingProblems(links: {
    program: EvmProgramKeys;
    key: Pick<RollupKeyFile, 'protocolVersion' | 'sourcesSha256' | 'programVKey' | 'programElfSha256'>;
    expected: Pick<RethExpected, 'programElfSha256' | 'protocolVersion'>;
    sourcesSha256: string;
}): string[] {
    const { program, key, expected, sourcesSha256 } = links;
    const plain = (hex: string) => hex.replace(/^0x/, '');
    const problems: string[] = [];
    if (program.sourcesSha256 !== sourcesSha256) problems.push('fixtures/evm_batches/program.json описывает прежние исходники программы');
    if (key.protocolVersion !== PROTOCOL_VERSION) {
        problems.push(`key.json выведен для протокола v${key.protocolVersion}, а нынешний — v${PROTOCOL_VERSION}`);
    }
    if (key.sourcesSha256 !== program.sourcesSha256) problems.push('key.json выведен не из тех исходников программы, что записаны в program.json');
    if (key.programVKey !== program.programVKey) problems.push('key.json выведен не из того ключа программы, что в program.json');
    if (plain(key.programElfSha256) !== plain(program.programElfSha256)) problems.push('key.json выведен для другого ELF, чем записан в program.json');
    if (expected.protocolVersion !== PROTOCOL_VERSION) {
        problems.push(`цепочка Reth (expected.json) — протокола v${expected.protocolVersion}, а нынешний — v${PROTOCOL_VERSION}`);
    }
    if (plain(expected.programElfSha256) !== plain(program.programElfSha256)) {
        problems.push('цепочка Reth (expected.json) исполнена другим ELF, чем записан в program.json');
    }
    return problems;
}

/**
 * Годны ли пруфы SP1 блоков Reth для сквозного теста и почему нет. Каждый запуск сценария даёт
 * новую цепочку: пруфы прежней цепочки не сойдутся по публичному входу.
 */
export function rethProofStatus(): { current: boolean; reason: string } {
    for (const required of [['evm_batches', 'program.json'], ['evm_batches', 'key.json'], ['evm_batches', 'reth', 'expected.json']]) {
        if (!existsSync(path.join(FIXTURES, ...required))) return { current: false, reason: `нет fixtures/${required.join('/')}` };
    }
    const program = loadEvmProgramKeys();
    const key = read('evm_batches', 'key.json');
    const binding = rethBindingProblems({
        program,
        key,
        expected: loadRethExpected(),
        sourcesSha256: currentEvmSourcesSha256(),
    });
    if (binding.length > 0) return { current: false, reason: binding.join('; ') };
    const problems: string[] = [];
    for (const block of RETH_PROVEN_BLOCKS) {
        const directory = rethProofDirectory(block);
        if (!['proof.json', 'public.json', 'source.json', 'onchain.json'].every((name) => existsSync(path.join(FIXTURES, directory, name)))) {
            return { current: false, reason: `${directory}: пруфа нет` };
        }
        const problem = (text: string) => problems.push(`${directory}: ${text}`);
        const inputs = (read(directory, 'public.json') as string[]).map(BigInt);
        const source = read(directory, 'source.json');
        const onchain = read(directory, 'onchain.json');
        const report = loadRethBatchReport(block);
        if (inputs[0] !== BigInt(program.programVKey)) problem('ключ программы не тот, что в program.json');
        if (inputs[2] !== 0n) problem('exitCode не ноль');
        if (inputs[3] !== BigInt(key.vkRoot)) problem('vkRoot не тот, что у закреплённого верификатора');
        if (inputs[4] !== 0n) problem('нонс не ноль');
        if (source.kind !== 'batch' || source.program !== 'evm') problem('это не пруф программы батча EVM');
        if (source.elfSha256 !== program.programElfSha256) problem('построен для другого ELF, чем записан в program.json');
        if (report.programElfSha256.replace(/^0x/, '') !== program.programElfSha256.replace(/^0x/, '')) problem('блок исполнен другим ELF');
        if (inputs[1] !== publicInputOf(report.publicValuesBytes)) problem('публичный вход не тот, что даёт блок нынешней цепочки Reth');
        if (String(source.publicValues ?? '').replace(/^0x/, '').length !== 704) problem('публичных значений не 352 байта: пруф прежнего протокола');
        if (JSON.stringify(source.variableInputs) !== '[1]') problem('переменных входов должно быть ровно один (дайджест)');
        const vkHash = '0x' + Cell.fromBase64(onchain.hinted.vkDataBoc).hash().toString('hex');
        if (vkHash !== key.keyHash) problem('ключ контракта не тот, что выведен из исходников (key.json)');
    }
    return { current: problems.length === 0, reason: problems.join('; ') };
}

/** Пруф SP1 блока Reth вместе с подсказками для контракта и данными батча. */
export const loadProvenRethBatch = (block: number): ProvenEvmBatch => provenBatch(rethProofDirectory(block), loadRethBatchReport(block));
