import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, toNano } from '@ton/core';
import { KeySlots } from '../../wrappers/Bn254Groth16Verifier';
import { Rollup } from '../../wrappers/Rollup';

/**
 * Фиксирует в контракте ключи-пустышки. Нужно тестам логики на двойнике: настоящий ключ
 * им ни к чему (пруф заменён заглушкой), но без зафиксированных ключей контракт не
 * принимает ни депозиты, ни принудительные транзакции.
 */
export async function finalizeDummyKeys(rollup: SandboxContract<Rollup>, owner: SandboxContract<TreasuryContract>) {
    const part = beginCell().endCell();
    const value = toNano('0.05');
    const sender = owner.getSender();
    await rollup.sendUploadKeyPart(sender, { slot: KeySlots.fixedLines, part, value });
    await rollup.sendUploadKeyPart(sender, { slot: KeySlots.table0, part, value });
    await rollup.sendSetExitKey(sender, { ic0: [1n, 2n], value });
    await rollup.sendFinalizeKey(sender, {
        key: { ic0: [1n, 2n], alphaBeta: part, fixedLines: part, table0Parts: [part], table1Parts: [] },
        value,
    });
    if ((await rollup.getKeyHash()) === 0n) throw new Error('finalizeDummyKeys: ключ не зафиксировался');
}
