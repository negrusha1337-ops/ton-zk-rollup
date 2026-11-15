// Срок приёма батча (PROTOCOL-V2.md, 0.3): контракт берёт батч, пока
// `время блока ≤ время L1 ≤ время блока + maxBlockAge`. Решение «пруф / отправка / ждать /
// пересобрать» — чистая функция: на ней держатся тесты границ (круг 20, пункты 1, 3, 7).
//
// Два времени L1:
//   seen  — время блока, на котором прочитано «батч не принят» (снимок состояния контракта);
//   fresh — самое свежее известное время L1: max(l1Now, seen).
// Батч, который уже мог уйти контракту (`submitting`), пересобирается только по `seen`: если
// снимок отстаёт (балансировщик toncenter: свежий сервер дал время, отстающий — состояние), батч
// мог быть принят после снимка — пересборка разошлась бы с контрактом. И не сразу по истечении
// срока, а с запасом `rebuildMargin`: сообщение в пути может попасть в блок ровно на границе.
// Батч, который никуда не уходил, пересобирается заранее, по `fresh`: дубля тут быть не может.

/** Запас после конца срока перед пересборкой батча, который мог уйти, с. */
export const DEFAULT_REBUILD_MARGIN = 60;
/** Ожидаемое время проверки кандидата (rsp, хост, сверки), с. */
export const DEFAULT_EXPECTED_CHECK_TIME = 300;

export type Deadline = {
    timestamp: number;
    maxBlockAge: number;
    /** Время L1 снимка «не принят». */
    seen: number;
    /** Самое свежее время L1. */
    fresh: number;
    submitMargin: number;
    rebuildMargin: number;
};

export type DeadlineDecision = { action: 'go' } | { action: 'wait'; reason: string } | { action: 'rebuild'; reason: string };

const deadlineOf = (input: Deadline) => input.timestamp + input.maxBlockAge;

/** До пруфа: батч ещё никуда не уходил — не успеть с пруфом и запасом, значит пересобрать сразу. */
export function beforeProof(input: Deadline & { proofTime: number }): DeadlineDecision {
    const deadline = deadlineOf(input);
    if (deadline < input.fresh + input.proofTime + input.submitMargin)
        return {
            action: 'rebuild',
            reason:
                `батч не успеть принять до пруфа: время блока ${input.timestamp} + maxBlockAge ${input.maxBlockAge} = ${deadline}, ` +
                `а время L1 ${input.fresh} + время пруфа ${input.proofTime} + запас ${input.submitMargin} = ${input.fresh + input.proofTime + input.submitMargin}`,
        };
    return { action: 'go' };
}

/** Перед отправкой (пруф есть). `submitting` — батч мог уйти контракту в прежней попытке. */
export function beforeSubmit(input: Deadline & { submitting: boolean }): DeadlineDecision {
    const deadline = deadlineOf(input);
    // Блок из будущего L1 (7329): контракт возьмёт его, когда L1 догонит.
    if (input.timestamp > input.fresh)
        return { action: 'wait', reason: `время блока ${input.timestamp} позже времени L1 ${input.fresh}: ждём L1` };
    if (deadline >= input.fresh + input.submitMargin) return { action: 'go' };
    if (!input.submitting)
        return {
            action: 'rebuild',
            reason:
                `батч не успеть принять до отправки: время блока ${input.timestamp} + maxBlockAge ${input.maxBlockAge} = ${deadline}, ` +
                `а время L1 ${input.fresh} + запас ${input.submitMargin} = ${input.fresh + input.submitMargin}`,
        };
    if (deadline + input.rebuildMargin < input.seen)
        return {
            action: 'rebuild',
            reason:
                `срок приёма батча ${deadline} истёк: по снимку контракта на время L1 ${input.seen} (позже срока на запас ${input.rebuildMargin} с) батч не принят`,
        };
    return {
        action: 'wait',
        reason:
            `батч мог уйти контракту, а срок ${deadline} ближе запаса ${input.submitMargin} с (время L1 ${input.fresh}, снимок контракта — ${input.seen}): ` +
            `ждём приёма либо снимка позже срока + ${input.rebuildMargin} с`,
    };
}

/** Условие запуска: проверка кандидата, пруф и запас помещаются в срок (круг 20, пункт 7). */
export function startBudgetProblem(input: { proofTime: number; checkTime: number; submitMargin: number; maxBlockAge: number }): string | null {
    const total = input.proofTime + input.checkTime + input.submitMargin;
    if (total < input.maxBlockAge) return null;
    return (
        `время проверки кандидата ${input.checkTime} с + время пруфа ${input.proofTime} с + запас ${input.submitMargin} с = ${total} с ` +
        `не меньше maxBlockAge ${input.maxBlockAge} с: каждый блок пересобирался бы до пруфа; уменьшите expectedProofTime ` +
        'либо разверните контракт с большим maxBlockAge'
    );
}
