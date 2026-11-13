import { spawnSync } from 'child_process';
import path from 'path';
import { Address, fromNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { Rollup } from '../wrappers/Rollup';
import { deploymentMismatches, loadRollupKey, readOnchainRollup } from '../wrappers/rollupDeployment';
import { currentSourcesSha256, loadProgramKeys } from '../wrappers/sp1Proofs';

// Сверка развёрнутого rollup-контракта: тот ли это контракт и те ли в нём ключи.
//
//   npx blueprint run verifyRollupDeployment --testnet <адрес> <chainId> <мин. срок, с> <корень генезиса> [sequencer=<адрес>] [owner=<адрес>]
//
// Скрипт ничего не отправляет (Blueprint всё равно спросит способ отправки — подойдёт любой).
//
// ЧТО ОБЯЗАН ЗАДАТЬ САМ ПРОВЕРЯЮЩИЙ, из источника, которому он доверяет, — НЕ со слов того,
// кто развернул контракт, и не из самого контракта:
//   • адрес контракта;
//   • chainId — иначе это может быть двойник другого rollup'а с тем же ключом;
//   • наименьший срок заморозки, на который он согласен (контракт допускает от часа);
//   • корень генезиса — начальное состояние L2. Генезис с заранее вписанным счётом позволил
//     бы его владельцу вывести чужие депозиты. Корень пустого реестра печатает
//     `cargo run -p rollup-native` (поле genesisStateRoot в fixtures/zkvm_batches/batches.json);
//   • по желанию — кто секвенсор и кто владелец. Без этих аргументов скрипт их только печатает.
//
// Что скрипт делает:
//   1) собирает код rollup-контракта и нуллификатора из исходников этого репозитория;
//   2) вычисляет адрес из этого кода, заданных проверяющим параметров и владельца с
//      секвенсором (заданных либо прочитанных у контракта): совпал с настоящим — значит,
//      код тот, а начальные данные канонические (пустые ключи, нулевой корень выводов,
//      пустая очередь, заявленные параметры);
//   3) сверяет хеши зафиксированных ключей с fixtures/zkvm_batches/key.json — ключом,
//      выведенным из закреплённого верификатора SP1 и ключей программ (zk/gen-rollup-key.mjs),
//      а хеш исходников программ в key.json и program.json — с деревом исходников;
//   4) печатает текущее состояние: заморожен ли, номер батча, очередь, баланс.
//
// Чего скрипт НЕ проверяет: что ключи программ в program.json действительно получаются из
// исходников zkvm/ (нужна пересборка программ — PROVING.md); покрывает ли баланс контракта
// его обязательства (балансы L2 контракту неизвестны); кто стоит за владельцем и секвенсором.
export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const positional = args.filter((arg) => !arg.includes('='));
    const named = new Map(
        args.filter((arg) => arg.includes('=')).map((arg) => arg.split('=', 2) as [string, string]),
    );
    const [addressText, chainIdText, minTimeoutText, genesisText] = positional;
    if (!addressText || !chainIdText || !minTimeoutText || !genesisText) {
        throw new Error(
            'Нужны: <адрес> <chainId> <мин. срок заморозки, с> <корень генезиса> [sequencer=<адрес>] [owner=<адрес>]. ' +
                'Все четыре значения проверяющий задаёт сам — см. комментарий в начале скрипта.',
        );
    }
    const expectedChainId = BigInt(chainIdText);
    const minTimeout = Number(minTimeoutText);
    const genesisStateRoot = BigInt(genesisText);
    if (!Number.isInteger(minTimeout) || minTimeout <= 0) throw new Error('Срок заморозки — целое число секунд');

    const rollup = provider.open(Rollup.createFromAddress(Address.parse(addressText)));
    if (!(await provider.isContractDeployed(rollup.address))) {
        throw new Error(`По адресу ${rollup.address.toString()} контракт не развёрнут`);
    }
    const onchain = await readOnchainRollup(rollup);
    const { deployment } = onchain;
    const owner = named.has('owner') ? Address.parse(named.get('owner')!) : deployment.owner;
    const sequencer = named.has('sequencer') ? Address.parse(named.get('sequencer')!) : deployment.sequencer;

    const key = loadRollupKey();
    const problems = deploymentMismatches(onchain, {
        config: {
            owner,
            sequencer,
            chainId: expectedChainId,
            // Срок входит в начальные данные, поэтому в адрес подставляется тот, что сообщает
            // контракт; приемлем ли он — проверяется ниже по заданному минимуму.
            escapeTimeout: deployment.escapeTimeout,
            nullifierCode: await compile('RollupNullifier'),
            genesisStateRoot,
        },
        code: await compile('Rollup'),
        key,
    });
    if (deployment.escapeTimeout < minTimeout) {
        problems.push(`срок заморозки ${deployment.escapeTimeout} с меньше требуемых ${minTimeout} с`);
    }
    // Ключ в key.json обязан быть выведен из нынешних исходников программ.
    const programs = loadProgramKeys();
    const sources = currentSourcesSha256();
    if (programs.sourcesSha256 !== sources) problems.push('program.json описывает не те исходники программ, что в дереве');
    if (key.file.sourcesSha256 !== sources) problems.push('key.json выведен не из тех исходников программ, что в дереве');
    if (key.file.programVKey !== programs.programVKey || key.file.exitProgramVKey !== programs.exitProgramVKey) {
        problems.push('key.json выведен не из тех ключей программ, что в program.json');
    }
    // Содержимое key.json (части ключа, хеши, IC0 выхода) пересчитывается из закреплённого
    // ключа схемы SP1 и program.json: без этого сверялись бы только поля-описания.
    const keyCheck = spawnSync('node', [path.join(__dirname, '..', 'zk', 'gen-rollup-key.mjs'), '--check'], {
        encoding: 'utf8',
    });
    if (keyCheck.status !== 0) problems.push(`key.json не сходится с пересчитанным: ${keyCheck.stderr.trim()}`);

    const [state, queue, escape, account] = [
        await rollup.getRollupState(),
        await rollup.getDepositQueue(),
        await rollup.getEscapeState(),
        await provider.getContractState(rollup.address),
    ];
    const given = (name: string) => (named.has(name) ? 'задан проверяющим' : 'НЕ СВЕРЕН: прочитан у контракта');
    ui.write(`Контракт:        ${rollup.address.toString()}`);
    ui.write(`Владелец:        ${deployment.owner.toString()} (${given('owner')})`);
    ui.write(`Секвенсор:       ${deployment.sequencer.toString()} (${given('sequencer')})`);
    ui.write(`chainId:         ${deployment.chainId} (ожидался ${expectedChainId})`);
    ui.write(`Срок заморозки:  ${deployment.escapeTimeout} с (требовалось не меньше ${minTimeout})`);
    ui.write(`Корень генезиса: ${genesisStateRoot} (задан проверяющим)`);
    ui.write(`Ключ батчей:     0x${onchain.keyHash.toString(16)}`);
    ui.write(`Ключ выхода:     0x${onchain.exitKeyHash.toString(16)}`);
    ui.write(`Исходники программ (sha256): ${sources}`);
    ui.write(
        `Состояние:       ${escape.frozen ? 'ЗАМОРОЖЕН' : 'работает'}, батчей принято ${state.batchIndex}, ` +
            `в очереди L1 ${queue.head.count - queue.processed.count} необработанных, баланс ${fromNano(account.balance)} TON`,
    );
    if (problems.length > 0) {
        throw new Error(`Развёртывание НЕ сошлось с ожидаемым:\n  - ${problems.join('\n  - ')}`);
    }
    ui.write('Сошлось: код и начальные данные — канонические для заданных параметров, ключи — выведенные из исходников.');
}
