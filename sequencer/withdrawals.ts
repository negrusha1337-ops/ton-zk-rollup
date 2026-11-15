import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { Address, Cell } from '@ton/core';
import type { EvmBatchReport } from '../wrappers/evmProofs';
import { merkleProofCell, WithdrawalLeaf, withdrawalTree } from '../wrappers/rollupMath';
import { GENESIS_HASH } from './protocol';

// Выводы через мост на L1: листья дерева выводов и их Merkle-доказательства для сообщения
// Withdraw. Листья берутся из отчётов блоков сервиса (`stateDir/blocks/<N>/report.json` — отчёт
// хоста о блоке, исполненном программой) для батчей 1…batchIndex, принятых контрактом, и
// сверяются с контрактом: корень дерева и число листьев обязаны совпасть с rollupState. Иначе —
// отказ (WithdrawalsMismatch): доказательство по чужим листьям контракт отвергнет (7308).
//
// Отчёты связываются в цепочку: блок N продолжает N−1 (prevStateRoot — newStateRoot
// предыдущего, у блока 1 — генезис протокола), счётчик выводов идёт без пропусков, номера листьев
// — подряд с prevWithdrawalsCount. Каталог `blocks/<N>` — проверенный блок; пересобранные лежат в
// `blocks/<N>.stale-<хеш>` и сюда не попадают.

/** Отчёты сервиса не сходятся с контрактом (или их нет): доказательства не посчитать. */
export class WithdrawalsMismatch extends Error {}

export type WithdrawalClaim = WithdrawalLeaf & {
    /** Номер блока (батча), дозаписавшего лист. */
    block: number;
    /** Соседи по пути к корню, снизу вверх (32 хеша). */
    proof: bigint[];
};

/** Что контракт сообщает о выводах (get-метод rollupState). */
export type ContractWithdrawals = { batchIndex: number; stateRoot: bigint; withdrawalsRoot: bigint; withdrawalsCount: bigint };

type ReportPart = Pick<EvmBatchReport, 'blockNumber' | 'withdrawals'> & {
    publicValues: Pick<EvmBatchReport['publicValues'], 'prevStateRoot' | 'newStateRoot' | 'prevWithdrawalsCount' | 'withdrawalsCount' | 'withdrawalsRoot'>;
};

function readReport(stateDir: string, block: number): ReportPart {
    const file = path.join(stateDir, 'blocks', String(block), 'report.json');
    if (!existsSync(file))
        throw new WithdrawalsMismatch(`нет ${file}: контракт принял батч ${block}, а отчёта блока в каталоге сервиса нет — доказательства выводов считать не из чего`);
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as ReportPart;
    } catch (error) {
        throw new WithdrawalsMismatch(`${file} не разбирается: ${(error as Error).message}`);
    }
}

/** Все листья дерева выводов после батча batchIndex с доказательствами; сверены с контрактом. */
export function withdrawalClaims(stateDir: string, contract: ContractWithdrawals): WithdrawalClaim[] {
    const leaves: (WithdrawalLeaf & { block: number })[] = [];
    let previousRoot = BigInt(GENESIS_HASH);
    for (let block = 1; block <= contract.batchIndex; block++) {
        const report = readReport(stateDir, block);
        const values = report.publicValues;
        if (report.blockNumber !== block) throw new WithdrawalsMismatch(`отчёт в blocks/${block} — о блоке ${report.blockNumber}`);
        if (BigInt(values.prevStateRoot) !== previousRoot)
            throw new WithdrawalsMismatch(`блок ${block} не продолжает блок ${block - 1}: prevStateRoot ${values.prevStateRoot}, а ожидался 0x${previousRoot.toString(16)}`);
        if (BigInt(values.prevWithdrawalsCount) !== BigInt(leaves.length))
            throw new WithdrawalsMismatch(`блок ${block}: prevWithdrawalsCount ${values.prevWithdrawalsCount}, а листьев до него ${leaves.length}`);
        for (const leaf of report.withdrawals) {
            if (leaf.leafIndex !== leaves.length)
                throw new WithdrawalsMismatch(`блок ${block}: лист ${leaf.leafIndex} не по порядку (ожидался ${leaves.length})`);
            leaves.push({ leafIndex: leaf.leafIndex, recipientHash: BigInt(leaf.recipientHash), amount: BigInt(leaf.amount), block });
        }
        if (BigInt(values.withdrawalsCount) !== BigInt(leaves.length))
            throw new WithdrawalsMismatch(`блок ${block}: withdrawalsCount ${values.withdrawalsCount}, а листьев ${leaves.length}`);
        previousRoot = BigInt(values.newStateRoot);
    }
    if (previousRoot !== contract.stateRoot)
        throw new WithdrawalsMismatch(`слово состояния после блока ${contract.batchIndex} по отчётам 0x${previousRoot.toString(16)}, а у контракта 0x${contract.stateRoot.toString(16)}`);
    const tree = withdrawalTree(leaves);
    if (BigInt(leaves.length) !== contract.withdrawalsCount || tree.root !== contract.withdrawalsRoot)
        throw new WithdrawalsMismatch(
            `дерево выводов по отчётам (${leaves.length} листьев, корень 0x${tree.root.toString(16)}) не то, что у контракта ` +
                `(${contract.withdrawalsCount}, 0x${contract.withdrawalsRoot.toString(16)})`,
        );
    return leaves.map((leaf) => ({ ...leaf, proof: tree.proofFor(leaf.leafIndex) }));
}

/** Хеш адреса получателя, как его кладёт в лист мост (32 байта адреса basechain). */
export const recipientHashOf = (address: Address): bigint => BigInt('0x' + address.hash.toString('hex'));

/** Сообщение Withdraw для листа: доказательство цепочкой ячеек. */
export const claimProofCell = (claim: WithdrawalClaim): Cell => merkleProofCell(claim.proof);
