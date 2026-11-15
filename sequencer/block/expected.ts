import { Cell } from '@ton/core';
import { EvmBatchReport, publicValuesOf } from '../../wrappers/evmProofs';
import {
    appendWithdrawalLeaf,
    batchDataHash,
    BatchPublicValues,
    batchPublicValueWords,
    dataChunkCell,
    withdrawalFrontierRoot,
    withdrawalLeafHash,
} from '../../wrappers/rollupMath';
import { queueStep } from '../queue/messages';
import { QueuedItem, QueueMark } from '../queue/types';
import { BRIDGE_ADDRESS, WITHDRAWAL_TOPIC } from '../protocol';

// Собственный расчёт сервиса — то, что программа ОБЯЗАНА выдать для кандидата, из данных,
// которые сервис знает сам: хеш очереди — по своей очереди, сверенной с контрактом; дерево
// выводов — по логам моста в квитанциях узла (формулы wrappers/rollupMath.ts, они же —
// контракт); слова состояния — хеши родителя и кандидата со слов узла. Чистые функции.

export type LogEntry = { address: string; topics: string[]; data: string };
export type WithdrawalLeafValue = { recipientHash: bigint; amount: bigint };

/** Листья дерева выводов из квитанций блока: логи с адреса моста по порядку, как bridge.rs. */
export function bridgeLeaves(receipts: { logs: LogEntry[] }[]): WithdrawalLeafValue[] {
    const leaves: WithdrawalLeafValue[] = [];
    for (const log of receipts.flatMap((receipt) => receipt.logs)) {
        if (log.address.toLowerCase() !== BRIDGE_ADDRESS) continue;
        const data = log.data.replace(/^0x/, '');
        if (
            log.topics.length !== 2 ||
            log.topics[0].toLowerCase() !== WITHDRAWAL_TOPIC ||
            !/^0x0{24}/.test(log.topics[1]) ||
            data.length !== 128
        ) {
            throw new Error('лог моста не той формы, которую пишет его код');
        }
        const amount = BigInt('0x' + data.slice(64));
        if (amount >= 1n << 128n) throw new Error('сумма в логе моста больше u128');
        leaves.push({ recipientHash: BigInt('0x' + data.slice(0, 64)), amount });
    }
    return leaves;
}

/** Дерево выводов: фронтир и счётчик (вход следующего батча). */
export type WithdrawalState = { frontier: bigint[]; count: bigint };

export function appendLeaves(tree: WithdrawalState, leaves: WithdrawalLeafValue[]): WithdrawalState {
    let { frontier, count } = tree;
    for (const leaf of leaves) {
        const hash = withdrawalLeafHash({
            leafIndex: Number(count),
            recipientHash: leaf.recipientHash,
            amount: leaf.amount,
        });
        ({ frontier, count } = appendWithdrawalLeaf(frontier, count, hash));
    }
    return { frontier, count };
}

/** Хеш очереди после отрезка. */
export const queueAfter = (from: QueueMark, segment: QueuedItem[]): QueueMark => ({
    count: from.count + segment.length,
    hash: segment.reduce((hash, { item }) => queueStep(hash, item), from.hash),
});

/** Что программа обязана выдать для кандидата. */
export function expectedPublicValues(options: {
    chainId: bigint;
    parentHash: string;
    candidateHash: string;
    timestamp: number;
    queueFrom: QueueMark;
    segment: QueuedItem[];
    treeBefore: WithdrawalState;
    leaves: WithdrawalLeafValue[];
    dataChunks: Buffer[];
}): { values: BatchPublicValues; treeAfter: WithdrawalState; queue: QueueMark } {
    const treeAfter = appendLeaves(options.treeBefore, options.leaves);
    const queue = queueAfter(options.queueFrom, options.segment);
    const chunks: Cell[] = options.dataChunks.map((chunk) => dataChunkCell(chunk));
    return {
        values: {
            chainId: options.chainId,
            prevStateRoot: BigInt(options.parentHash),
            newStateRoot: BigInt(options.candidateHash),
            batchHash: batchDataHash(chunks),
            prevWithdrawalsRoot: withdrawalFrontierRoot(options.treeBefore.frontier, options.treeBefore.count),
            withdrawalsRoot: withdrawalFrontierRoot(treeAfter.frontier, treeAfter.count),
            prevDepositHash: options.queueFrom.hash,
            newDepositHash: queue.hash,
            prevWithdrawalsCount: options.treeBefore.count,
            withdrawalsCount: treeAfter.count,
            blockTimestamp: BigInt(options.timestamp),
        },
        treeAfter,
        queue,
    };
}

