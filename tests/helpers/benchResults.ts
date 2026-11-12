import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';

export type BenchRow = {
    /** Имя схемы из zk/circuits.mjs. */
    circuit: string;
    /** Число публичных входов Groth16. */
    publicInputs: number;
    /** Газ фазы вычислений транзакции верификации (измерен в Sandbox). */
    gasUsed: number;
    /** Размер кода контракта (ключ верификации зашит в код). */
    codeCells: number;
    codeBits: number;
    /** Размер тела сообщения с доказательством и публичными входами. */
    bodyCells: number;
    bodyBits: number;
    note?: string;
};

const RESULTS_DIR = path.join(__dirname, '..', '..', 'bench', 'gas-results');

/**
 * Каждый тестовый файл пишет свой JSON: Jest гоняет файлы параллельно, и общий
 * файл с чтением-изменением-записью давал бы гонку.
 * Результаты коммитятся: по ним zk/cost-report.mjs считает стоимость в TON.
 */
export function saveBenchSection(section: string, rows: BenchRow[], extra: Record<string, unknown> = {}) {
    const content = {
        source: 'Измерено в @ton/sandbox тестами tests/*.spec.ts; не редактировать вручную',
        section,
        rows,
        ...extra,
    };
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(path.join(RESULTS_DIR, `${section}.json`), JSON.stringify(content, null, 2) + '\n');
}
