// Переводит измеренный газ (bench/gas-results/*.json) в TON по ценам из
// bench/network-config.json и печатает Markdown-таблицы для REPORT.md.
// Ничего не измеряет сам: газ — из Sandbox, цены — из конфига сети.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_POINT = 65536n;

function readJson(relative, hint) {
    try {
        return JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
    } catch (err) {
        console.error(`Не удалось прочитать ${relative}: ${err.message}. ${hint}`);
        process.exit(1);
    }
}

function readResults() {
    const dir = path.join(ROOT, 'bench', 'gas-results');
    let files;
    try {
        files = readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .sort();
    } catch (err) {
        console.error(`Нет каталога bench/gas-results (${err.message}). Сначала запусти npx blueprint test.`);
        process.exit(1);
    }
    return Object.fromEntries(
        files.map((f) => {
            const data = readJson(path.join('bench', 'gas-results', f), 'Перезапусти npx blueprint test.');
            return [data.section, data];
        }),
    );
}

const results = readResults();
const network = readJson('bench/network-config.json', 'Сначала запусти npm run zk:network-config.');

const ceilDiv = (a, b) => (a + b - 1n) / b;

/** Плата за газ по формуле TON: фиксированная часть + (gas - flat_limit) * price. */
function gasFeeNano(gasUsed, gas) {
    const used = BigInt(gasUsed);
    const flatLimit = BigInt(gas.flatGasLimit);
    if (used <= flatLimit) return BigInt(gas.flatGasPriceNano);
    return BigInt(gas.flatGasPriceNano) + ceilDiv((used - flatLimit) * BigInt(gas.gasPriceRaw), FIXED_POINT);
}

/** Оценка сверху платы за пересылку тела сообщения (считаем все ячейки тела). */
function forwardFeeNano(row, forward) {
    const variable = Math.ceil(
        row.bodyBits * forward.bitPriceNanoPerBit + row.bodyCells * forward.cellPriceNanoPerCell,
    );
    return BigInt(forward.lumpPriceNano) + BigInt(variable);
}

const ton = (nano) => (Number(nano) / 1e9).toFixed(6);
const percent = (gas, limit) => ((gas / limit) * 100).toFixed(1) + '%';

function table(rows, label) {
    const base = network.basechain;
    const master = network.masterchain;
    const lines = [
        `| ${label} | Публичных входов | Газ (Sandbox) | Доля лимита 1M | Газ, TON (basechain) | Газ, TON (masterchain) | Пересылка, TON (basechain, оценка сверху) |`,
        '|---|---|---|---|---|---|---|',
    ];
    for (const row of rows) {
        lines.push(
            `| ${row.circuit} | ${row.publicInputs} | ${row.gasUsed.toLocaleString('ru-RU')} | ` +
                `${percent(row.gasUsed, base.gas.gasLimit)} | ${ton(gasFeeNano(row.gasUsed, base.gas))} | ` +
                `${ton(gasFeeNano(row.gasUsed, master.gas))} | ${ton(forwardFeeNano(row, base.forward))} |`,
        );
    }
    return lines.join('\n');
}

console.log(`Цены: ${network.source}, снято ${network.fetchedAt} (mainnet, global version ${network.globalVersion}).`);
console.log(
    `Basechain: ${network.basechain.gas.gasPriceNanoPerGas.toFixed(2)} нанотон/gas; masterchain: ${network.masterchain.gas.gasPriceNanoPerGas} нанотон/gas.\n`,
);

for (const [section, data] of Object.entries(results)) {
    if (!data?.rows) continue;
    console.log(`### ${section}\n`);
    console.log(table(data.rows, 'Схема'));
    const extra = Object.fromEntries(Object.entries(data).filter(([k]) => !['rows', 'source', 'section'].includes(k)));
    if (Object.keys(extra).length) console.log(`\nДополнительно: ${JSON.stringify(extra)}`);
    console.log();
}

// Наклон по двум последним точкам основной серии — только как ориентир:
// рост нелинейный (сгенерированный код ищет IC-точки линейным перебором).
const series = results.byPublicInputs?.rows ?? [];
if (series.length >= 2) {
    const prev = series[series.length - 2];
    const last = series[series.length - 1];
    const perInput = (last.gasUsed - prev.gasUsed) / (last.publicInputs - prev.publicInputs);
    const maxInputs = Math.floor(last.publicInputs + (network.basechain.gas.gasLimit - last.gasUsed) / perInput);
    console.log(
        `Экстраполяция (не измерение): ~${Math.round(perInput).toLocaleString('ru-RU')} gas на вход между ` +
            `${prev.publicInputs} и ${last.publicInputs} входами; лимит 1M исчерпается не позже чем на ~${maxInputs} входах.`,
    );
}
