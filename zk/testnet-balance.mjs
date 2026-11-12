// Показывает баланс testnet-кошелька из .env. Запускать самому, локально:
//
//   node zk/testnet-balance.mjs
//
// Адрес выводится из мнемоники в .env; наружу (в публичный API testnet) уходит только
// адрес. Мнемоника и ключи не печатаются и никуда не отправляются.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import tonCrypto from '@ton/crypto';
import ton from '@ton/ton';

const { mnemonicToPrivateKey } = tonCrypto;
const { WalletContractV4, WalletContractV5R1 } = ton;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(ROOT, '.env');
if (!existsSync(envPath)) {
    console.error('Нет файла .env. Сначала: node zk/new-testnet-wallet.mjs');
    process.exit(1);
}
dotenv.config({ path: envPath, quiet: true });

const words = (process.env.WALLET_MNEMONIC ?? '').trim().split(/\s+/).filter(Boolean);
const version = (process.env.WALLET_VERSION ?? 'v4').toLowerCase();
if (words.length < 12) {
    console.error('В .env нет мнемоники (WALLET_MNEMONIC).');
    process.exit(1);
}
const { publicKey } = await mnemonicToPrivateKey(words);
const wallet = version.startsWith('v5')
    ? WalletContractV5R1.create({
          workchain: 0,
          publicKey,
          walletId: { networkGlobalId: Number(process.env.WALLET_NETWORK_ID ?? -3) },
      })
    : WalletContractV4.create({ workchain: 0, publicKey });

const url = `https://testnet.toncenter.com/api/v2/getAddressInformation?address=${wallet.address.toRawString()}`;
try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    const balance = Number(data.result.balance) / 1e9;
    console.log(`Кошелёк testnet (${version}): баланс ${balance.toFixed(4)} TON, состояние: ${data.result.state}.`);
    console.log(
        balance >= 1.5
            ? 'Монет достаточно. Дальше: npx blueprint run deployBn254Verifier --testnet --mnemonic'
            : 'Монет пока недостаточно: нужно около 2 TON. Запросите их у бота-крана на адрес этого кошелька.',
    );
} catch (err) {
    console.error(`Не удалось получить баланс: ${err.message}. Попробуйте ещё раз через минуту.`);
    process.exit(1);
}
