// Версия протокола rollup'а и то, под какую версию построены пруфы в fixtures/.
//
// Смена протокола (PROTOCOL-V2.md) идёт шагами: сначала контракт, двойник и обёртки, затем
// программа zkVM, затем пруфы. Между первым и последним шагом в репозитории лежат пруфы и
// ключи ПРЕЖНЕГО протокола: другой дайджест публичных значений, другие сообщения. Наборы
// тестов, которым нужны пруфы нынешнего протокола, спрашивают об этом здесь и помечают себя
// todo, а не падают и не подгоняются. Скрипты прежнего протокола отказываются стартовать
// безусловно (assertProtocolV1Script). Какие файлы вправе ждать пруфов и не типизироваться —
// закрепляет tests/ProtocolGate.spec.ts.

/** Версия протокола контракта в этой ветке (get-метод protocolVersion обязан вернуть её же). */
export const PROTOCOL_VERSION: number = 2;

/**
 * Версия протокола, под которую построены пруфы SP1 в fixtures/ (sp1_evm_reth*; пруфы
 * игрушечного реестра sp1_rollup_* и блока anvil sp1_evm_batch2 остаются историческими).
 * Поднимает тот, кто перестроил пруфы под новый протокол; прежняя версия целиком — на теге
 * protocol-v1. Ключ программы EVM (fixtures/evm_batches/key.json) и пруфы игрушечной схемы
 * (fixtures/rollup_batches) уже протокола v2: у них версия записана в самих файлах.
 */
export const PROOF_FIXTURES_PROTOCOL_VERSION: number = 1;

/** Почему пруфами из fixtures/ сейчас пользоваться нельзя; null — можно. */
export function proofFixturesBlocker(): string | null {
    if (PROOF_FIXTURES_PROTOCOL_VERSION === PROTOCOL_VERSION) return null;
    return (
        `пруфы SP1 в fixtures/ построены под протокол v${PROOF_FIXTURES_PROTOCOL_VERSION}, ` +
        `контракт — протокола v${PROTOCOL_VERSION} (прежняя версия — тег protocol-v1)`
    );
}

/**
 * Для скриптов протокола v1: явный отказ в начале работы — БЕЗУСЛОВНЫЙ, пока контракт в этой
 * ветке не протокола v1. От версии пруфов в fixtures/ отказ не зависит намеренно: иначе
 * подъём PROOF_FIXTURES_PROTOCOL_VERSION (его делает тот, кто перестроил пруфы) сам
 * разблокировал бы скрипты, написанные под сообщения и обёртки прежнего протокола
 * (REVIEW.md, 14-8). Скрипт снимает этот вызов только вместе с переносом на новый протокол.
 * `protocolVersion` — параметр ради теста.
 */
export function assertProtocolV1Script(script: string, protocolVersion: number = PROTOCOL_VERSION): void {
    if (protocolVersion !== 1) {
        throw new Error(
            `${script}: скрипт написан для протокола v1 и на протокол v${protocolVersion} не перенесён ` +
                '(прежняя версия целиком — тег protocol-v1)',
        );
    }
}

/**
 * Что делать набору тестов, которому нужны пруфы SP1 нынешнего протокола:
 *   'todo' — пруфы в fixtures/ ещё прежнего протокола (`blocker` назван): набор ждёт;
 *   'run'  — версии совпали и пруфы годны;
 *   'fail' — версии совпали, а пруфы негодны. Это уже не ожидание, а поломка: флаг версии
 *            поднимает тот, кто перестроил пруфы, и после этого негодный пруф (чужая цепочка,
 *            другой ELF, другой ключ) обязан ронять набор, а не прятаться за todo.
 */
export function proofSuiteMode(blocker: string | null, proofsCurrent: boolean): 'run' | 'todo' | 'fail' {
    if (blocker !== null) return 'todo';
    return proofsCurrent ? 'run' : 'fail';
}
