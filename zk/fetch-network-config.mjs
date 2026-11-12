// Снимает актуальные параметры газа mainnet и сохраняет в bench/network-config.json.
// Источник — публичный API tonapi.io (конфиг-параметры 8, 20, 21, 24, 25).
// Цены в конфиге хранятся с фиксированной точкой: значение / 65536 = нанотон.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL = 'https://tonapi.io/v2/blockchain/config';
const FIXED_POINT = 65536;

const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) {
    console.error(`tonapi ответил ${response.status} ${response.statusText}`);
    process.exit(1);
}
const config = await response.json();

function gasParams(id) {
    const raw = config[String(id)]?.gas_limits_prices;
    if (!raw) throw new Error(`В ответе нет конфиг-параметра ${id}`);
    return {
        configParam: id,
        gasLimit: raw.gas_limit,
        specialGasLimit: raw.special_gas_limit,
        gasCredit: raw.gas_credit,
        blockGasLimit: raw.block_gas_limit,
        flatGasLimit: raw.flat_gas_limit,
        flatGasPriceNano: raw.flat_gas_price,
        gasPriceRaw: raw.gas_price,
        gasPriceNanoPerGas: raw.gas_price / FIXED_POINT,
    };
}

function forwardParams(id) {
    const raw = config[String(id)]?.msg_forward_prices;
    if (!raw) throw new Error(`В ответе нет конфиг-параметра ${id}`);
    return {
        configParam: id,
        lumpPriceNano: raw.lump_price,
        bitPriceNanoPerBit: raw.bit_price / FIXED_POINT,
        cellPriceNanoPerCell: raw.cell_price / FIXED_POINT,
    };
}

try {
    const snapshot = {
        network: 'mainnet',
        fetchedAt: new Date().toISOString(),
        source: SOURCE_URL,
        globalVersion: config['8']?.version ?? null,
        masterchain: { gas: gasParams(20), forward: forwardParams(24) },
        basechain: { gas: gasParams(21), forward: forwardParams(25) },
    };
    const file = path.join(ROOT, 'bench', 'network-config.json');
    writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`Сохранено: ${path.relative(ROOT, file)}`);
    console.log(JSON.stringify(snapshot, null, 2));
} catch (err) {
    console.error(`Не удалось разобрать конфиг: ${err.message}`);
    process.exit(1);
}
