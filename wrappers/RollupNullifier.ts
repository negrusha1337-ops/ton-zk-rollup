import { Address, Contract, ContractProvider } from '@ton/core';

/**
 * Обёртка над contracts/rollup_nullifier.tolk — только чтение.
 *
 * Развёрнутый нуллификатор НЕ означает, что заявка погашена: развернуть его может кто
 * угодно (адрес известен, пустое сообщение он принимает), а заявка, отклонённая из-за
 * нехватки монет, тоже оставляет его развёрнутым. Погашена заявка, только если `isClaimed`.
 */
export class RollupNullifier implements Contract {
    constructor(readonly address: Address) {}

    static createFromAddress(address: Address) {
        return new RollupNullifier(address);
    }

    /** Минимум монет, с которым нуллификатор соглашается пометить заявку. */
    async getMinimumValue(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('minimumValue', []);
        return stack.readBigNumber();
    }

    async getIsClaimed(provider: ContractProvider): Promise<boolean> {
        const { stack } = await provider.get('isClaimed', []);
        return stack.readBoolean();
    }
}
