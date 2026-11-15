// Версия протокола rollup'а и то, под какую версию построены пруфы в fixtures/.
//
// Смена протокола (PROTOCOL-V2.md) идёт шагами: сначала контракт, двойник и обёртки, затем
// программа zkVM, затем пруфы. Между первым и последним шагом в репозитории лежат пруфы и
// ключи ПРЕЖНЕГО протокола: другой дайджест публичных значений, другие сообщения. Наборы
// тестов и скрипты, которым нужны такие пруфы, с нынешним контрактом несовместимы — они
// спрашивают об этом здесь и помечают себя todo либо отказываются стартовать, а не падают и не
// подгоняются.

/** Версия протокола контракта в этой ветке (get-метод protocolVersion обязан вернуть её же). */
export const PROTOCOL_VERSION: number = 2;

/**
 * Версия протокола, под которую построены пруфы и ключи в fixtures/ (sp1_rollup_*, sp1_evm_*,
 * rollup_batches, zkvm_batches, evm_batches). Поднимает тот, кто перестроил пруфы под новый
 * протокол; прежняя версия целиком — на теге protocol-v1.
 */
export const PROOF_FIXTURES_PROTOCOL_VERSION: number = 1;

/** Почему пруфами из fixtures/ сейчас пользоваться нельзя; null — можно. */
export function proofFixturesBlocker(): string | null {
    if (PROOF_FIXTURES_PROTOCOL_VERSION === PROTOCOL_VERSION) return null;
    return (
        `пруфы и ключи в fixtures/ построены под протокол v${PROOF_FIXTURES_PROTOCOL_VERSION}, ` +
        `контракт — протокола v${PROTOCOL_VERSION} (прежняя версия — тег protocol-v1)`
    );
}

/** Для скриптов протокола v1: явный отказ в начале работы. */
export function assertProtocolV1Script(script: string): void {
    const blocker = proofFixturesBlocker();
    if (blocker) throw new Error(`${script}: скрипт для протокола v1, см. тег protocol-v1 — ${blocker}`);
}
