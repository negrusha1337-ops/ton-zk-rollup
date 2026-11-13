import { readFileSync } from 'fs';
import { assertTestnetWithMnemonic } from '../wrappers/testnetGuard';
import path from 'path';
import { Address, Cell, toNano } from '@ton/core';
import { NetworkProvider, sleep } from '@ton/blueprint';
import { Bn254Groth16Verifier, Bn254Proof } from '../wrappers/Bn254Groth16Verifier';

// Отправка пруфа zkVM в развёрнутый верификатор BN254.
//
//   npx blueprint run verifyBn254Proof --testnet <адрес контракта> [имя фикстуры]
//
// Проверка стоит около 0,95 млн gas из лимита 1 млн на транзакцию. Если в сети
// другой лимит или другая версия TVM, транзакция может завершиться нехваткой газа
// (код выхода -14) — это и есть то, что нужно узнать в testnet.

const VERIFY_VALUE = toNano('0.2'); // газ проверки — около 0,063 TON по ценам mainnet
const POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 3000;

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    assertTestnetWithMnemonic(provider);
    if (!args[0])
        throw new Error('Укажи адрес контракта: npx blueprint run verifyBn254Proof --testnet <адрес> [фикстура]');
    const verifier = provider.open(Bn254Groth16Verifier.createFromAddress(Address.parse(args[0])));
    const fixtureName = args[1] ?? 'sp1_v6_fibonacci';
    const fixture = (file: string) =>
        JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', fixtureName, file), 'utf8'));

    const raw = fixture('proof.json');
    const hinted = fixture('onchain.json').hinted as { vkDataBoc: string; hintsBoc: string; inputs: string[] };
    const proof: Bn254Proof = {
        a: [BigInt(raw.pi_a[0]), BigInt(raw.pi_a[1])],
        b: [
            [BigInt(raw.pi_b[0][0]), BigInt(raw.pi_b[0][1])],
            [BigInt(raw.pi_b[1][0]), BigInt(raw.pi_b[1][1])],
        ],
        c: [BigInt(raw.pi_c[0]), BigInt(raw.pi_c[1])],
    };
    const inputs: [bigint, bigint] = [BigInt(hinted.inputs[0]), BigInt(hinted.inputs[1])];

    const expectedKeyHash = BigInt('0x' + Cell.fromBase64(hinted.vkDataBoc).hash().toString('hex'));
    if ((await verifier.getKeyHash()) !== expectedKeyHash) {
        throw new Error(
            `В контракте другой ключ (или он не зафиксирован): фикстура ${fixtureName} к нему не подходит.`,
        );
    }

    const before = await verifier.getState();
    ui.write(`Отправляю пруф (${fixtureName}); принято до этого: ${before.verifiedCount}`);
    await verifier.sendVerify(provider.sender(), {
        proof,
        inputs,
        hints: Cell.fromBase64(hinted.hintsBoc),
        value: VERIFY_VALUE,
    });

    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await sleep(POLL_DELAY_MS);
        const state = await verifier.getState();
        if (state.verifiedCount > before.verifiedCount) {
            ui.write(`Пруф принят контрактом. Всего принято: ${state.verifiedCount}.`);
            ui.write('Точный расход газа — в обозревателе, в фазе вычислений этой транзакции (gas used).');
            return;
        }
    }
    // Неудача — это ошибка, а не тихое завершение: иначе обёртка над скриптом сочтёт прогон успешным.
    throw new Error(
        'Счётчик принятых пруфов не изменился. Открой последнюю транзакцию контракта в обозревателе: ' +
            'код выхода -14 — не хватило газа (лимит или версия TVM отличаются от Sandbox); ' +
            'коды 7002–7010 и 7100 — отказ верификатора (см. contracts/bn254/hinted.tolk).',
    );
}
