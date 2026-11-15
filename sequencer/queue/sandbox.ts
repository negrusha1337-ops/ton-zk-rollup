import { Address, Transaction } from '@ton/core';
import { ContractQueueSource } from './contractSource';
import { SnakeLimits } from './messages';
import { L1Message, MessageFeed, RollupQueueView } from './types';

// Очередь L1 в Sandbox: get-методы двойника контракта и перехваченные транзакции. Тест передаёт
// сюда результат каждой отправки (`record`): Sandbox не хранит историю так, как индексатор сети
// (а getTransactions песочницы разворачивает свой список на каждом вызове).

/** Транзакции контракта, перехваченные из результатов отправок, в порядке lt. */
export class SandboxFeed implements MessageFeed {
    private readonly seen = new Map<string, L1Message>();

    constructor(private readonly address: Address) {}

    /** Учесть транзакции результата отправки (`blockchain.sendMessage`, `contract.sendX`). */
    record(result: { transactions: Transaction[] }): void {
        for (const transaction of result.transactions) {
            const message = transaction.inMessage;
            if (!message || message.info.type !== 'internal' || !message.info.dest.equals(this.address)) continue;
            const description = transaction.description;
            const success =
                description.type === 'generic' &&
                !description.aborted &&
                description.computePhase.type === 'vm' &&
                description.computePhase.success;
            const hash = transaction.hash().toString('hex');
            this.seen.set(hash, {
                lt: transaction.lt,
                hash,
                success,
                body: message.info.bounced ? null : message.body,
            });
        }
    }

    async after(after: { lt: bigint; hash: string } | null, limit: number): Promise<L1Message[]> {
        const all = [...this.seen.values()].sort((a, b) => (a.lt < b.lt ? -1 : a.lt > b.lt ? 1 : 0));
        if (after && !all.some((message) => message.lt === after.lt && message.hash === after.hash)) {
            throw new Error(`в перехваченных транзакциях нет транзакции lt ${after.lt}, ${after.hash}`);
        }
        return all.filter((message) => !after || message.lt > after.lt).slice(0, limit);
    }
}

export class SandboxQueueSource extends ContractQueueSource {
    constructor(view: RollupQueueView, feed: SandboxFeed, limits: SnakeLimits) {
        super(view, feed, limits);
    }
}
