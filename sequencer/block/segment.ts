import { QueuedItem } from '../queue/types';

// Выбор отрезка очереди для блока и зачисления депозитов — чистые функции.
//
// Правила программы (zkvm-evm/lib/src/lib.rs, check_queue): блок обрабатывает элементы
// (processed, N] по порядку, N − processed ≤ MAX_BATCH_QUEUE_ITEMS (контракт: get-метод
// queueLimits), N ≤ головы очереди; зачисление i — ровно i-й депозит отрезка: номер — его место
// среди зачислений блока С НУЛЯ, номер валидатора — ноль, сумма в нанотонах = gwei и меньше 2⁶⁴.
// Reth примет любые номера, программа — только такие (REVIEW.md, круг 11).

/** Зачисление EIP-4895 в том виде, в каком его ждут testing_buildBlockV1 и Engine API. */
export type Credit = { index: string; validatorIndex: string; address: string; amount: string };

const U64 = 1n << 64n;
const quantity = (value: bigint | number) => '0x' + BigInt(value).toString(16);

/** Зачисления блока из отрезка: депозиты по порядку, номер — место в блоке с нуля. */
export function creditsOf(segment: QueuedItem[]): Credit[] {
    const deposits = segment.flatMap(({ item }) => (item.kind === 'deposit' ? [item] : []));
    return deposits.map((deposit, index) => {
        if (deposit.amount <= 0n || deposit.amount >= U64) {
            throw new Error(
                `депозит №${deposit.number}: сумма ${deposit.amount} не помещается в зачисление (u64 gwei)`,
            );
        }
        return {
            index: quantity(index),
            validatorIndex: '0x0',
            address: deposit.l2Recipient.toLowerCase(),
            amount: quantity(deposit.amount),
        };
    });
}

export type SegmentChoice = {
    /** Элементы отрезка — префикс окна. */
    items: QueuedItem[];
    /** Почему отрезок короче, чем позволяли предел и голова очереди (для журнала). */
    cut: string | null;
};

/**
 * Отрезок блока — префикс окна не длиннее `max`. Если в отрезке есть принудительная транзакция
 * от счёта, которому раньше в этом же отрезке зачисляется депозит, отрезок кончается перед ней
 * (PROTOCOL-V2.md, правка 0.4): зачисления применяются в конце блока, и в этом блоке её
 * пришлось бы пропустить навсегда, а в следующем она пройдёт. `signers` — отправитель годной по
 * форме принудительной транзакции по номеру элемента (ответ программы о форме).
 */
export function chooseSegment(window: QueuedItem[], max: number, signers: Map<number, string>): SegmentChoice {
    if (!Number.isInteger(max) || max < 0) throw new Error(`предел отрезка ${max} — не неотрицательное целое`);
    for (let index = 1; index < window.length; index++) {
        if (window[index - 1].item.number + 1 !== window[index].item.number)
            throw new Error('окно очереди не по порядку номеров');
    }
    const items = window.slice(0, max);
    const credited = new Set<string>();
    for (let index = 0; index < items.length; index++) {
        const { item } = items[index];
        if (item.kind === 'deposit') {
            credited.add(item.l2Recipient.toLowerCase());
            continue;
        }
        const signer = signers.get(item.number)?.toLowerCase();
        if (signer && credited.has(signer)) {
            return {
                items: items.slice(0, index),
                cut: `элемент №${item.number}: отправителю зачисляется депозит в этом же отрезке`,
            };
        }
    }
    return { items, cut: window.length > max ? `предел ${max} элементов на батч` : null };
}
