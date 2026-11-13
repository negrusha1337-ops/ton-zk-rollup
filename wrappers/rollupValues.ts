import { toNano } from '@ton/core';

// Суммы сообщений для прогона rollup-контракта в testnet (scripts/runRollupTestnet.ts).
// Тест tests/RollupZkvmProof.spec.ts отправляет те же суммы в Sandbox: если их перестанет
// хватать на газ, это всплывёт до запуска в сети.
//
// Всё, что приложено к сообщению и не потрачено на газ, остаётся на контракте, а вернуть
// оттуда монеты нечем (управления у контракта нет), поэтому суммы взяты с небольшим запасом
// над измеренным расходом. Цена газа — 66,67 нанотон (конфиг сети, параметр 21).

/** Развёртывание: покрывает первые сообщения и хранение ключа на время прогона. */
export const DEPLOY_VALUE = toNano('0.05');
/** Часть ключа: в testnet её обработка стоила до 0,00043 TON. */
export const KEY_PART_VALUE = toNano('0.005');
/** Фиксация ключа: 30 050 gas, около 0,002 TON. */
export const KEY_FINALIZE_VALUE = toNano('0.01');
/** Порция данных батча: около 4 300 gas (0,0003 TON) при любом размере порции. */
export const PUBLISH_DATA_VALUE = toNano('0.005');
/** Батч: до 951 091 gas, около 0,0634 TON; для полного лимита 1 млн gas нужно не меньше 0,0667 TON. */
export const SUBMIT_BATCH_VALUE = toNano('0.1');
/** Вывод: контракт требует не меньше 0,1 TON на цепочку «rollup → нуллификатор → rollup → получатель». */
export const WITHDRAW_VALUE = toNano('0.12');

/** Срок аварийного выхода: сколько депозит может ждать обработки до заморозки rollup'а. */
export const ESCAPE_TIMEOUT_SECONDS = 7 * 24 * 3600;
/** Аварийный выход: газ проверки пруфа плюс цепочка через нуллификатор; контракт требует не меньше 0,2 TON. */
export const FORCE_EXIT_VALUE = toNano('0.2');
/** Срок аварийного выхода для стенда в testnet: короткий, чтобы прогон не ждал неделю. */
export const TESTNET_ESCAPE_TIMEOUT_SECONDS = 180;
/** Заморозка и возврат депозита: несколько тысяч gas. */
export const ESCAPE_SERVICE_VALUE = toNano('0.05');
/** Депозит, который в прогоне testnet остаётся необработанным и запускает срок заморозки. */
export const LATE_DEPOSIT_VALUE = toNano('0.06');
