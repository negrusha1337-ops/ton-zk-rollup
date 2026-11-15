import { Address, Cell, loadMessage, Transaction } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import { AccountSnapshot, TESTNET_GLOBAL_ID, TonChain } from '../../sequencer/ton';

// Сеть TON для отправщика testnet (sequencer/ton.ts, TonChain) поверх Sandbox — для тестов
// TestnetSubmitter. Снимок счёта — со временем blockchain.now. Сбои сети задаёт тест:
//   loseAck  — сообщение доставлено, а ответ «потерян» (sendExternal бросает после доставки);
//   hold     — сообщение в пути: доставляется на releaseAfter-м следующем чтении счёта;
//   drop     — сообщение не доставлено и ответ «потерян»;
//   lag      — снимок этого счёта отдаётся прежний (отстающий сервер за балансировщиком);
//   tick     — сдвиг времени L1 при каждом чтении счёта (ожидание по состоянию, а не по таймеру);
//   lagReads — сколько чтений отдавать `lag` этого счёта (нет записи — всегда);
//   rewind   — после доставки сообщения `delivery`: первые `skip` чтений счёта `address` — настоящие
//              (подтверждение), следующие `reads` — снимок, сделанный прямо перед доставкой
//              (отстающий сервер toncenter, круг 21, пункт 1).
// Сбой применяется к сообщению, для которого `which(номер отправки)` — да.

export type ChainRewind = { address: string; delivery: number; skip: number; reads: number };

export type ChainFault = { kind: 'loseAck' | 'drop' } | { kind: 'hold'; releaseAfter: number };

export function sandboxChain(blockchain: Blockchain) {
    const results: { transactions: Transaction[] }[] = [];
    const attempts: Cell[] = [];
    const control = {
        fault: null as ChainFault | null,
        which: (_index: number) => true,
        lag: new Map<string, AccountSnapshot>(),
        lagReads: new Map<string, number>(),
        tick: 0,
        globalId: TESTNET_GLOBAL_ID,
        rewind: null as ChainRewind | null,
        /** Отдавать ли список транзакций (без него отказ контракта виден только по ожиданию). */
        listTransactions: true,
    };
    let rewound: { snapshot: AccountSnapshot; skip: number; reads: number } | null = null;
    let deliveries = 0;
    let held: { message: Cell; reads: number } | null = null;
    const deliver = async (message: Cell) => {
        deliveries++;
        const rewind = control.rewind;
        if (rewind && rewind.delivery === deliveries)
            rewound = { snapshot: await read(Address.parseRaw(rewind.address)), skip: rewind.skip, reads: rewind.reads };
        results.push(await blockchain.sendMessage(loadMessage(message.beginParse())));
    };
    const read = async (address: Address): Promise<AccountSnapshot> => {
        const contract = await blockchain.getContract(address);
        const account = contract.accountState;
        return {
            utime: blockchain.now ?? Math.floor(Date.now() / 1000),
            lt: contract.lastTransactionLt,
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
            const raw = address.toRawString();
            if (rewound && control.rewind?.address === raw) {
                if (rewound.skip > 0) rewound.skip--;
                else if (rewound.reads > 0) {
                    rewound.reads--;
                    return rewound.snapshot;
                }
            }
            const lagged = control.lag.get(raw);
            const left = control.lagReads.get(raw);
            if (lagged && left !== undefined) {
                if (left <= 0) return read(address);
                control.lagReads.set(raw, left - 1);
            }
            return lagged ?? read(address);
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
        transactions: async (address, limit) => {
            if (!control.listTransactions) return [];
            return results
                .flatMap((result) => result.transactions)
                .filter((transaction) => address.equals(new Address(0, Buffer.from(transaction.address.toString(16).padStart(64, '0'), 'hex'))))
                .reverse()
                .slice(0, limit);
        },
    };
    return { chain, control, results, attempts, snapshot: read };
}
