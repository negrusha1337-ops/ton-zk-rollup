import { readFileSync } from 'fs';
import { Bn254Proof } from '../wrappers/Bn254Groth16Verifier';

// Прувер — интерфейс. В этом шаге одна реализация: заглушка для двойника контракта
// (contracts/rollup_mock.tolk), которому пруф не нужен. Настоящий прувер (SP1 Groth16 через
// rollup-evm-host --prove, сервер или сеть пруверов) — следующий шаг этапа 2.

/** Задание пруверу: всё, что нужно для пруфа батча, лежит в каталоге блока. */
export type ProverJob = {
    number: number;
    blockHash: string;
    /** Вход батча для программы (bincode, --write-input хоста). */
    batchInput: string;
    /** Отчёт хоста: 11 слов, данные батча, отметки очереди. */
    report: string;
    /** 352 байта публичных значений — пруф обязан доказать ровно их. */
    publicValuesBytes: string;
    programElfSha256: string;
};

/** Пруф батча в виде, который принимает SubmitBatch: точки и подсказки проверки (ячейка). */
export type BatchProof = { kind: 'mock' | 'groth16'; proof: Bn254Proof; hintsBoc: string | null };

export interface Prover {
    prove(job: ProverJob): Promise<BatchProof>;
    /**
     * Отменить задание: блок пересобирается, его батч контракт уже не примет. Прувер, у которого
     * заданий в фоне нет, может не реализовывать.
     */
    cancel?(job: ProverJob): Promise<void>;
}

/** Заглушка пруфа, которую принимает двойник: «первое число пруфа равно 1». */
export const MOCK_PROOF: Bn254Proof = {
    a: [1n, 0n],
    b: [
        [0n, 0n],
        [0n, 0n],
    ],
    c: [0n, 0n],
};

/** Прувер для двойника: пруф не строится. Проверяет только, что задание полное. */
export class MockProver implements Prover {
    async prove(job: ProverJob): Promise<BatchProof> {
        const report = JSON.parse(readFileSync(job.report, 'utf8')) as {
            publicValuesBytes: string;
            publicValues: { newStateRoot: string };
        };
        if (report.publicValuesBytes !== job.publicValuesBytes || report.publicValues.newStateRoot !== job.blockHash) {
            throw new Error(`задание пруверу для блока ${job.number} не совпадает с отчётом хоста`);
        }
        readFileSync(job.batchInput); // вход батча обязан существовать
        return { kind: 'mock', proof: MOCK_PROOF, hintsBoc: null };
    }
}
