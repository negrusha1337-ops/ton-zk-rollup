import { beginCell, Cell, Sender, Transaction } from '@ton/core';
import { batchRootsOf, dataChunksOf, EvmBatchReport, publicInputOf } from '../wrappers/evmProofs';
import { BatchRoots, Rollup } from '../wrappers/Rollup';
import { PUBLISH_DATA_VALUE, SUBMIT_BATCH_VALUE } from '../wrappers/rollupValues';
import { BatchProof } from './prover';

// Отправщик батчей — интерфейс. В этом шаге одна реализация — Sandbox: данные батча
// (PublishData) и сам батч (SubmitBatch) на двойник контракта. Отправщик для testnet —
// следующий шаг. Отправка идемпотентна: принятый батч не шлётся второй раз, уже опубликованные
// данные — тоже; и до отправки публичный вход, который соберёт контракт, сверяется с 11 словами
// отчёта программы.

export type Batch = { number: number; blockHash: string; report: EvmBatchReport; proof: BatchProof };

export type SubmitOutcome = { accepted: true; alreadyAccepted: boolean } | { accepted: false; reason: string };

/** Что контракт знает о батчах: номер последнего принятого и его корень (хеш блока). */
export type ContractBatchState = { batchIndex: number; stateRoot: bigint };

export interface BatchSubmitter {
    submit(batch: Batch): Promise<SubmitOutcome>;
    /** Состояние контракта сейчас: сервис спрашивает его ДО проверки срока и до пересборки. */
    contractState(): Promise<ContractBatchState>;
}

/** Двойник контракта в Sandbox, открытый тестом, и то, что тесту нужно знать об отправках. */
export type SandboxRollup = {
    getRollupState(): Promise<{ stateRoot: bigint; batchIndex: number }>;
    getBatchDataHash(batchIndex: number): Promise<bigint>;
    getExpectedPublicInput(roots: BatchRoots): Promise<bigint>;
    sendPublishData(
        via: Sender,
        opts: { batchIndex: number; data: Cell; value: bigint },
    ): Promise<{ transactions: Transaction[] }>;
    sendDiscardBatchData(
        via: Sender,
        opts: { batchIndex: number; value: bigint },
    ): Promise<{ transactions: Transaction[] }>;
    sendSubmitBatch(
        via: Sender,
        opts: Parameters<Rollup['sendSubmitBatch']>[2],
    ): Promise<{ transactions: Transaction[] }>;
};

/** Исход транзакции контракта в результате отправки: успех либо код выхода. */
function contractOutcome(
    result: { transactions: Transaction[] },
    address: { equals(other: unknown): boolean },
): { success: boolean; exitCode: number | null } {
    for (const transaction of result.transactions) {
        const message = transaction.inMessage;
        if (!message || message.info.type !== 'internal' || !address.equals(message.info.dest)) continue;
        const description = transaction.description;
        if (description.type !== 'generic' || description.computePhase.type !== 'vm')
            return { success: false, exitCode: null };
        return {
            success: description.computePhase.success && !description.aborted,
            exitCode: description.computePhase.exitCode,
        };
    }
    return { success: false, exitCode: null };
}

export class SandboxSubmitter implements BatchSubmitter {
    constructor(
        private readonly rollup: SandboxRollup & { address: { equals(other: unknown): boolean } },
        private readonly sender: Sender,
        private readonly record: (result: { transactions: Transaction[] }) => void = () => {},
    ) {}

    async contractState(): Promise<ContractBatchState> {
        const { batchIndex, stateRoot } = await this.rollup.getRollupState();
        return { batchIndex, stateRoot };
    }

    async submit(batch: Batch): Promise<SubmitOutcome> {
        const state = await this.rollup.getRollupState();
        if (state.batchIndex >= batch.number) {
            if (state.batchIndex === batch.number && state.stateRoot !== BigInt(batch.blockHash)) {
                return {
                    accepted: false,
                    reason: `контракт принял батч ${batch.number} с другим блоком 0x${state.stateRoot.toString(16)}`,
                };
            }
            return { accepted: true, alreadyAccepted: true };
        }
        if (state.batchIndex !== batch.number - 1)
            return { accepted: false, reason: `контракт ждёт батч ${state.batchIndex + 1}, а не ${batch.number}` };

        // Данные батча: уже опубликованные целиком не повторяются, частично — сбрасываются.
        const chunks = dataChunksOf(batch.report);
        const want = BigInt(batch.report.publicValues.batchHash);
        const have = await this.rollup.getBatchDataHash(batch.number);
        if (have !== want) {
            if (have !== 0n) {
                const discarded = await this.rollup.sendDiscardBatchData(this.sender, {
                    batchIndex: batch.number,
                    value: PUBLISH_DATA_VALUE,
                });
                this.record(discarded);
                if (!contractOutcome(discarded, this.rollup.address).success)
                    return { accepted: false, reason: 'контракт не сбросил чужие данные батча' };
            }
            for (const data of chunks) {
                const published = await this.rollup.sendPublishData(this.sender, {
                    batchIndex: batch.number,
                    data,
                    value: PUBLISH_DATA_VALUE,
                });
                this.record(published);
                const outcome = contractOutcome(published, this.rollup.address);
                if (!outcome.success)
                    return { accepted: false, reason: `PublishData отвергнут (код ${outcome.exitCode})` };
            }
            if ((await this.rollup.getBatchDataHash(batch.number)) !== want)
                return { accepted: false, reason: 'хеш опубликованных данных не равен batchHash программы' };
        }

        // Публичный вход, который контракт соберёт из своего хранилища, — ровно 11 слов программы.
        const roots = batchRootsOf(batch.report);
        const required = await this.rollup.getExpectedPublicInput(roots);
        const proven = publicInputOf(batch.report.publicValuesBytes);
        if (required !== proven) {
            return {
                accepted: false,
                reason: `контракт ждёт публичный вход 0x${required.toString(16)}, а программа доказывает 0x${proven.toString(16)}`,
            };
        }
        const hints = batch.proof.hintsBoc ? Cell.fromBase64(batch.proof.hintsBoc) : beginCell().endCell();
        const submitted = await this.rollup.sendSubmitBatch(this.sender, {
            proof: batch.proof.proof,
            hints,
            roots,
            value: SUBMIT_BATCH_VALUE,
        });
        this.record(submitted);
        const outcome = contractOutcome(submitted, this.rollup.address);
        if (!outcome.success) return { accepted: false, reason: `SubmitBatch отвергнут (код ${outcome.exitCode})` };
        const after = await this.rollup.getRollupState();
        if (after.batchIndex !== batch.number || after.stateRoot !== BigInt(batch.blockHash))
            return { accepted: false, reason: 'после SubmitBatch состояние контракта не то' };
        return { accepted: true, alreadyAccepted: false };
    }
}
