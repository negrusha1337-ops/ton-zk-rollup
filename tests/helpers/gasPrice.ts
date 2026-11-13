import { beginCell, Cell, Dictionary } from '@ton/core';

const BASECHAIN_GAS_PRICES = 21;

/** Конфиг сети с ценой газа basechain, умноженной на `factor` (параметр 21). */
export function withGasPrice(config: Cell, factor: bigint): Cell {
    const params = Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell(), config);
    const prices = params.get(BASECHAIN_GAS_PRICES)!.beginParse();
    // gas_flat_pfx#d1 flat_gas_limit:uint64 flat_gas_price:uint64, затем
    // gas_prices_ext#de gas_price:uint64 … (остальное — лимиты, их не трогаем).
    if (prices.loadUint(8) !== 0xd1) throw new Error('неожиданный формат параметра 21');
    const flatLimit = prices.loadUintBig(64);
    const flatPrice = prices.loadUintBig(64);
    if (prices.loadUint(8) !== 0xde) throw new Error('неожиданный формат цен газа');
    const gasPrice = prices.loadUintBig(64);
    params.set(
        BASECHAIN_GAS_PRICES,
        beginCell()
            .storeUint(0xd1, 8)
            .storeUint(flatLimit, 64)
            .storeUint(flatPrice * factor, 64)
            .storeUint(0xde, 8)
            .storeUint(gasPrice * factor, 64)
            .storeSlice(prices)
            .endCell(),
    );
    return beginCell().storeDictDirect(params).endCell();
}
