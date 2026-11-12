import { Blockchain } from '@ton/sandbox';
import { beginCell, contractAddress, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';

const NOT_IMPLEMENTED = 1000;
const OP_DEPOSIT_TON = 0x52420002;

// Скелет нужен только для того, чтобы компилятор Tolk проверял схему
// сообщений и хранилища из ARCHITECTURE.md. Логики в нём нет.
describe('RollupSkeleton: черновик интерфейса', () => {
    it('компилируется и отвечает NotImplemented на сообщение из схемы', async () => {
        const code = await compile('RollupSkeleton');
        const blockchain = await Blockchain.create();
        const user = await blockchain.treasury('user');
        const init = { code, data: beginCell().endCell() };
        const rollup = contractAddress(0, init);

        const result = await user.send({
            to: rollup,
            init,
            value: toNano('1'),
            body: beginCell().storeUint(OP_DEPOSIT_TON, 32).storeUint(1, 64).storeUint(0xabcdef, 160).endCell(),
        });

        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: rollup,
            success: false,
            exitCode: NOT_IMPLEMENTED,
        });
        // Необработанный депозит возвращается отправителю bounce-сообщением.
        expect(result.transactions).toHaveTransaction({ from: rollup, to: user.address, inMessageBounced: true });
    });
});
