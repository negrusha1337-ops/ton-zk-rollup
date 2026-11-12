// Подсказывает, какие строки нужны в .env, чтобы Blueprint открыл именно тот кошелёк,
// на который пришли тестовые монеты. Запускать самому, локально:
//
//   node zk/which-wallet.mjs <адрес, отправленный боту-крану>
//
// Скрипт читает мнемонику из .env, выводит из неё адреса для трёх вариантов кошелька и
// сравнивает с указанным. Мнемонику и ключи он НЕ печатает и никуда не отправляет.
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import tonCore from '@ton/core';
import tonCrypto from '@ton/crypto';
import ton from '@ton/ton';

const { Address } = tonCore;
const { keyPairFromSeed, mnemonicNew, mnemonicToPrivateKey, mnemonicValidate } = tonCrypto;
const { WalletContractV4, WalletContractV5R1 } = ton;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfTest = process.argv.includes('--self-test');
const targetArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

let words;
if (selfTest) {
    // Проверка самого скрипта на одноразовой мнемонике, которая никуда не сохраняется.
    words = await mnemonicNew();
} else {
    const envPath = path.join(ROOT, '.env');
    if (!existsSync(envPath)) {
        console.error('Нет файла .env. Скопируйте .env.example в .env и впишите мнемонику testnet-кошелька.');
        process.exit(1);
    }
    dotenv.config({ path: envPath, quiet: true });
    words = (process.env.WALLET_MNEMONIC ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length !== 12 && words.length !== 24) {
        console.error(`В WALLET_MNEMONIC ${words.length} слов; ожидается 12 или 24 через пробел.`);
        process.exit(1);
    }
}

// Фраза из 12 слов бывает двух видов: «родная» схема TON (её понимает Blueprint) и
// BIP39 с путём m/44'/607'/0' (мультивалютные кошельки). Проверяем обе.
const tonNative = (await mnemonicValidate(words)) ? await mnemonicToPrivateKey(words) : null;
const bip39Key = (() => {
    const seed = pbkdf2Sync(words.join(' ').normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512');
    let node = createHmac('sha512', 'ed25519 seed').update(seed).digest();
    for (const index of [44, 607, 0]) {
        const data = Buffer.concat([
            Buffer.from([0]),
            node.subarray(0, 32),
            Buffer.from([0x80 | (index >>> 24), (index >>> 16) & 0xff, (index >>> 8) & 0xff, index & 0xff]),
        ]);
        node = createHmac('sha512', node.subarray(32)).update(data).digest();
    }
    return keyPairFromSeed(node.subarray(0, 32));
})();
const schemes = [
    ...(tonNative ? [{ scheme: 'схема TON (понимает Blueprint)', usable: true, publicKey: tonNative.publicKey }] : []),
    { scheme: "BIP39, путь m/44'/607'/0'", usable: false, publicKey: bip39Key.publicKey },
];

const variants = schemes.flatMap(({ scheme, usable, publicKey }) => [
    {
        label: `v4R2, ${scheme}`,
        usable,
        env: ['WALLET_VERSION=v4'],
        wallet: WalletContractV4.create({ workchain: 0, publicKey }),
    },
    {
        label: `W5 (v5r1), адрес тестовой сети, ${scheme}`,
        usable,
        env: ['WALLET_VERSION=v5r1'],
        wallet: WalletContractV5R1.create({ workchain: 0, publicKey, walletId: { networkGlobalId: -3 } }),
    },
    {
        label: `W5 (v5r1), адрес основной сети, ${scheme}`,
        usable,
        env: ['WALLET_VERSION=v5r1', 'WALLET_NETWORK_ID=-239'],
        wallet: WalletContractV5R1.create({ workchain: 0, publicKey, walletId: { networkGlobalId: -239 } }),
    },
]);

const show = (address) => address.toString({ testOnly: true, bounceable: false });
let target = null;
if (targetArg) {
    try {
        target = Address.parse(targetArg);
    } catch {
        console.error(`Не удалось разобрать адрес: ${targetArg}`);
        process.exit(1);
    }
}

console.log('Адреса, которые получаются из мнемоники в .env:');
for (const variant of variants) {
    const mark = target && variant.wallet.address.equals(target) ? '  <-- совпал' : '';
    console.log(`  ${variant.label}: ${show(variant.wallet.address)}${mark}`);
}

if (!target) {
    console.log(
        '\nУкажите адрес, отправленный крану, чтобы скрипт подобрал настройки: node zk/which-wallet.mjs <адрес>',
    );
} else {
    const match = variants.find((variant) => variant.wallet.address.equals(target));
    if (match && match.usable) {
        console.log(`\nСовпал вариант «${match.label}». В .env рядом с мнемоникой должны быть строки:`);
        for (const line of match.env) console.log(`  ${line}`);
        if (match.env.length === 1) console.log('Строки WALLET_NETWORK_ID быть не должно.');
    } else if (match) {
        console.log(`\nСовпал вариант «${match.label}».`);
        console.log('Это фраза формата BIP39: режим --mnemonic в Blueprint такие кошельки не открывает.');
        console.log('Проще всего завести отдельный testnet-кошелёк: node zk/new-testnet-wallet.mjs --force');
        console.log('и перевести на его адрес тестовые монеты (или запросить их у крана заново).');
    } else {
        console.log('\nНи один вариант не совпал с этим адресом. Значит, в .env мнемоника другого кошелька');
        console.log('или кошелёк другой версии. Монеты на указанном адресе этим ключом потратить нельзя.');
    }
}
