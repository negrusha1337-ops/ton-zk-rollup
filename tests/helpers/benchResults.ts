import { mkdirSync, readdirSync, writeFileSync } from 'fs';
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

/**
 * Записывает измерения газа одного набора тестов в bench/<файл>. Пишет, только если
 * набор отработал целиком — собраны все обязательные измерения и все они положительны.
 * Иначе файл не трогается: прогон с упавшими тестами не должен затирать верные цифры
 * неполными (так уже однажды были потеряны bench/rollup-zkvm-proof.json и rollup-escape.json).
 */
export function saveGasReport(
    fileName: string,
    header: Record<string, unknown>,
    gas: Record<string, number>,
    required: string[],
) {
    // Пока работает скрипт мутаций (zk/evm-exit-mutation-check.py, zk/rollup-mutation-check.py),
    // в рабочем дереве лежит контракт со снятой защитой, а рядом — копия исходника (*.tolk.orig):
    // его замеры в bench попасть не должны, кто бы ни запустил тесты.
    const contracts = path.join(__dirname, '..', '..', 'contracts');
    const mutating = [contracts, path.join(contracts, 'rollup')].some((directory) =>
        readdirSync(directory).some((name) => name.endsWith('.tolk.orig')),
    );
    if (mutating) {
        console.warn(`bench/${fileName} не обновлён: идёт проверка мутациями, контракт подменён`);
        return;
    }
    const missing = required.filter((name) => !(gas[name] > 0));
    if (missing.length > 0) {
        console.warn(`bench/${fileName} не обновлён: нет измерений ${missing.join(', ')}`);
        return;
    }
    const file = path.join(__dirname, '..', '..', 'bench', fileName);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...header, ...gas }, null, 2) + '\n');
}
