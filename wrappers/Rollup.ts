import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    DictionaryValue,
    Sender,
    SendMode,
} from '@ton/core';
import { Bn254Groth16Verifier, Bn254Proof, KeyUpload } from './Bn254Groth16Verifier';

export const RollupOpcodes = {
    submitBatch: 0x52420001,
    depositTon: 0x52420002,
    forceTransaction: 0x52420005,
    publishData: 0x52420003,
    withdraw: 0x52420004,
    activateEscapeHatch: 0x52420006,
    forceExitEvm: 0x5242000d,
    cancelDeposit: 0x52420008,
    pruneDepositReceipts: 0x5242000a,
    discardBatchData: 0x5242000b,
    payOwed: 0x5242000c,
    nullifierClaim: 0x52420010,
    nullifierClaimed: 0x52420011,
};

export const RollupErrors = {
    wrongProof: 7300,
    unknownMessage: 7301,
    notOwner: 7302,
    notSequencer: 7303,
    keyAlreadyFinalized: 7304,
    keyNotFinalized: 7305,
    depositTooSmall: 7306,
    notEnoughValue: 7307,
    wrongMerkleProof: 7308,
    notNullifier: 7309,
    wrongRecipient: 7310,
    dataForClosedBatch: 7311,
    rollupFrozen: 7312,
    rollupNotFrozen: 7313,
    escapeNotDue: 7314,
    nothingToExit: 7315,
    depositAlreadyProcessed: 7316,
    noSuchDeposit: 7317,
    malformedForcedTransaction: 7319,
    insufficientFunds: 7320,
    badDeployment: 7321,
    dataTooFarAhead: 7322,
    nothingOwed: 7323,
    badKeyPoint: 7324,
    feeBelowGasCost: 7325,
    queueFeeAboveLimit: 7326,
    /** Батч заявил отметку очереди вне отрезка [processed, head]. */
    queueMarkOutOfRange: 7327,
    /** Батч заявил больше элементов очереди, чем можно за раз (get-метод queueLimits). */
    tooManyQueueItems: 7328,
    blockFromFuture: 7329,
    blockTooOld: 7330,
    /** В словаре очереди нет места: предел неубранных записей (get-метод queueLimits). */
    queueStorageFull: 7331,
    depositTooLarge: 7332,
    /** Начальное состояние не каноническое: ключ не фиксируется. */
    badGenesis: 7333,
    queueEntryMissing: 7334,
};

/** Базовая комиссия депозита (DEPOSIT_FEE в contracts/rollup/logic.tolk). */
export const BASE_DEPOSIT_FEE = 10_000_000n;

export const NullifierErrors = {
    notRollup: 7200,
    alreadyClaimed: 7201,
    unknownMessage: 7202,
    notEnoughValue: 7203,
};

/** Коды отказа верификатора BN254 (contracts/bn254/hinted.tolk, verifier_api.tolk). */
export const VerifierErrors = {
    inputOutOfRange: 7003,
    malformedHints: 7004,
    degenerateSlope: 7005,
    wrongSlope: 7006,
    pointNotOnCurve: 7010,
    badKeyPart: 7105,
};

export type RollupConfig = {
    owner: Address;
    sequencer: Address;
    nullifierCode: Cell;
    /**
     * Начальное слово состояния: хеш заголовка генезиса L2. Контракт зафиксирует ключ, только
     * если оно равно его константе протокола (get-метод genesisHash).
     */
    genesisStateRoot: bigint;
    /** Идентификатор rollup'а: входит в публичный вход пруфа и в подписи транзакций L2. */
    chainId: bigint;
    /** Сколько секунд элемент очереди L1 может ждать обработки, прежде чем rollup можно заморозить. */
    escapeTimeout: number;
    /** Наибольший возраст блока L2 на момент приёма батча, секунд. */
    maxBlockAge: number;
};

/** Заявка аварийного выхода: какой счёт L2, сколько и кому в basechain. */
export type ExitClaim = { l2Account: bigint; amount: bigint; recipient: Address };

