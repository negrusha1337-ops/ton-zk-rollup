import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
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
    forceExit: 0x52420007,
    cancelDeposit: 0x52420008,
    setExitKey: 0x52420009,
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
    exitKeyNotSet: 7318,
    malformedForcedTransaction: 7319,
    insufficientFunds: 7320,
    badDeployment: 7321,
    dataTooFarAhead: 7322,
    nothingOwed: 7323,
    badKeyPoint: 7324,
    feeBelowGasCost: 7325,
    queueFeeAboveLimit: 7326,
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
    genesisStateRoot: bigint;
    /** Идентификатор rollup'а: входит в публичный вход пруфа и в подписи транзакций L2. */
    chainId: bigint;
    /** Сколько секунд депозит может ждать обработки, прежде чем rollup можно заморозить. */
    escapeTimeout: number;
};

/** Заявка аварийного выхода: какой счёт L2, сколько и кому в basechain. */
export type ExitClaim = { l2Account: bigint; amount: bigint; recipient: Address };

export type BatchRoots = { newStateRoot: bigint; withdrawalsRoot: bigint };

export type QueueMark = { count: bigint; hash: bigint };

/** Обёртка над contracts/rollup.tolk и его тестовым двойником contracts/rollup_mock.tolk. */
export class Rollup implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Rollup(address);
    }

    static createFromConfig(config: RollupConfig, code: Cell, workchain = 0) {
        const queue = beginCell();
        for (let i = 0; i < 3; i++) queue.storeUint(0, 64).storeUint(0, 256);
        const state = beginCell()
            .storeUint(config.genesisStateRoot, 256)
            .storeUint(0, 256) // корень выводов: выводов ещё не было
            .storeUint(0, 64)
            .storeRef(queue.endCell())
            .storeBit(false) // pendingData: данных батчей ещё нет
            .storeBit(false) // depositReceipts: депозитов ещё не было
            .storeBit(false) // frozen
            .storeUint(0, 32) // queuedAfterTargetAt
            .storeUint(0, 32) // queuedAfterProcessedAt
            .storeBit(false) // owed: долгов нет
            .endCell();
        const keys = beginCell()
            .storeBit(false) // vkData: ещё нет
            .storeBit(false) // keyParts: пустой словарь
            .storeUint(0, 254) // exitIc0x: не задан
            .storeUint(0, 254) // exitIc0y
            .endCell();
        const data = beginCell()
            .storeAddress(config.owner)
            .storeAddress(config.sequencer)
            .storeUint(config.chainId, 64)
            .storeUint(config.escapeTimeout, 32)
            .storeRef(keys)
            .storeRef(config.nullifierCode)
            .storeRef(state)
            .endCell();
        const init = { code, data };
        return new Rollup(contractAddress(workchain, init), init);
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

    /**
     * Задан ли ключ программы выхода — по ячейке данных контракта. До фиксации основного
     * ключа get-метод exitKeyHash возвращает 0, поэтому скрипту развёртывания нужен этот разбор.
     */
    static isExitKeySet(data: Cell): boolean {
        const keys = data.beginParse().loadRef().beginParse(); // RollupKeys
        keys.loadMaybeRef(); // vkData
        keys.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Cell()); // keyParts
        return keys.loadUintBig(254) !== 0n || keys.loadUintBig(254) !== 0n;
    }

    /**
     * IC0 ключа программы выхода, как он записан в данных контракта; (0, 0) — не задан.
     * Скрипт развёртывания сверяет его с ожидаемым ДО фиксации ключа: после неё ключ
     * выхода уже не исправить.
     */
    static exitKeyIc0(data: Cell): [bigint, bigint] {
        const keys = data.beginParse().loadRef().beginParse(); // RollupKeys
        keys.loadMaybeRef(); // vkData
        keys.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Cell()); // keyParts
        return [keys.loadUintBig(254), keys.loadUintBig(254)];
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

    static buildSubmitBatchBody(opts: { proof: Bn254Proof; hints: Cell; roots: BatchRoots }): Cell {
        const roots = beginCell()
            .storeUint(opts.roots.newStateRoot, 256)
            .storeUint(opts.roots.withdrawalsRoot, 256)
            .endCell();
        return beginCell()
            .storeUint(RollupOpcodes.submitBatch, 32)
            .storeUint(0, 64)
            .storeRef(Rollup.buildProofCell(opts.proof))
            .storeRef(opts.hints)
            .storeRef(roots)
            .endCell();
    }

    async sendSubmitBatch(
        provider: ContractProvider,
        via: Sender,
        opts: { proof: Bn254Proof; hints: Cell; roots: BatchRoots; value: bigint },
    ) {
        await this.send(provider, via, opts.value, Rollup.buildSubmitBatchBody(opts));
    }

    /** IC0 ключа программы выхода; задаётся владельцем один раз, до фиксации ключа. */
    async sendSetExitKey(provider: ContractProvider, via: Sender, opts: { ic0: [bigint, bigint]; value: bigint }) {
        const body = beginCell()
            .storeUint(RollupOpcodes.setExitKey, 32)
            .storeUint(0, 64)
            .storeUint(opts.ic0[0], 254)
            .storeUint(opts.ic0[1], 254)
            .endCell();
        await this.send(provider, via, opts.value, body);
    }

    /** Заморозить rollup: срабатывает, только если депозит ждёт дольше escapeTimeout. */
    async sendActivateEscapeHatch(provider: ContractProvider, via: Sender, value: bigint) {
        const body = beginCell().storeUint(RollupOpcodes.activateEscapeHatch, 32).storeUint(0, 64).endCell();
        await this.send(provider, via, value, body);
    }

    /** Аварийный выход с баланса L2 по пруфу программы выхода (только после заморозки). */
    async sendForceExit(
        provider: ContractProvider,
        via: Sender,
        opts: { proof: Bn254Proof; hints: Cell; claim: ExitClaim; value: bigint },
    ) {
        const claim = beginCell()
            .storeUint(opts.claim.l2Account, 160)
            .storeUint(opts.claim.amount, 128)
            .storeAddress(opts.claim.recipient)
            .endCell();
        const body = beginCell()
            .storeUint(RollupOpcodes.forceExit, 32)
            .storeUint(0, 64)
            .storeRef(Rollup.buildProofCell(opts.proof))
            .storeRef(opts.hints)
            .storeRef(claim)
            .endCell();
        await this.send(provider, via, opts.value, body);
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

    /** Удалить квитанции уже обработанных депозитов (не больше count за раз). */
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
     * Поставить транзакцию L2 в очередь L1 в обход секвенсора. `l2Transaction` — ячейка из
     * `forcedTransactionCell` (wrappers/rollupMath.ts): одна ячейка без ссылок.
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

    async getRollupState(provider: ContractProvider) {
        const { stack } = await provider.get('rollupState', []);
        return {
            stateRoot: stack.readBigNumber(),
            withdrawalsRoot: stack.readBigNumber(),
            batchIndex: stack.readNumber(),
        };
    }

    async getDepositQueue(
        provider: ContractProvider,
    ): Promise<{ head: QueueMark; target: QueueMark; processed: QueueMark }> {
        const { stack } = await provider.get('depositQueue', []);
        const mark = (): QueueMark => ({ count: stack.readBigNumber(), hash: stack.readBigNumber() });
        return { head: mark(), target: mark(), processed: mark() };
    }

    async getExpectedPublicInput(provider: ContractProvider, roots: BatchRoots): Promise<bigint> {
        const { stack } = await provider.get('expectedPublicInput', [
            { type: 'int', value: roots.newStateRoot },
            { type: 'int', value: roots.withdrawalsRoot },
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

    async getExitKeyHash(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('exitKeyHash', []);
        return stack.readBigNumber();
    }

    /** Заморожен ли rollup, когда встал самый старый необработанный депозит (0 — нет таких) и срок. */
    async getEscapeState(provider: ContractProvider) {
        const { stack } = await provider.get('escapeState', []);
        return { frozen: stack.readBoolean(), oldestPendingAt: stack.readNumber(), timeout: stack.readNumber() };
    }

    /** Публичный вход, который контракт потребует от пруфа выхода с такой заявкой. */
    async getExpectedExitInput(provider: ContractProvider, claim: ExitClaim): Promise<bigint> {
        const { stack } = await provider.get('expectedExitInput', [
            { type: 'int', value: claim.l2Account },
            { type: 'int', value: claim.amount },
            { type: 'int', value: BigInt('0x' + claim.recipient.hash.toString('hex')) },
        ]);
        return stack.readBigNumber();
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

    /** Плата за место в очереди L1 прямо сейчас и длина текущего окна. */
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

    /** Минимум монет для Withdraw и для ForceExit при текущих ценах сети. */
    async getMinimumValues(provider: ContractProvider) {
        const { stack } = await provider.get('minimumValues', []);
        return { withdraw: stack.readBigNumber(), forceExit: stack.readBigNumber() };
    }
}

/** Основание ключей нуллификатора аварийных выходов (EXIT_NULLIFIER_BASE в escape.tolk). */
export const EXIT_NULLIFIER_BASE = 1n << 255n;
export const exitNullifierKey = (l2Account: bigint): bigint => EXIT_NULLIFIER_BASE + l2Account;
