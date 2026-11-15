import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell } from '@ton/core';
import { keccak_256 } from '@noble/hashes/sha3';
import {
    evmHeaderCell,
    evmNodeItems,
    evmProofCell,
    evmProofSteps,
    evmSignatureCell,
    evmSignatureFromHex,
} from '../../wrappers/evmExit';
import {
    batchRootsOf,
    dataChunksOf,
    EvmBatchReport,
    loadRethBatchReport,
    loadRethExpected,
    publicInputOf,
    RETH_CHAIN_BLOCKS,
    RethExit,
    RethQueueItem,
} from '../../wrappers/evmProofs';
import { Rollup } from '../../wrappers/Rollup';
import { depositHash, forcedTransactionCell, forcedTransactionHash, WithdrawalLeaf } from '../../wrappers/rollupMath';

// Цепочка узла Reth протокола v2 (fixtures/evm_batches/reth, пишет zkvm-evm/scenario/reth-scenario.mjs)
// глазами контракта: очередь L1 сообщениями, батч k — блок k. Общие шаги наборов на двойнике
// (tests/RollupEvmReth.spec.ts) и на настоящем контракте по пруфам (tests/RollupEvmRethProof.spec.ts).

export const rethExpected = loadRethExpected();
/** Отчёты хоста о блоках 1…N: reports[k − 1] — блок k. */
export const rethReports: EvmBatchReport[] = Array.from({ length: RETH_CHAIN_BLOCKS }, (_, index) =>
    loadRethBatchReport(index + 1),
);
export const hexBytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex');
/** 1 нанотон = 1 gwei (EVM_WEI_PER_NANOTON в evm_exit.tolk). */
export const WEI_PER_NANOTON = 1_000_000_000n;
/** Сколько секунд после времени блока тест «принимает» батч: внутри maxBlockAge. */
export const BATCH_DELAY_SECONDS = 60;

export const blockOf = (number: number) => rethExpected.blocks[number - 1];
export const reportOf = (number: number) => rethReports[number - 1];

/** Хеш очереди L1 после элемента — та же формула, что в контракте и в программе. */
export const queueHashAfter = (previous: bigint, item: RethQueueItem): bigint =>
    item.kind === 'deposit'
        ? depositHash(previous, BigInt(item.l2Recipient), BigInt(item.amount))
        : forcedTransactionHash(previous, hexBytes(item.bytes));

/** hashes[n] — хеш очереди цепочки после n элементов, посчитанный вне контракта. */
export const rethQueueHashes = (): bigint[] => {
    const hashes = [0n];
    for (const item of rethExpected.queue) hashes.push(queueHashAfter(hashes[hashes.length - 1], item));
    return hashes;
};

/** Листья дерева выводов цепочки после блока `number` включительно. */
export const withdrawalLeavesUpTo = (number: number): WithdrawalLeaf[] =>
    rethExpected.withdrawals
        .filter((leaf) => leaf.block <= number)
        .map((leaf) => ({ leafIndex: leaf.leafIndex, recipientHash: BigInt(leaf.recipientHash), amount: BigInt(leaf.amount) }));

/** Заголовок блока (RLP целиком) из данных батча: данные — RLP блока, заголовок — его первый элемент. */
export function blockHeaderOf(number: number): Buffer {
    const header = evmNodeItems(hexBytes(reportOf(number).dataChunksHex.join('')))[0];
    const hash = '0x' + Buffer.from(keccak_256(header)).toString('hex');
    if (hash !== blockOf(number).hash) throw new Error(`blockHeaderOf: хеш заголовка блока ${number} не тот`);
    return header;
}

export type RethActors = {
    blockchain: Blockchain;
    rollup: SandboxContract<Rollup>;
    sequencer: SandboxContract<TreasuryContract>;
    user: SandboxContract<TreasuryContract>;
};

/**
 * Ставит в очередь L1 контракта элементы цепочки до номера `upTo` включительно — сообщениями,
 * как это делали бы пользователи: депозит с суммой элемента сверх комиссии, принудительная
 * транзакция с её байтами. После каждого сверяет номер и хеш очереди контракта с посчитанным
 * вне контракта. Возвращает сумму депозитов, зачисляемую на L2.
 */
export async function enqueueUpTo({ rollup, user }: RethActors, upTo: number): Promise<bigint> {
    let deposited = 0n;
    let head = (await rollup.getDepositQueue()).head;
    for (const item of rethExpected.queue) {
        if (item.number <= Number(head.count) || item.number > upTo) continue;
        const fees = await rollup.getQueueFees();
        const result =
            item.kind === 'deposit'
                ? await rollup.sendDeposit(user.getSender(), {
                      l2Recipient: BigInt(item.l2Recipient),
                      value: BigInt(item.amount) + fees.depositFee,
                      maxFee: fees.depositFee,
                  })
                : await rollup.sendForceTransaction(user.getSender(), {
                      l2Transaction: forcedTransactionCell(hexBytes(item.bytes)),
                      value: fees.forceTransactionFee,
                  });
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        const expectedHead = { count: BigInt(item.number), hash: queueHashAfter(head.hash, item) };
        head = (await rollup.getDepositQueue()).head;
        expect(head).toEqual(expectedHead);
        if (item.kind === 'deposit') deposited += BigInt(item.amount);
    }
    expect(Number(head.count)).toBe(upTo);
    return deposited;
}

/**
 * Готовит батч с блоком `number`: выставляет время L1 чуть позже времени блока, доводит очередь
 * до состояния на момент приёма батча (headAtBatch), публикует данные блока и СВЕРЯЕТ публичный
 * вход — тот, что контракт соберёт из своего хранилища, очереди и опубликованных данных, с
 * одиннадцатью словами, которые программа выдала в zkVM для этого блока. Это главная сверка
 * «контракт и программа считают одно и то же». Возвращает то, что батч заявляет, и оба входа.
 */
export async function prepareRethBatch(actors: RethActors, number: number, publishValue: bigint) {
    const { blockchain, rollup, sequencer } = actors;
    const report = reportOf(number);
    const block = blockOf(number);
    blockchain.now = block.timestamp + BATCH_DELAY_SECONDS;
    await enqueueUpTo(actors, block.headAtBatch);
    for (const data of dataChunksOf(report)) {
        const published = await rollup.sendPublishData(sequencer.getSender(), { batchIndex: number, data, value: publishValue });
        expect(published.transactions).toHaveTransaction({ to: rollup.address, success: true });
    }
    expect(await rollup.getBatchDataHash(number)).toBe(BigInt(report.publicValues.batchHash));
    const roots = batchRootsOf(report);
    const required = await rollup.getExpectedPublicInput(roots);
    const proven = publicInputOf(report.publicValuesBytes);
    return { roots, required, proven };
}

/** Ячейки сообщения ForceExitEvm для выхода счёта против блока `number`. */
export function rethExitMessage(number: number, exit: RethExit): { header: Cell; proof: Cell; signature: Cell } {
    return {
        header: evmHeaderCell(blockHeaderOf(number)),
        proof: evmProofCell(evmProofSteps(exit.accountProof.map(hexBytes))),
        signature: evmSignatureCell(evmSignatureFromHex(exit.signature)),
    };
}

/** Получатель выплат цепочки: на этот адрес подписаны согласия на выход и выведены все листья моста. */
export const rethRecipient = (): Address => new Address(0, hexBytes(rethExpected.exitRecipientHash));
