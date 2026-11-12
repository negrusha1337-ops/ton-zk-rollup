// Создаёт отдельный кошелёк ТОЛЬКО для testnet и записывает его мнемонику в .env.
// Запускать самому, локально:
//
//   node zk/new-testnet-wallet.mjs
//
// Мнемоника генерируется на этом компьютере, сохраняется только в .env (он не попадает
// в git) и на экран не выводится. Печатается лишь адрес, на который нужно прислать
// тестовые монеты. Не используйте этот кошелёк в основной сети.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tonCrypto from '@ton/crypto';
import ton from '@ton/ton';

const { mnemonicNew, mnemonicToPrivateKey } = tonCrypto;
const { WalletContractV4 } = ton;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(ROOT, '.env');
const force = process.argv.includes('--force');

// Не затираем настоящую мнемонику: перезаписываем только отсутствующий файл или шаблон.
if (existsSync(envPath) && !force) {
    const isTemplate = readFileSync(envPath, 'utf8').includes('слово1 слово2');
    if (!isTemplate) {
        console.error('В .env уже что-то записано. Чтобы заменить его новым кошельком, запустите с флагом --force.');
        process.exit(1);
    }
}

const words = await mnemonicNew(24);
const { publicKey } = await mnemonicToPrivateKey(words);
const wallet = WalletContractV4.create({ workchain: 0, publicKey });

writeFileSync(
    envPath,
    [
        '# Кошелёк только для testnet, создан zk/new-testnet-wallet.mjs. В git не попадает.',
        `WALLET_MNEMONIC="${words.join(' ')}"`,
        'WALLET_VERSION=v4',
        '',
    ].join('\n'),
    { mode: 0o600 },
);

console.log('Создан кошелёк для testnet (v4R2), мнемоника записана в .env.');
console.log('Адрес для пополнения тестовыми монетами:');
console.log(`  ${wallet.address.toString({ testOnly: true, bounceable: false })}`);
console.log('Нужно около 2 тестовых TON. После пополнения:');
console.log('  npx blueprint run deployBn254Verifier --testnet --mnemonic');