/** То, что батч заявляет (BatchRoots в contracts/rollup/messages.tolk). */
export type BatchRoots = {
    newStateRoot: bigint;
    withdrawalsRoot: bigint;
    /** Число листьев дерева выводов после батча. */
    withdrawalsCount: bigint;
    /** До какого элемента очереди L1 (включительно) батч её обработал. */
    queueProcessedUpTo: bigint;
    /** Время блока L2, секунды. */
    blockTimestamp: bigint;
};

/**
 * То, что заявлял батч протокола v1. Нужен только загрузчикам фикстур прежних пруфов
 * (wrappers/zkvmProofs.ts, wrappers/evmProofs.ts); контракту v2 такие батчи не отправить.
 */
export type BatchRootsV1 = { newStateRoot: bigint; withdrawalsRoot: bigint };

export type QueueMark = { count: bigint; hash: bigint };

/** Отметки очереди L1 (DepositQueue в contracts/rollup/storage.tolk). */
export type QueueState = { head: QueueMark; processed: QueueMark; prunedCount: bigint };

/** Запись словаря очереди L1 (QueueEntry в contracts/rollup/storage.tolk). */
export type QueueEntry = {
    hashBefore: bigint;
    queuedAt: number;
    receipt: { depositor: Address; amount: bigint } | null;
};

/** Раскладка записи словаря очереди — обязана совпадать с QueueEntry в storage.tolk. */
export const QueueEntryValue: DictionaryValue<QueueEntry> = {
    serialize(src, builder) {
        builder.storeUint(src.hashBefore, 256).storeUint(src.queuedAt, 32);
        if (src.receipt) builder.storeBit(true).storeAddress(src.receipt.depositor).storeCoins(src.receipt.amount);
        else builder.storeBit(false);
    },
    parse(src) {
        const hashBefore = src.loadUintBig(256);
        const queuedAt = src.loadUint(32);
        const receipt = src.loadBit() ? { depositor: src.loadAddress(), amount: src.loadCoins() } : null;
        return { hashBefore, queuedAt, receipt };
    },
};

/** Раскладка записи о долге — обязана совпадать с OwedPayout в storage.tolk. */
export const OwedPayoutValue: DictionaryValue<{ recipient: Address; amount: bigint }> = {
    serialize(src, builder) {
        builder.storeAddress(src.recipient).storeCoins(src.amount);
    },
    parse(src) {
        return { recipient: src.loadAddress(), amount: src.loadCoins() };
    },
};

/**
 * Неканоническое начальное состояние — ТОЛЬКО ДЛЯ ТЕСТОВ: проверить, что контракт с ним не
 * начинает работу, либо поставить очередь сразу на нужную отметку. Настоящее развёртывание —
 * createFromConfig без подлога; сверка адреса (wrappers/rollupDeployment.ts) подлог ловит.
 */
export type PlantedState = {
    withdrawalsRoot?: bigint;
    withdrawalsCount?: bigint;
    batchIndex?: bigint;
    queue?: Partial<QueueState>;
    queueItems?: Dictionary<bigint, QueueEntry>;
    /** Хеши данных батчей (RollupState.pendingData): номер батча → накопительный хеш порций. */
    pendingData?: Dictionary<bigint, bigint>;
    /** Долги (RollupState.owed): ключ нуллификатора → кому и сколько. */
    owed?: Dictionary<bigint, { recipient: Address; amount: bigint }>;
    /** Ключ уже «зафиксирован» (значение — эта ячейка): минуя FinalizeKey, который такое состояние отверг бы. */
    vkData?: Cell;
};

