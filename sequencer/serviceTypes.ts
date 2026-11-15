import path from 'path';
import { BuildRequest } from './block/payload';
import { ProgramTools } from './program';
import { Prover } from './prover';
import { QueueSource } from './queue/types';
import { NodeRpc } from './rpc';
import { BatchSubmitter } from './submitter';

// Конфигурация, зависимости и результаты шага сервиса сборщика (service.ts). Отдельно от класса
// сервиса — чтобы service.ts оставался в пределах размера; service.ts всё это реэкспортирует.

export type Phase =
    | 'built'
    | 'inserted'
    | 'tentative'
    | 'checked'
    | 'proven'
    | 'submitted'
    // Точки внутри пересборки (круг 20, пункт 4): после отмены задания, записи состояния,
    // переименования каталога блока, отвода safe.
    | 'rebuild-cancelled'
    | 'rebuild-saved'
    | 'rebuild-renamed'
    | 'rebuild-safe';

/** fixtures/evm_batches/program.json — что записано о сборке программы (пишет только --vkeys). */
export const DEFAULT_PROGRAM_KEYS = path.join(__dirname, '..', 'fixtures', 'evm_batches', 'program.json');
/** Бюджет газа транзакций пула на блок по умолчанию (принцип 0.1: цена блока для прувера известна). */
export const DEFAULT_POOL_GAS_BUDGET = 5_000_000n;
/** Ожидаемое время пруфа батча по умолчанию, с: Groth16 блока EVM — 15 минут на ноутбуке. */
export const DEFAULT_EXPECTED_PROOF_TIME = 1800;
/** Запас до конца срока приёма перед отправкой по умолчанию, с. */
export const DEFAULT_SUBMIT_MARGIN = 300;
/** Сколько терпеть отставание источника сообщений очереди по умолчанию, с. */
export const DEFAULT_QUEUE_LAG_LIMIT = 1800;

/** Остановка сервиса: дальше без человека нельзя (текст — что случилось). */
export class SequencerStop extends Error {}
/** Только для тестов: искусственная остановка после фазы. */
export class Interrupted extends Error {
    constructor(readonly phase: Phase) {
        super(`прервано после фазы ${phase}`);
    }
}

export type SequencerConfig = {
    chainId: bigint;
    /** Получатель чаевых — адрес секвенсора на L2. */
    feeRecipient: string;
    /** Каталог состояния; по умолчанию — DEFAULT_STATE_DIR (.tools/sequencer/). */
    stateDir: string;
    /** HTTP JSON-RPC узла: им же ходит rsp. */
    rpcUrl: string;
    genesisPath: string;
    /** Брать транзакции секвенсора из пула узла. */
    includePool: boolean;
    tools: ProgramTools;
    /** Предел отрезка очереди — get-метод queueLimits контракта. */
    maxBatchQueueItems: number;
    /** Срок приёма батча после времени блока, с — get-метод deployment контракта (maxBlockAge). */
    maxBlockAge: number;
    /** program.json сборки программы; по умолчанию — DEFAULT_PROGRAM_KEYS. */
    programKeysPath?: string;
    /** Кандидат старше этого (с от его времени) после перезапуска не продолжается; по умолчанию maxBlockAge / 4. */
    staleCandidateAge?: number;
    /** Запас до конца срока приёма перед отправкой (и сверх времени пруфа — перед пруфом), с; по умолчанию 300. */
    submitMargin?: number;
    /**
     * Ожидаемое время пруфа батча, с; по умолчанию 1800. Перед пруфом блок, батч которого не
     * успеть (время пруфа + запас), пересобирается. Время пруфа + запас обязаны быть меньше maxBlockAge.
     */
    expectedProofTime?: number;
    /** Ожидаемое время проверки кандидата (rsp, хост, сверки), с; по умолчанию 300. Входит в условие запуска. */
    expectedCheckTime?: number;
    /**
     * Запас после конца срока приёма, с; по умолчанию 60. Батч, который мог уйти контракту,
     * пересобирается, только если снимок контракта позже `срок + rebuildMargin` и батча в нём нет.
     */
    rebuildMargin?: number;
    /** Сколько терпеть отставание источника сообщений очереди (QueueLagError), с; по умолчанию 1800. */
    queueLagLimit?: number;
    /** Наибольшее расхождение часов машины с временем L1 при старте, с; по умолчанию 60. */
    clockSkewLimit?: number;
    /** Бюджет газа транзакций пула на блок; по умолчанию DEFAULT_POOL_GAS_BUDGET. */
    poolGasBudget?: bigint;
    /** Сколько раз повторять запуск хоста или rsp после сбоя инструмента; по умолчанию 2. */
    toolRetries?: number;
    now?: () => number;
};

export type SequencerDeps = {
    node: NodeRpc;
    queue: QueueSource;
    prover: Prover;
    submitter: BatchSubmitter;
    /**
     * Время последнего блока L1 (TON), с: в Sandbox — blockchain.now, в сети — у провайдера. Срок
     * батча, который мог уйти, сверяется не с ним, а со временем снимка контракта (contractState).
     */
    l1Now: () => Promise<number>;
    log?: (line: string) => void;
    /** Только для тестов: остановиться после фазы; подменить запрос к узлу на попытке. */
    faults?: { stopAfter?: Phase; tamper?: (request: BuildRequest, attempt: number) => BuildRequest };
};

export type StepResult =
    | { kind: 'accepted'; number: number; hash: string; alreadyAccepted: boolean }
    | {
          kind: 'checked';
          number: number;
          hash: string;
          attempts: number;
          queueItems: number;
          included: number;
          pool: number;
          /** Блок пересобран: хеш прежнего блока той же высоты, батч которого контракт не примет. */
          replaced?: string;
      }
    /** Ждать: блок из будущего L1 либо батч мог уйти, а срок ещё не истёк. */
    | { kind: 'waiting'; number: number; reason: string }
    /** Собирать нечего. `unverifiedHead` — голова узла осталась на непроверенном кандидате. */
    | { kind: 'idle'; unverifiedHead?: string };
