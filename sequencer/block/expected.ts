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
