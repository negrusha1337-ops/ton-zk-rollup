import { spawnSync } from 'child_process';
import path from 'path';
import { Address, fromNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { currentEvmSourcesSha256, loadEvmProgramKeys, loadEvmRollupKey, loadRethExpected } from '../wrappers/evmProofs';
import { PROTOCOL_VERSION } from '../wrappers/protocolVersion';
import { Rollup } from '../wrappers/Rollup';
import { deploymentMismatches, readOnchainRollup } from '../wrappers/rollupDeployment';

// Сверка развёрнутого rollup-контракта протокола v2: тот ли это контракт и тот ли в нём ключ.
//
//   npx blueprint run verifyRollupDeployment --testnet <адрес> <chainId> <мин. срок, с> <макс. возраст блока, с> [sequencer=<адрес>] [owner=<адрес>]
//
// Скрипт ничего не отправляет (Blueprint всё равно спросит способ отправки — подойдёт любой).
//
// ЧТО ОБЯЗАН ЗАДАТЬ САМ ПРОВЕРЯЮЩИЙ, из источника, которому он доверяет, — НЕ со слов того,
// кто развернул контракт, и не из самого контракта:
//   • адрес контракта;
//   • chainId — иначе это может быть двойник другого rollup'а с тем же ключом;
//   • наименьший срок заморозки, на который он согласен (контракт допускает от часа);
//   • наибольший возраст блока L2, на который он согласен (контракт допускает от получаса до
//     срока заморозки): на столько время L2 может отставать от времени L1;
//   • по желанию — кто секвенсор и кто владелец. Без этих аргументов скрипт их только печатает.
//
// Генезис задавать не нужно: хеш заголовка генезиса — константа протокола. Скрипт берёт её
// ожидаемое значение у цепочки L2 этого репозитория (fixtures/evm_batches/reth/expected.json —
// генезис, от которого узел Reth построил блоки, а программа zkVM их исполнила) и сверяет с
// константой в коде контракта (get-метод genesisHash). Контракт сам отказывается фиксировать
// ключ, если начальное слово состояния — не эта константа.
//
// Что скрипт делает:
//   1) собирает код rollup-контракта и нуллификатора из исходников этого репозитория;
//   2) вычисляет адрес из этого кода, константы генезиса, заданных проверяющим параметров и
//      владельца с секвенсором (заданных либо прочитанных у контракта): совпал с настоящим —
//      значит, код тот, а начальные данные канонические (пустой ключ, нулевые корень и счётчик
//      выводов, пустая очередь, заявленные параметры);
//   3) сверяет хеш зафиксированного ключа с fixtures/evm_batches/key.json — ключом, выведенным
//      из закреплённого верификатора SP1 и ключа программы EVM (zk/gen-evm-rollup-key.mjs),
//      а хеш исходников программы в key.json и program.json — с деревом исходников;
//   4) печатает текущее состояние: заморожен ли, номер батча, очередь, баланс.
//
// Ключа программы выхода в протоколе v2 нет: шага SetExitKey и его сверки больше нет.
//
// Чего скрипт НЕ проверяет: что ключ программы в program.json действительно получается из
// исходников zkvm-evm/ (нужна пересборка программы — PROVING.md); что в генезисе цепочки нет
// счетов с балансом (это свойство генезиса, хеш которого записан в expected.json: его
// проверяют сценарий цепочки и нативные тесты программы, не этот скрипт); покрывает ли баланс контракта его обязательства; кто стоит за владельцем и секвенсором.
export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    const positional = args.filter((arg) => !arg.includes('='));
    const named = new Map(
        args.filter((arg) => arg.includes('=')).map((arg) => arg.split('=', 2) as [string, string]),
    );
    const [addressText, chainIdText, minTimeoutText, maxAgeText] = positional;
    if (!addressText || !chainIdText || !minTimeoutText || !maxAgeText) {
        throw new Error(
            'Нужны: <адрес> <chainId> <мин. срок заморозки, с> <макс. возраст блока, с> [sequencer=<адрес>] [owner=<адрес>]. ' +
                'Все четыре значения проверяющий задаёт сам — см. комментарий в начале скрипта.',
        );
    }
    const expectedChainId = BigInt(chainIdText);
    const minTimeout = Number(minTimeoutText);
    const maxAge = Number(maxAgeText);
    if (!Number.isInteger(minTimeout) || minTimeout <= 0) throw new Error('Срок заморозки — целое число секунд');
    if (!Number.isInteger(maxAge) || maxAge <= 0) throw new Error('Возраст блока — целое число секунд');

    const rollup = provider.open(Rollup.createFromAddress(Address.parse(addressText)));
    if (!(await provider.isContractDeployed(rollup.address))) {
        throw new Error(`По адресу ${rollup.address.toString()} контракт не развёрнут`);
    }
    const onchain = await readOnchainRollup(rollup);
    const { deployment } = onchain;
    const owner = named.has('owner') ? Address.parse(named.get('owner')!) : deployment.owner;
    const sequencer = named.has('sequencer') ? Address.parse(named.get('sequencer')!) : deployment.sequencer;

    const key = loadEvmRollupKey();
    const expectedGenesis = BigInt(loadRethExpected().genesisHash);
    const problems = deploymentMismatches(onchain, {
        config: {
            owner,
            sequencer,
            chainId: expectedChainId,
            // Срок и возраст блока входят в начальные данные, поэтому в адрес подставляются те, что
            // сообщает контракт; приемлемы ли они — проверяется ниже по заданным границам.
            escapeTimeout: deployment.escapeTimeout,
            maxBlockAge: deployment.maxBlockAge,
            nullifierCode: await compile('RollupNullifier'),
            // Ожидаемый генезис — у цепочки L2, а не у контракта: иначе сверка константы кода
            // сравнивала бы значение с самим собой (REVIEW.md, 14-10).
            genesisStateRoot: expectedGenesis,
        },
        code: await compile('Rollup'),
        key,
    });
    if (deployment.escapeTimeout < minTimeout) {
        problems.push(`срок заморозки ${deployment.escapeTimeout} с меньше требуемых ${minTimeout} с`);
    }
    if (deployment.maxBlockAge > maxAge) {
        problems.push(`наибольший возраст блока ${deployment.maxBlockAge} с больше допустимых ${maxAge} с`);
    }
    // Ключ для сверки обязан быть ключом программы нынешнего протокола.
    if (key.file.protocolVersion !== PROTOCOL_VERSION) {
        problems.push(`key.json выведен для протокола v${key.file.protocolVersion}, контракт — протокола v${PROTOCOL_VERSION}`);
    }
    // Ключ в key.json обязан быть выведен из нынешних исходников программы.
    const programs = loadEvmProgramKeys();
    const sources = currentEvmSourcesSha256();
    if (programs.sourcesSha256 !== sources) problems.push('program.json описывает не те исходники программы, что в дереве');
    if (key.file.sourcesSha256 !== sources) problems.push('key.json выведен не из тех исходников программы, что в дереве');
    if (key.file.programVKey !== programs.programVKey) problems.push('key.json выведен не из того ключа программы, что в program.json');
    // Содержимое key.json (части ключа, хеши) пересчитывается из закреплённого ключа схемы SP1
    // и program.json: без этого сверялись бы только поля-описания.
    const keyCheck = spawnSync('node', [path.join(__dirname, '..', 'zk', 'gen-evm-rollup-key.mjs'), '--check'], {
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
    ui.write(`Версия протокола: ${onchain.protocolVersion}`);
    ui.write(`Владелец:        ${deployment.owner.toString()} (${given('owner')})`);
    ui.write(`Секвенсор:       ${deployment.sequencer.toString()} (${given('sequencer')})`);
    ui.write(`chainId:         ${deployment.chainId} (ожидался ${expectedChainId})`);
    ui.write(`Срок заморозки:  ${deployment.escapeTimeout} с (требовалось не меньше ${minTimeout})`);
    ui.write(`Возраст блока:   до ${deployment.maxBlockAge} с (допускалось не больше ${maxAge})`);
    ui.write(`Генезис:         0x${onchain.genesisHash.toString(16)} (константа кода; ожидался 0x${expectedGenesis.toString(16)} — генезис цепочки L2)`);
    ui.write(`Ключ батчей:     0x${onchain.keyHash.toString(16)}`);
    ui.write(`Исходники программы (sha256): ${sources}`);
    ui.write(
        `Состояние:       ${escape.frozen ? 'ЗАМОРОЖЕН' : 'работает'}, батчей принято ${state.batchIndex}, ` +
            `выводов ${state.withdrawalsCount}, в очереди L1 ${queue.head.count - queue.processed.count} необработанных, ` +
            `баланс ${fromNano(account.balance)} TON`,
    );
    if (problems.length > 0) {
        throw new Error(`Развёртывание НЕ сошлось с ожидаемым:\n  - ${problems.join('\n  - ')}`);
    }
    ui.write('Сошлось: код и начальные данные — канонические для заданных параметров, ключ — выведенный из исходников.');
}
