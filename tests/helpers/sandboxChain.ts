import { Address, Cell, loadMessage, Transaction } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import { AccountSnapshot, TESTNET_GLOBAL_ID, TonChain } from '../../sequencer/ton';

// Сеть TON для отправщика testnet (sequencer/ton.ts, TonChain) поверх Sandbox — для тестов
// TestnetSubmitter. Снимок счёта — со временем blockchain.now. Сбои сети задаёт тест:
//   loseAck  — сообщение доставлено, а ответ «потерян» (sendExternal бросает после доставки);
//   hold     — сообщение в пути: доставляется на releaseAfter-м следующем чтении счёта;
//   drop     — сообщение не доставлено и ответ «потерян»;
//   lag      — снимок этого счёта отдаётся прежний (отстающий сервер за балансировщиком);
//   tick     — сдвиг времени L1 при каждом чтении счёта (ожидание по состоянию, а не по таймеру).
// Сбой применяется к сообщению, для которого `which(номер отправки)` — да.

export type ChainFault = { kind: 'loseAck' | 'drop' } | { kind: 'hold'; releaseAfter: number };

export function sandboxChain(blockchain: Blockchain) {
    const results: { transactions: Transaction[] }[] = [];
    const attempts: Cell[] = [];
    const control = {
        fault: null as ChainFault | null,
        which: (_index: number) => true,
        lag: new Map<string, AccountSnapshot>(),
        tick: 0,
        globalId: TESTNET_GLOBAL_ID,
    };
    let held: { message: Cell; reads: number } | null = null;
    const deliver = async (message: Cell) => {
        results.push(await blockchain.sendMessage(loadMessage(message.beginParse())));
    };
    const read = async (address: Address): Promise<AccountSnapshot> => {
        const contract = await blockchain.getContract(address);
        const account = contract.accountState;
        return {
            utime: blockchain.now ?? Math.floor(Date.now() / 1000),
            balance: contract.balance,
            state: account?.type === 'active' ? 'active' : account?.type === 'frozen' ? 'frozen' : 'uninit',
            code: account?.type === 'active' ? (account.state.code ?? null) : null,
            data: account?.type === 'active' ? (account.state.data ?? null) : null,
        };
    };
    const chain: TonChain = {
        account: async (address) => {
            if (control.tick) blockchain.now = (blockchain.now ?? 0) + control.tick;
            if (held && --held.reads <= 0) {
                const { message } = held;
                held = null;
                await deliver(message);
            }
            return control.lag.get(address.toRawString()) ?? read(address);
        },
        sendExternal: async (message) => {
            attempts.push(message);
            const fault = control.which(attempts.length) ? control.fault : null;
            if (fault?.kind === 'hold') {
                held = { message, reads: fault.releaseAfter };
                return;
            }
            if (fault?.kind === 'drop') throw new Error('сеть не ответила (сообщение не дошло)');
            await deliver(message);
            if (fault?.kind === 'loseAck') throw new Error('сеть не ответила (сообщение дошло)');
        },
        globalId: async () => control.globalId,
    };
    return { chain, control, results, attempts, snapshot: read };
}