/** Обёртка над contracts/rollup.tolk и его тестовым двойником contracts/rollup_mock.tolk. */
export class Rollup implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Rollup(address);
    }

    /**
     * Ячейка начальных данных. Раскладка повторяет RollupStorage, RollupState, DepositQueue и
     * RollupKeys (contracts/rollup/storage.tolk). `planted` — только для тестов.
     */
    static buildData(config: RollupConfig, planted: PlantedState = {}): Cell {
        const head = planted.queue?.head ?? { count: 0n, hash: 0n };
        const processed = planted.queue?.processed ?? { count: 0n, hash: 0n };
        const queue = beginCell()
            .storeUint(head.count, 64)
            .storeUint(head.hash, 256)
            .storeUint(processed.count, 64)
            .storeUint(processed.hash, 256)
            .storeUint(planted.queue?.prunedCount ?? 0n, 64)
            .endCell();
        const state = beginCell()
            .storeUint(config.genesisStateRoot, 256)
            .storeUint(planted.withdrawalsRoot ?? 0n, 256) // корень выводов: выводов ещё не было
            .storeUint(planted.withdrawalsCount ?? 0n, 64) // счётчик выводов
            .storeUint(planted.batchIndex ?? 0n, 64)
            .storeRef(queue)
            .storeDict(planted.pendingData ?? null) // pendingData: данных батчей ещё нет
            .storeDict(planted.queueItems ?? null) // queueItems: очередь пуста
            .storeBit(false) // frozen
            .storeDict(planted.owed ?? null) // owed: долгов нет
            .endCell();
        const keys = beginCell()
            .storeMaybeRef(planted.vkData ?? null) // vkData: ещё нет
            .storeBit(false) // keyParts: пустой словарь
            .endCell();
        return beginCell()
            .storeAddress(config.owner)
            .storeAddress(config.sequencer)
            .storeUint(config.chainId, 64)
            .storeUint(config.escapeTimeout, 32)
            .storeUint(config.maxBlockAge, 32)
            .storeRef(keys)
            .storeRef(config.nullifierCode)
            .storeRef(state)
            .endCell();
    }

    static createFromConfig(config: RollupConfig, code: Cell, workchain = 0) {
        const init = { code, data: Rollup.buildData(config) };
        return new Rollup(contractAddress(workchain, init), init);
    }

    /** Контракт с подложенным начальным состоянием — только для тестов (см. PlantedState). */
    static createPlanted(config: RollupConfig, planted: PlantedState, code: Cell, workchain = 0) {
        const init = { code, data: Rollup.buildData(config, planted) };
        return new Rollup(contractAddress(workchain, init), init);
    }

    /** Словарь данных батчей для подложенного состояния. */
    static pendingDataDictionary(): Dictionary<bigint, bigint> {
        return Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.BigUint(256));
    }

    /** Словарь долгов для подложенного состояния. */
    static owedDictionary(): Dictionary<bigint, { recipient: Address; amount: bigint }> {
        return Dictionary.empty(Dictionary.Keys.BigUint(256), OwedPayoutValue);
    }

    /** Словарь очереди L1 для подложенного состояния. */
    static queueItemsDictionary(): Dictionary<bigint, QueueEntry> {
        return Dictionary.empty(Dictionary.Keys.BigUint(64), QueueEntryValue);
    }

    /**
     * Отметки очереди L1 и её словарь — по ячейке данных контракта, без get-методов. Раскладка
     * повторяет buildData. Нужна там, где get-метод недоступен (эмулятор Sandbox не исполняет
     * get-методы контракта с балансом от 2^63 нанотон) и для сверки раскладки с контрактом.
     */
    static queueFromData(data: Cell): QueueState & { items: Dictionary<bigint, QueueEntry> } {
        const root = data.beginParse();
        root.loadRef(); // RollupKeys
        root.loadRef(); // код нуллификатора
        const state = root.loadRef().beginParse();
        state.skip(256 + 256 + 64 + 64); // слово состояния, корень и счётчик выводов, номер батча
        const queue = state.loadRef().beginParse();
        const mark = (): QueueMark => ({ count: queue.loadUintBig(64), hash: queue.loadUintBig(256) });
        const [head, processed] = [mark(), mark()];
        const prunedCount = queue.loadUintBig(64);
        state.loadMaybeRef(); // pendingData
        const items = state.loadDict(Dictionary.Keys.BigUint(64), QueueEntryValue);
        return { head, processed, prunedCount, items };
    }

    /**
     * Номера частей ключа, уже загруженных в контракт, — по ячейке его данных.
     * Get-метода для этого у контракта нет; раскладка повторяет RollupStorage
     * (contracts/rollup/storage.tolk) и createFromConfig выше.
     */
    static uploadedKeySlots(data: Cell): number[] {
        const keys = data.beginParse().loadRef().beginParse(); // первая ссылка корня — RollupKeys
        keys.loadMaybeRef(); // vkData
        return keys.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Cell()).keys();
    }

    /**
     * Хеши загруженных частей ключа по номерам — по ячейке данных контракта. Скрипт
     * развёртывания сверяет их с ожидаемыми ДО фиксации: до неё часть можно перезаписать,
     * после — ключ неизменяем.
     */
    static uploadedKeyPartHashes(data: Cell): Map<number, string> {
        const keys = data.beginParse().loadRef().beginParse(); // RollupKeys
        keys.loadMaybeRef(); // vkData
        const parts = keys.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
        return new Map(parts.keys().map((slot) => [slot, parts.get(slot)!.hash().toString('hex')]));
    }

    private async send(provider: ContractProvider, via: Sender, value: bigint, body: Cell) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body });
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await this.send(provider, via, value, beginCell().endCell());
    }

    async sendUploadKeyPart(
        provider: ContractProvider,
        via: Sender,
        opts: { slot: number; part: Cell; value: bigint },
    ) {
        await this.send(provider, via, opts.value, Bn254Groth16Verifier.buildUploadBody(opts.slot, opts.part));
    }

    async sendFinalizeKey(provider: ContractProvider, via: Sender, opts: { key: KeyUpload; value: bigint }) {
        await this.send(provider, via, opts.value, Bn254Groth16Verifier.buildFinalizeBody(opts.key));
    }

    static buildProofCell(proof: Bn254Proof): Cell {
        const { a, b, c } = proof;
        const bCell = beginCell()
            .storeUint(b[0][0], 254)
            .storeUint(b[0][1], 254)
            .storeUint(b[1][0], 254)
            .storeUint(b[1][1], 254)
            .endCell();
        return beginCell()
            .storeUint(a[0], 254)
            .storeUint(a[1], 254)
            .storeUint(c[0], 254)
            .storeUint(c[1], 254)
            .storeRef(bCell)
            .endCell();
    }

    static buildBatchRootsCell(roots: BatchRoots): Cell {
        return beginCell()
            .storeUint(roots.newStateRoot, 256)
            .storeUint(roots.withdrawalsRoot, 256)
            .storeUint(roots.withdrawalsCount, 64)
            .storeUint(roots.queueProcessedUpTo, 64)
            .storeUint(roots.blockTimestamp, 64)
            .endCell();
    }

    static buildSubmitBatchBody(opts: { proof: Bn254Proof; hints: Cell; roots: BatchRoots }): Cell {
        return beginCell()
            .storeUint(RollupOpcodes.submitBatch, 32)
            .storeUint(0, 64)
            .storeRef(Rollup.buildProofCell(opts.proof))
            .storeRef(opts.hints)
            .storeRef(Rollup.buildBatchRootsCell(opts.roots))
            .endCell();
    }

    async sendSubmitBatch(
        provider: ContractProvider,
        via: Sender,
        opts: { proof: Bn254Proof; hints: Cell; roots: BatchRoots; value: bigint },
    ) {
        await this.send(provider, via, opts.value, Rollup.buildSubmitBatchBody(opts));
    }

    /** Заморозить rollup: срабатывает, только если элемент очереди L1 ждёт дольше escapeTimeout. */
    async sendActivateEscapeHatch(provider: ContractProvider, via: Sender, value: bigint) {
        const body = beginCell().storeUint(RollupOpcodes.activateEscapeHatch, 32).storeUint(0, 64).endCell();
        await this.send(provider, via, value, body);
    }

    /**
     * Аварийный выход счёта EVM без пруфа: заголовок последнего принятого блока, доказательство
     * счёта и подпись владельца (ячейки собирает wrappers/evmExit.ts).
     */
    async sendForceExitEvm(
        provider: ContractProvider,
        via: Sender,
        opts: { recipient: Address; header: Cell; proof: Cell; signature: Cell; value: bigint },
    ) {
        const body = beginCell()
            .storeUint(RollupOpcodes.forceExitEvm, 32)
            .storeUint(0, 64)
            .storeAddress(opts.recipient)
            .storeRef(opts.header)
            .storeRef(opts.proof)
            .storeRef(opts.signature)
            .endCell();
        await this.send(provider, via, opts.value, body);
    }

    /** Запас газа шага ForceExitEvm и минимум монет на него при текущих ценах сети. */
    async getEvmExitBudget(provider: ContractProvider) {
        const { stack } = await provider.get('evmExitBudget', []);
        return { stepGas: stack.readNumber(), minValue: stack.readBigNumber() };
    }

    /** Хеш согласия, который подписывает владелец счёта EVM для выхода этому получателю. */
    async getEvmExitConsentHash(provider: ContractProvider, recipientHash: bigint): Promise<bigint> {
        const result = await provider.get('evmExitConsentHash', [{ type: 'int', value: recipientHash }]);
        return result.stack.readBigNumber();
    }

    /** Вернуть вносителю депозит, не попавший в батч до заморозки. */
    async sendCancelDeposit(provider: ContractProvider, via: Sender, opts: { depositIndex: number; value: bigint }) {
        const body = beginCell()
            .storeUint(RollupOpcodes.cancelDeposit, 32)
            .storeUint(0, 64)
            .storeUint(opts.depositIndex, 64)
            .endCell();
        await this.send(provider, via, opts.value, body);
    }

    /** Удалить записи уже обработанных элементов очереди L1 (не больше count за раз). */
    async sendPruneDepositReceipts(provider: ContractProvider, via: Sender, opts: { count: number; value: bigint }) {
        const body = beginCell()
            .storeUint(RollupOpcodes.pruneDepositReceipts, 32)
            .storeUint(0, 64)
            .storeUint(opts.count, 16)
            .endCell();
        await this.send(provider, via, opts.value, body);
    }

    /**
     * Порция данных батча (data availability). `data` — дерево ячеек из
     * `dataChunkCell` (wrappers/rollupMath.ts): программа zkVM считает хеш такой раскладки.
     */
    async sendPublishData(
        provider: ContractProvider,
        via: Sender,
        opts: { batchIndex: number; data: Cell; value: bigint },
    ) {
        const body = beginCell()
            .storeUint(RollupOpcodes.publishData, 32)
            .storeUint(0, 64)
            .storeUint(opts.batchIndex, 64)
            .storeRef(opts.data)
            .endCell();
        await this.send(provider, via, opts.value, body);
    }

    /** Сбросить всё, что опубликовано для ещё не принятого батча (только секвенсор). */
    async sendDiscardBatchData(provider: ContractProvider, via: Sender, opts: { batchIndex: number; value: bigint }) {
        const body = beginCell()
            .storeUint(RollupOpcodes.discardBatchData, 32)
            .storeUint(0, 64)
            .storeUint(opts.batchIndex, 64)
            .endCell();
        await this.send(provider, via, opts.value, body);
    }

    /** Выплатить записанный долг по уже погашенной заявке; `key` — ключ нуллификатора. */
    async sendPayOwed(provider: ContractProvider, via: Sender, opts: { key: bigint; value: bigint }) {
        const body = beginCell()
            .storeUint(RollupOpcodes.payOwed, 32)
            .storeUint(0, 64)
            .storeUint(opts.key, 256)
            .endCell();
        await this.send(provider, via, opts.value, body);
    }

    /**
     * Депозит TON: на L2 зачтётся приложенная сумма минус комиссия за место в очереди.
     * Комиссия — 0,01 TON при короткой очереди и растёт с её длиной (getQueueFees). `maxFee` —
     * наибольшая комиссия, на которую согласен вноситель; по умолчанию базовая: при
     * перегруженной очереди депозит вернётся, а не уменьшится молча.
     */
    async sendDeposit(
        provider: ContractProvider,
        via: Sender,
        opts: { l2Recipient: bigint; value: bigint; maxFee?: bigint },
    ) {
        const body = beginCell()
            .storeUint(RollupOpcodes.depositTon, 32)
            .storeUint(0, 64)
            .storeUint(opts.l2Recipient, 160)
            .storeCoins(opts.maxFee ?? BASE_DEPOSIT_FEE)
            .endCell();
        await this.send(provider, via, opts.value, body);
    }

    /**
     * Поставить транзакцию L2 в очередь L1 в обход секвенсора. `l2Transaction` — «змейка» из
     * `forcedTransactionCell` (wrappers/rollupMath.ts): байты подписанной транзакции EVM.
     */
    async sendForceTransaction(provider: ContractProvider, via: Sender, opts: { l2Transaction: Cell; value: bigint }) {
        const body = beginCell()
            .storeUint(RollupOpcodes.forceTransaction, 32)
            .storeUint(0, 64)
            .storeRef(opts.l2Transaction)
            .endCell();
        await this.send(provider, via, opts.value, body);
    }

    async sendWithdraw(
        provider: ContractProvider,
        via: Sender,
        opts: { leafIndex: number; recipient: Address; amount: bigint; merkleProof: Cell; value: bigint },
    ) {
        const body = beginCell()
            .storeUint(RollupOpcodes.withdraw, 32)
            .storeUint(0, 64)
            .storeUint(opts.leafIndex, 32)
            .storeAddress(opts.recipient)
            .storeCoins(opts.amount)
            .storeRef(opts.merkleProof)
            .endCell();
        await this.send(provider, via, opts.value, body);
    }

    async getProtocolVersion(provider: ContractProvider): Promise<number> {
        const { stack } = await provider.get('protocolVersion', []);
        return stack.readNumber();
    }

    /** Хеш заголовка генезиса L2 — константа протокола в коде контракта. */
    async getGenesisHash(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('genesisHash', []);
        return stack.readBigNumber();
    }

    async getRollupState(provider: ContractProvider) {
        const { stack } = await provider.get('rollupState', []);
        return {
            stateRoot: stack.readBigNumber(),
            withdrawalsRoot: stack.readBigNumber(),
            batchIndex: stack.readNumber(),
            withdrawalsCount: stack.readBigNumber(),
        };
    }

    async getDepositQueue(provider: ContractProvider): Promise<QueueState> {
        const { stack } = await provider.get('depositQueue', []);
        const mark = (): QueueMark => ({ count: stack.readBigNumber(), hash: stack.readBigNumber() });
        return { head: mark(), processed: mark(), prunedCount: stack.readBigNumber() };
    }

    /** Запись словаря очереди L1 по номеру элемента; null, если её нет (убрана либо не было). */
    async getQueueItem(provider: ContractProvider, index: number | bigint) {
        const { stack } = await provider.get('queueItem', [{ type: 'int', value: BigInt(index) }]);
        const found = stack.readBoolean();
        const hashBefore = stack.readBigNumber();
        const queuedAt = stack.readNumber();
        return found ? { hashBefore, queuedAt } : null;
    }

    /** Пределы очереди L1 — константы контракта. */
    async getQueueLimits(provider: ContractProvider) {
        const { stack } = await provider.get('queueLimits', []);
        return {
            maxBatchQueueItems: stack.readNumber(),
            maxTrackedItems: stack.readNumber(),
            maxForcedTxCells: stack.readNumber(),
            prunePerPush: stack.readNumber(),
            depositAmountLimit: stack.readBigNumber(),
            maxForcedTxBytes: stack.readNumber(),
        };
    }

    /** Наименьшие допустимые maxBlockAge и срок заморозки — константы контракта. */
    async getTimeLimits(provider: ContractProvider) {
        const { stack } = await provider.get('timeLimits', []);
        return { minMaxBlockAge: stack.readNumber(), minEscapeTimeout: stack.readNumber() };
    }

    async getExpectedPublicInput(provider: ContractProvider, roots: BatchRoots): Promise<bigint> {
        const { stack } = await provider.get('expectedPublicInput', [
            { type: 'int', value: roots.newStateRoot },
            { type: 'int', value: roots.withdrawalsRoot },
            { type: 'int', value: roots.withdrawalsCount },
            { type: 'int', value: roots.queueProcessedUpTo },
            { type: 'int', value: roots.blockTimestamp },
        ]);
        return stack.readBigNumber();
    }

    /** Накопительный хеш данных, опубликованных для батча; 0, если их нет. */
    async getBatchDataHash(provider: ContractProvider, batchIndex: number): Promise<bigint> {
        const { stack } = await provider.get('batchDataHash', [{ type: 'int', value: BigInt(batchIndex) }]);
        return stack.readBigNumber();
    }

    async getChainId(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('chainId', []);
        return stack.readBigNumber();
    }

    async getKeyHash(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('keyHash', []);
        return stack.readBigNumber();
    }

    /** Заморожен ли rollup, когда встал самый старый необработанный элемент очереди (0 — нет таких) и срок. */
    async getEscapeState(provider: ContractProvider) {
        const { stack } = await provider.get('escapeState', []);
        return { frozen: stack.readBoolean(), oldestPendingAt: stack.readNumber(), timeout: stack.readNumber() };
    }

    async getExitNullifierAddress(provider: ContractProvider, l2Account: bigint): Promise<Address> {
        const { stack } = await provider.get('exitNullifierAddress', [{ type: 'int', value: l2Account }]);
        return stack.readAddress();
    }

    /** Квитанция депозита: кто и сколько внёс; null, если её нет (обработан и убран либо возвращён). */
    async getDepositReceipt(provider: ContractProvider, depositIndex: number) {
        const { stack } = await provider.get('depositReceipt', [{ type: 'int', value: BigInt(depositIndex) }]);
        const depositor = stack.readAddressOpt();
        const amount = stack.readBigNumber();
        return depositor ? { depositor, amount } : null;
    }

    async getNullifierAddress(provider: ContractProvider, leafIndex: number): Promise<Address> {
        const { stack } = await provider.get('nullifierAddress', [{ type: 'int', value: BigInt(leafIndex) }]);
        return stack.readAddress();
    }

    /** Параметры развёртывания, как их хранит контракт. */
    async getDeployment(provider: ContractProvider) {
        const { stack } = await provider.get('deployment', []);
        return {
            owner: stack.readAddress(),
            sequencer: stack.readAddress(),
            chainId: stack.readBigNumber(),
            escapeTimeout: stack.readNumber(),
            maxBlockAge: stack.readNumber(),
            nullifierCodeHash: stack.readBigNumber(),
        };
    }

    /** Долг по уже погашенной заявке; null, если его нет. `key` — ключ нуллификатора. */
    async getOwedPayout(provider: ContractProvider, key: bigint) {
        const { stack } = await provider.get('owedPayout', [{ type: 'int', value: key }]);
        const recipient = stack.readAddressOpt();
        const amount = stack.readBigNumber();
        return recipient ? { recipient, amount } : null;
    }

    /** Плата за место в очереди L1 прямо сейчас и число необработанных элементов. */
    async getQueueFees(provider: ContractProvider) {
        const { stack } = await provider.get('queueFees', []);
        return {
            depositFee: stack.readBigNumber(),
            forceTransactionFee: stack.readBigNumber(),
            pending: stack.readNumber(),
            step: stack.readNumber(),
        };
    }

    /** Запасы газа шагов очереди L1 и БАЗОВАЯ плата за принудительную транзакцию при текущих ценах. */
    async getQueueBudgets(provider: ContractProvider) {
        const { stack } = await provider.get('queueBudgets', []);
        return {
            depositStepGas: stack.readNumber(),
            forceTransactionStepGas: stack.readNumber(),
            forceTransactionFee: stack.readBigNumber(),
        };
    }

    /** Запасы газа цепочки вывода и производные от них суммы — как их считает контракт. */
    async getPayoutBudgets(provider: ContractProvider) {
        const { stack } = await provider.get('payoutBudgets', []);
        return {
            withdrawStepGas: stack.readNumber(),
            nullifierClaimGas: stack.readNumber(),
            payoutStepGas: stack.readNumber(),
            payoutStepValue: stack.readBigNumber(),
            payoutOverhead: stack.readBigNumber(),
        };
    }

    /** Минимум монет для Withdraw при текущих ценах сети (для ForceExitEvm — getEvmExitBudget). */
    async getMinimumValues(provider: ContractProvider) {
        const { stack } = await provider.get('minimumValues', []);
        return { withdraw: stack.readBigNumber() };
    }
}

/** Основание ключей нуллификатора аварийных выходов (EXIT_NULLIFIER_BASE в escape.tolk). */
export const EXIT_NULLIFIER_BASE = 1n << 255n;
export const exitNullifierKey = (l2Account: bigint): bigint => EXIT_NULLIFIER_BASE + l2Account;
