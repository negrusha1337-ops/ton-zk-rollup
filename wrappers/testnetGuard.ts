import { NetworkProvider } from '@ton/blueprint';

/**
 * Скрипты этого проекта — стенд без аудита: работать можно только в testnet.
 *
 * Одной проверки `provider.network() === 'testnet'` мало:
 *   • `--custom <адрес API> --custom-type testnet` — Blueprint называет сеть testnet при любом
 *     адресе API, в том числе mainnet;
 *   • `--testnet --tonconnect` — читает скрипт из testnet, а подписывает и рассылает
 *     подключённый кошелёк в СВОЕЙ сети: с кошельком mainnet уйдут настоящие монеты.
 * Поэтому отправляющие скрипты требуют ровно `--testnet --mnemonic`: кошелёк по мнемонике
 * шлёт через тот же клиент API, из которого скрипт читает.
 */
export function assertTestnetWithMnemonic(provider: NetworkProvider, argv: string[] = process.argv) {
    const has = (flag: string) => argv.includes(flag);
    if (provider.network() !== 'testnet' || !has('--testnet')) {
        throw new Error('Этот код — стенд без аудита. Скрипт работает только с флагом --testnet.');
    }
    if (argv.some((arg) => arg.startsWith('--custom'))) {
        throw new Error('Флаги --custom запрещены: по ним нельзя отличить testnet от mainnet.');
    }
    if (!has('--mnemonic') || has('--tonconnect') || has('--deeplink')) {
        throw new Error(
            'Скрипт отправляет сообщения только кошельком по мнемонике (--mnemonic): кошелёк TON Connect ' +
                'подписывает в своей сети и может оказаться кошельком mainnet.',
        );
    }
}