const WORD_NAMES = [
    'chainId',
    'prevStateRoot',
    'newStateRoot',
    'batchHash',
    'prevWithdrawalsRoot',
    'withdrawalsRoot',
    'prevDepositHash',
    'newDepositHash',
    'prevWithdrawalsCount',
    'withdrawalsCount',
    'blockTimestamp',
];

/** Расхождения отчёта программы с собственным расчётом: слова, отметки очереди, фронтир. */
export function reportMismatches(
    report: EvmBatchReport,
    expected: { values: BatchPublicValues; treeAfter: WithdrawalState; queue: QueueMark },
    queueFrom: QueueMark,
): string[] {
    const program = batchPublicValueWords(publicValuesOf(report));
    const own = batchPublicValueWords(expected.values);
    const out = WORD_NAMES.flatMap((name, index) =>
        program[index] === own[index]
            ? []
            : [`${name}: у программы 0x${program[index].toString(16)}, у сервиса 0x${own[index].toString(16)}`],
    );
    if (report.queueProcessedFrom !== queueFrom.count || report.queueProcessedUpTo !== expected.queue.count) {
        out.push(
            `отметки очереди у программы ${report.queueProcessedFrom}..${report.queueProcessedUpTo}, у сервиса ${queueFrom.count}..${expected.queue.count}`,
        );
    }
    const frontier = report.withdrawalsFrontierAfter.map((node) => BigInt(node));
    if (
        frontier.length !== expected.treeAfter.frontier.length ||
        frontier.some((node, index) => node !== expected.treeAfter.frontier[index])
    ) {
        out.push('фронтир дерева выводов после блока не тот');
    }
    // Байты публичных значений — те же слова (их sha256 и есть публичный вход контракта).
    const bytes = Buffer.from(report.publicValuesBytes.replace(/^0x/, ''), 'hex');
    const words = Array.from({ length: bytes.length / 32 }, (_, index) =>
        BigInt('0x' + bytes.subarray(index * 32, index * 32 + 32).toString('hex')),
    );
    if (bytes.length !== 352 || words.some((word, index) => word !== own[index]))
        out.push('байты публичных значений не те');
    return out;
}

/**
 * Несущие слова отдельно: блок, который доказывает пруф, — ровно кандидат, и стоит он ровно на
 * проверенной вершине. Остальное (reportMismatches) осмысленно только при этих двух.
 */
export function anchorMismatches(report: EvmBatchReport, parentHash: string, candidateHash: string): string[] {
    const out: string[] = [];
    const word = (value: string) => {
        try {
            return BigInt(value);
        } catch {
            return -1n;
        }
    };
    if (word(report.publicValues.newStateRoot) !== BigInt(candidateHash))
        out.push(
            `newStateRoot программы ${report.publicValues.newStateRoot} — не хеш кандидата ${candidateHash}: отчёт о другом блоке`,
        );
    if (word(report.publicValues.prevStateRoot) !== BigInt(parentHash))
        out.push(
            `prevStateRoot программы ${report.publicValues.prevStateRoot} — не хеш проверенной вершины ${parentHash}`,
        );
    return out;
}

/**
 * Судьба принудительных — ПО ПОРЯДКУ, не по множеству байтов: две одинаковые принудительные в
 * одном отрезке законны (копию чужой ставит кто угодно), программа включает первую и пропускает
 * вторую (круг 18, H1). Идём по принудительным отрезка: i-я запись отчёта — о i-й принудительной
 * (её место в отрезке — queueIndex), каждая включённая — следующая транзакция блока байт в байт,
 * и других принудительных в блоке нет. `blockForced` — первые транзакции блока (принудительные).
 */
export function forcedFateMismatches(
    segment: QueuedItem[],
    forced: EvmBatchReport['forced'],
    blockForced: string[],
): string[] {
    const out: string[] = [];
    const positions = segment.flatMap(({ item }, position) => (item.kind === 'forced' ? [{ item, position }] : []));
    if (forced.length !== positions.length)
        out.push(`в отчёте программы принудительных ${forced.length}, в отрезке ${positions.length}`);
    let next = 0;
    positions.forEach(({ item, position }, index) => {
        const outcome = forced[index];
        if (!outcome) return;
        if (outcome.queueIndex !== position)
            out.push(
                `принудительная №${item.number}: у программы место в отрезке ${outcome.queueIndex}, у сервиса ${position}`,
            );
        if (outcome.outcome !== 'included') return;
        const raw = '0x' + item.bytes.toString('hex');
        const atBlock = blockForced[next];
        if (atBlock === undefined || atBlock.toLowerCase() !== raw)
            out.push(
                `принудительная №${item.number}: программа включила её, а транзакция блока №${next} — ${atBlock === undefined ? 'нет такой' : 'другая'}`,
            );
        next++;
    });
    if (next !== blockForced.length)
        out.push(`в блоке принудительных ${blockForced.length}, а программа включила ${next}`);
    return out;
}
