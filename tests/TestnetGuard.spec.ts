import { NetworkProvider } from '@ton/blueprint';
import { assertTestnetWithMnemonic } from '../wrappers/testnetGuard';

// Защита скриптов от запуска вне testnet (находка третьего круга проверки, REVIEW.md).
// Прежняя проверка `network() === 'testnet'` обходилась: `--custom <mainnet> --custom-type testnet`
// называет сетью testnet любой адрес API, а при `--testnet --tonconnect` подписывает и
// рассылает кошелёк в своей сети.
describe('Скрипты работают только в testnet и только кошельком по мнемонике', () => {
    const provider = (network: string) => ({ network: () => network }) as unknown as NetworkProvider;
    const argv = (...flags: string[]) => ['node', 'blueprint', 'run', 'runRollupTestnet', ...flags];

    it('обычный запуск в testnet по мнемонике разрешён', () => {
        expect(() => assertTestnetWithMnemonic(provider('testnet'), argv('--testnet', '--mnemonic'))).not.toThrow();
        expect(() =>
            assertTestnetWithMnemonic(provider('testnet'), argv('--testnet', '--mnemonic', 'escape')),
        ).not.toThrow();
    });

    it('mainnet и сеть без явного --testnet запрещены', () => {
        expect(() => assertTestnetWithMnemonic(provider('mainnet'), argv('--mainnet', '--mnemonic'))).toThrow();
        expect(() => assertTestnetWithMnemonic(provider('mainnet'), argv('--testnet', '--mnemonic'))).toThrow();
        expect(() => assertTestnetWithMnemonic(provider('testnet'), argv('--mnemonic'))).toThrow();
    });

    it('custom-сеть, выдающая себя за testnet, запрещена', () => {
        const flags = ['--custom', 'https://toncenter.com/api/v2/jsonRPC', '--custom-type', 'testnet', '--mnemonic'];
        // Без --testnet отказ наступает раньше; с ним — именно из-за --custom.
        expect(() => assertTestnetWithMnemonic(provider('testnet'), argv(...flags))).toThrow();
        expect(() => assertTestnetWithMnemonic(provider('testnet'), argv('--testnet', ...flags))).toThrow(/custom/);
    });

    it('TON Connect, deeplink и выбор кошелька в диалоге запрещены', () => {
        expect(() => assertTestnetWithMnemonic(provider('testnet'), argv('--testnet', '--tonconnect'))).toThrow();
        expect(() => assertTestnetWithMnemonic(provider('testnet'), argv('--testnet', '--deeplink'))).toThrow();
        expect(() => assertTestnetWithMnemonic(provider('testnet'), argv('--testnet'))).toThrow(/mnemonic/);
        expect(() =>
            assertTestnetWithMnemonic(provider('testnet'), argv('--testnet', '--mnemonic', '--tonconnect')),
        ).toThrow();
    });
});
