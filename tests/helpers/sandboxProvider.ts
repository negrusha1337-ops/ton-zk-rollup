import { NetworkProvider } from '@ton/blueprint';
import { Address, Cell, Contract, Sender, SenderArguments } from '@ton/core';
import { Blockchain, internal } from '@ton/sandbox';

/**
 * NetworkProvider для скриптов прогона поверх Sandbox — ровно в том объёме, которым пользуется
 * scripts/runRethCycleTestnet.ts: сеть «testnet», отправитель с заданным адресом (кошелёк прогона),
 * чтение состояния счёта и открытие контрактов. Кошелька как контракта здесь нет: отправитель
 * Sandbox шлёт сообщения от имени адреса, не списывая с него ни суммы, ни комиссий — баланс
 * адреса только растёт на выплаты.
 *
 * `failAt` — номер отправки (с единицы), на которой «сеть» отказывает: сообщение не уходит.
 * `beforeSend` вызывается перед каждой отправкой с её номером: тест двигает в нём часы.
 */
export function sandboxProvider(
    blockchain: Blockchain,
    wallet: Address,
    options: { failAt?: number; beforeSend?: (index: number) => void } = {},
) {
    const lines: string[] = [];
    const sent: SenderArguments[] = [];
    const sender: Sender = {
        address: wallet,
        send: async (args) => {
            if (options.failAt !== undefined && sent.length + 1 >= options.failAt) throw new Error('сеть недоступна (сбой, заданный тестом)');
            options.beforeSend?.(sent.length + 1);
            sent.push(args);
            // Штатный отправитель Sandbox (blockchain.sender) не передаёт init: сообщение
            // развёртывания собирается здесь.
            await blockchain.sendMessage(
                internal({ from: wallet, to: args.to, value: args.value, bounce: args.bounce ?? true, stateInit: args.init ?? undefined, body: args.body ?? new Cell() }),
            );
        },
    };
    const provider = {
        network: () => 'testnet',
        sender: () => sender,
        ui: () => ({ write: (line: string) => void lines.push(line) }),
        open: <T extends Contract>(contract: T) => blockchain.openContract(contract),
        isContractDeployed: async (address: Address) => (await blockchain.getContract(address)).accountState?.type === 'active',
        waitForDeploy: async () => undefined,
        getContractState: async (address: Address) => {
            const contract = await blockchain.getContract(address);
            const account = contract.accountState;
            return {
                balance: contract.balance,
                state:
                    account?.type === 'active'
                        ? { type: 'active', code: account.state.code?.toBoc() ?? null, data: account.state.data?.toBoc() ?? null }
                        : { type: 'uninit' },
            };
        },
    };
    return { provider: provider as unknown as NetworkProvider, lines, sent };
}
