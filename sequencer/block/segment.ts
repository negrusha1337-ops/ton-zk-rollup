import { QueuedItem, QueueMark, QueueWindow } from '../queue/types';
import { serialize } from '../state';

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
    /** Отрезок обрезан перед принудительной от счёта с депозитом (следующий так не режется). */
    depositCut: boolean;
};

export type SegmentPolicy = {
    /** Сколько элементов очереди ждёт после отметки (голова − отметка), не только в окне. */
    pending: number;
    /** Отрезок предыдущего блока уже был обрезан этим правилом. */
    previousCut: boolean;
};

/**
 * Отрезок блока — префикс окна не длиннее `max`.
 *
 * Принудительная транзакция от счёта, которому раньше в этом же отрезке зачисляется депозит,
 * программой ПРОПУСКАЕТСЯ: зачисления применяются в конце блока (PROTOCOL-V2.md, правка 0.4). Это
 * законный исход, а не ошибка батча. Правка 0.4 советует честному сборщику резать отрезок перед
 * такой транзакцией, чтобы она прошла следующим блоком; но безусловная обрезка — рычаг на
 * пропускную способность: очередь D(X) F(X) D(X) F(X)… давала бы по два элемента на блок вместо
 * предела, и заморозка по сроку покупалась бы за единицы TON (круг 18, H2). Поэтому отрезок
 * режется, только если это ничего не стоит пропускной способности:
 *   - очередь не длиннее предела (`pending ≤ max`): следующий блок заберёт остаток целиком;
 *   - отрезок предыдущего блока этим правилом не резался: два блока подряд не режутся, и каждый
 *     второй блок берёт полный отрезок.
 * Иначе отрезок полный, а такая транзакция пропускается программой. `signers` — отправитель
 * годной по форме принудительной транзакции по номеру элемента (ответ программы о форме).
 */
export function chooseSegment(
    window: QueuedItem[],
    max: number,
    signers: Map<number, string>,
    policy: SegmentPolicy,
): SegmentChoice {
    if (!Number.isInteger(max) || max < 0) throw new Error(`предел отрезка ${max} — не неотрицательное целое`);
    for (let index = 1; index < window.length; index++) {
        if (window[index - 1].item.number + 1 !== window[index].item.number)
            throw new Error('окно очереди не по порядку номеров');
    }
    const items = window.slice(0, max);
    const full: SegmentChoice = {
        items,
        cut: window.length > max || policy.pending > max ? `предел ${max} элементов на батч` : null,
        depositCut: false,
    };
    if (policy.pending > max || policy.previousCut) return full;
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
                depositCut: true,
            };
        }
    }
    return full;
}

/**
 * Отрезок пересобираемого блока (0.3) — прежний; он годен и теперь, если контракт обработал очередь
 * ровно до отметки родителя (батч прежнего блока не принят, другой — тоже) и элементы окна — те же
 * (они неизменны: хеш цепочки). Предел и голова от этого не нарушаются. null — годен, иначе — что не так.
 */
export function rebuildSegmentProblem(window: QueueWindow, parent: QueueMark, segment: QueuedItem[]): string | null {
    if (window.processed.count !== parent.count || window.processed.hash !== parent.hash)
        return `контракт обработал очередь до ${window.processed.count}, а родитель блока — до ${parent.count}`;
    const same =
        window.items.length === segment.length &&
        window.items.every(({ item }, index) => serialize(item) === serialize(segment[index].item));
    return same ? null : 'элементы очереди у контракта не те, что в прежнем отрезке';
}
