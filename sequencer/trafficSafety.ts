import { Address } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { RUNS_WALLET_ENV, SERVICE_WALLET_ENV } from './serviceEnv';
import { SequencerWallet } from './ton';

// Защиты и устойчивость скрипта нагрузки (scripts/sequencerTraffic.ts), круг 23, пункты 1 и 3.
// Отдельный файл: Blueprint считает скриптом каждый файл в scripts/, а эти функции проверяются
// тестами по отдельности.

/** Отказ по защите (чужой кошелёк, бюджет, конфигурация): повтор не поможет — выход сразу. */
export class TrafficRefused extends Error {}

const words = (mnemonic: string) => mnemonic.trim().split(/\s+/).filter(Boolean);

/**
 * Кошелёк нагрузки — не кошелёк сервиса: ни секвенсор контракта (get-метод deployment), ни
 * адрес из SEQUENCER_MNEMONIC (Blueprint загружает весь `.env` проекта в окружение), ни тот же
 * ключ в WALLET_MNEMONIC и SEQUENCER_MNEMONIC. Пара SEQUENCER_* после сверки удаляется из `env`.
 */
export async function assertNotServiceWallet(wallet: Address, sequencer: Address, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    try {
        if (sequencer.equals(wallet))
            throw new TrafficRefused('кошелёк нагрузки — секвенсор контракта (кошелёк сервиса): нужен отдельный (общий seqno — гонка отправок)');
        const mnemonic = env.SEQUENCER_MNEMONIC;
        if (mnemonic === undefined || mnemonic.trim() === '') return;
        let service: SequencerWallet;
        try {
            service = await SequencerWallet.fromEnv(Object.fromEntries(SERVICE_WALLET_ENV.map((name) => [name, env[name]])));
        } catch (error) {
            throw new TrafficRefused(`кошелёк сервиса из SEQUENCER_MNEMONIC не разобрать, сверить с ним кошелёк нагрузки нечем: ${(error as Error).message}`);
        }
        if (service.address.equals(wallet))
            throw new TrafficRefused('кошелёк нагрузки — кошелёк сервиса (адрес из SEQUENCER_MNEMONIC): нужен отдельный (общий seqno — гонка отправок)');
        const runs = env[RUNS_WALLET_ENV[0]];
        if (runs !== undefined && runs.trim() !== '') {
            const [mine, theirs] = [await mnemonicToPrivateKey(words(runs)), await mnemonicToPrivateKey(words(mnemonic))];
            if (mine.publicKey.equals(theirs.publicKey))
                throw new TrafficRefused('в WALLET_MNEMONIC и SEQUENCER_MNEMONIC один ключ: кошелёк нагрузки и кошелёк сервиса — один владелец, нужна своя мнемоника');
        }
    } finally {
        for (const name of SERVICE_WALLET_ENV) delete env[name];
    }
}

/**
 * Ключ API toncenter — провайдеру Blueprint. С `--testnet` Blueprint создаёт TonClient без ключа и
 * не даёт его задать (`--custom-key` — только с `--custom`, а `--custom` запрещён testnetGuard.ts).
 * Ключ клиент читает при каждом запросе (HttpApi.parameters.apiKey), поэтому его можно вписать в
 * уже созданный клиент: через него же шлёт и кошелёк по мнемонике. Ответ — что вышло.
 */
export function passToncenterKey(provider: { api?: () => unknown }, key: string | undefined): 'passed' | 'absent' | 'unsupported' {
    if (key === undefined || key === '') return 'absent';
    const client = typeof provider.api === 'function' ? (provider.api() as { api?: { parameters?: Record<string, unknown> } }) : undefined;
    const parameters = client?.api?.parameters;
    if (!parameters || typeof parameters !== 'object' || !('apiKey' in parameters)) return 'unsupported';
    parameters.apiKey = key;
    return 'passed';
}

/**
 * Шаг с повтором после сбоя (сеть, toncenter, «не дождался»): строка журнала, пауза, снова; подряд
 * `maxFailures` — выход с понятным текстом. Отказ по защите (TrafficRefused) — выход сразу.
 */
export async function withRetries<T>(
    what: string,
    step: () => Promise<T>,
    options: { maxFailures: number; pauseSeconds: number; sleep: (ms: number) => Promise<void>; log: (line: string) => void },
): Promise<T> {
    for (let failures = 0; ; ) {
        try {
            return await step();
        } catch (error) {
            if (error instanceof TrafficRefused) throw error;
            failures++;
            const reason = error instanceof Error ? error.message : String(error);
            options.log(`Сбой шага «${what}» (${failures} подряд из ${options.maxFailures}): ${reason}`);
            if (failures >= options.maxFailures)
                throw new TrafficRefused(
                    `нагрузка остановлена: ${failures} сбоев подряд на шаге «${what}», последний — ${reason}. ` +
                        'Журнал сохранён: запуск снова продолжит с него (сначала проверьте toncenter и кошелёк)',
                );
            await options.sleep(options.pauseSeconds * 1000);
        }
    }
}
