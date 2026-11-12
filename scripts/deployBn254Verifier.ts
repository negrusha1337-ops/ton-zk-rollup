import { readFileSync } from 'fs';
import path from 'path';
import { Cell, toNano } from '@ton/core';
import { compile, NetworkProvider, sleep } from '@ton/blueprint';
import { Bn254Groth16Verifier, KeyUploadJson, keyUploadFromJson } from '../wrappers/Bn254Groth16Verifier';

// Развёртывание верификатора BN254 и загрузка ключа частями.
//
//   npx blueprint run deployBn254Verifier --testnet [имя фикстуры]
//
// Имя фикстуры — каталог в fixtures/ (по умолчанию sp1_v6_fibonacci). Скрипт можно
// запускать повторно: уже загруженные части пропускаются.
// ТОЛЬКО testnet: код не проходил аудит.

// Суммы подобраны так, чтобы весь прогон уложился в 2 тестовых TON с одного запроса к крану.
const DEPLOY_VALUE = toNano('0.2'); // остаётся на контракте и оплачивает хранение ключа
const PART_VALUE = toNano('0.03');
const POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 3000;

async function waitFor(description: string, check: () => Promise<boolean>) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        if (await check()) return;
        await sleep(POLL_DELAY_MS);
    }
    throw new Error(
        `Не дождался: ${description}. Проверь транзакции контракта в обозревателе и запусти скрипт ещё раз.`,
    );
}

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    if (provider.network() === 'mainnet') {
        throw new Error('Этот контракт — стенд без аудита. Развёртывание в mainnet запрещено скриптом.');
    }
    const owner = provider.sender().address;
    if (!owner) throw new Error('У отправителя нет адреса: подключи кошелёк.');

    const fixtureName = args[0] ?? 'sp1_v6_fibonacci';
    const fixturePath = path.join(__dirname, '..', 'fixtures', fixtureName, 'onchain.json');
    const hinted = JSON.parse(readFileSync(fixturePath, 'utf8')).hinted as {
        vkDataBoc: string;
        keyUpload: KeyUploadJson;
    };
    const key = keyUploadFromJson(hinted.keyUpload);
    const expectedKeyHash = BigInt('0x' + Cell.fromBase64(hinted.vkDataBoc).hash().toString('hex'));

    const code = await compile('Bn254Groth16Verifier');
    const verifier = provider.open(Bn254Groth16Verifier.createFromConfig({ owner }, code));
    ui.write(`Верификатор: ${verifier.address.toString()} (ключ: ${fixtureName})`);

    if (!(await provider.isContractDeployed(verifier.address))) {
        await verifier.sendDeploy(provider.sender(), DEPLOY_VALUE);
        await provider.waitForDeploy(verifier.address);
    }

    if ((await verifier.getKeyHash()) === 0n) {
        const parts = Bn254Groth16Verifier.keyParts(key);
        for (const [index, { slot, part }] of parts.entries()) {
            if (await verifier.getHasKeyPart(slot)) continue;
            ui.write(`Часть ключа ${index + 1} из ${parts.length} (номер ${slot})`);
            await verifier.sendUploadKeyPart(provider.sender(), { slot, part, value: PART_VALUE });
            await waitFor(`часть ${slot} в контракте`, () => verifier.getHasKeyPart(slot));
        }
        ui.write('Фиксация ключа');
        await verifier.sendFinalizeKey(provider.sender(), { key, value: PART_VALUE });
        await waitFor('ключ зафиксирован', async () => (await verifier.getKeyHash()) !== 0n);
    }

    const keyHash = await verifier.getKeyHash();
    if (keyHash !== expectedKeyHash) {
        throw new Error('Хеш ключа в контракте не совпал с ожидаемым: подсказки из фикстуры к нему не подойдут.');
    }
    ui.write(`Готово. Ключ зафиксирован, хеш совпал. Дальше:`);
    ui.write(`  npx blueprint run verifyBn254Proof --testnet ${verifier.address.toString()} ${fixtureName}`);
}
