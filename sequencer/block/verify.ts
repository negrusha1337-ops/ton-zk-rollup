import { EvmBatchReport } from '../../wrappers/evmProofs';
import { RollupWitness } from '../program';
import { NodeRpc } from '../rpc';
import { Pending, Tip } from '../state';
import {
    anchorMismatches,
    bridgeLeaves,
    expectedPublicValues,
    forcedFateMismatches,
    LogEntry,
    reportMismatches,
} from './expected';

// Проверка кандидата по данным узла: свидетель для программы (кроме входа блока от rsp) и
// собственный расчёт сервиса против отчёта программы.

const hex = (value: bigint | number) => '0x' + BigInt(value).toString(16);

/** Свидетель батча: очередь отрезка, фронтир дерева выводов, доказательства счетов отправителей на родителе. */
export async function collectWitness(node: NodeRpc, pending: Pending, tip: Tip): Promise<RollupWitness> {
    const accountProofs: RollupWitness['accountProofs'] = [];
    for (const address of pending.signers) {
        const proof = await node.eth<{ accountProof: string[] }>('eth_getProof', [address, [], hex(tip.number)]);
        const code = await node.eth<string>('eth_getCode', [address, hex(tip.number)]);
        accountProofs.push({ address, accountProof: proof.accountProof, ...(code === '0x' ? {} : { code }) });
    }
    return {
        prevDepositHash: '0x' + tip.queue.hash.toString(16).padStart(64, '0'),
        queueProcessedFrom: tip.queue.count,
        queue: pending.segment.map(({ item }) =>
            item.kind === 'deposit'
                ? { deposit: { l2Recipient: item.l2Recipient, amount: item.amount.toString() } }
                : { forcedTransaction: '0x' + item.bytes.toString('hex') },
        ),
        withdrawalsFrontier: tip.tree.frontier.map((value) => '0x' + value.toString(16).padStart(64, '0')),
        withdrawalsCount: tip.tree.count.toString(),
        accountProofs,
    };
}

/**
 * Собственный расчёт сервиса против программы: 11 слов, отметки, фронтир, данные батча (RLP блока
 * у узла), судьба принудительных по порядку. Несущие слова — первыми.
 */
export async function crossCheck(
    node: NodeRpc,
    chainId: bigint,
    pending: Pending,
    tip: Tip,
    report: EvmBatchReport,
): Promise<{ expected: ReturnType<typeof expectedPublicValues>; mismatches: string[] }> {
    const hash = pending.payload.blockHash;
    const receipts = await node.eth<{ logs: LogEntry[] }[]>('eth_getBlockReceipts', [hex(pending.number)]);
    const expected = expectedPublicValues({
        chainId,
        parentHash: tip.hash,
        candidateHash: hash,
        timestamp: Number(BigInt(pending.payload.timestamp)),
        queueFrom: tip.queue,
        segment: pending.segment,
        treeBefore: tip.tree,
        leaves: bridgeLeaves(receipts),
        dataChunks: report.dataChunksHex.map((chunk) => Buffer.from(chunk, 'hex')),
    });
    // Несущие слова — первыми и отдельно: отчёт о другом блоке или от другой вершины.
    const mismatches = [...anchorMismatches(report, tip.hash, hash), ...reportMismatches(report, expected, tip.queue)];
    const rawBlock = await node.eth<string>('debug_getRawBlock', [hash]);
    if (rawBlock.replace(/^0x/, '') !== report.dataChunksHex.join(''))
        mismatches.push('данные батча — не RLP блока со слов узла');
    // Судьба принудительных — по порядку (две одинаковые в отрезке законны).
    mismatches.push(
        ...forcedFateMismatches(pending.segment, report.forced, pending.payload.transactions.slice(0, pending.forcedCount)),
    );
    return { expected, mismatches };
}
