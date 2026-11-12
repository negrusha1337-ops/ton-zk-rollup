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
    publishData: 0x52420003,
    withdraw: 0x52420004,
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
};

export const NullifierErrors = {
    notRollup: 7200,
    alreadyClaimed: 7201,
};

export type RollupConfig = {
    owner: Address;
    sequencer: Address;
    nullifierCode: Cell;
    genesisStateRoot: bigint;
};

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
            .endCell();
        const data = beginCell()
            .storeAddress(config.owner)
            .storeAddress(config.sequencer)
            .storeBit(false) // vkData: ещё нет
            .storeBit(false) // keyParts: пустой словарь
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
        const slice = data.beginParse();
        slice.loadAddress(); // owner
        slice.loadAddress(); // sequencer
        slice.loadMaybeRef(); // vkData
        return slice.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Cell()).keys();
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

    static buildSubmitBatchBody(opts: { proof: Bn254Proof; hints: Cell; roots: BatchRoots; nonce?: bigint }): Cell {
        const roots = beginCell()
            .storeUint(opts.roots.newStateRoot, 256)
            .storeUint(opts.roots.withdrawalsRoot, 256)
            .endCell();
        return beginCell()
            .storeUint(RollupOpcodes.submitBatch, 32)
            .storeUint(0, 64)
            .storeUint(opts.nonce ?? 0n, 256)
            .storeRef(Rollup.buildProofCell(opts.proof))
            .storeRef(opts.hints)
            .storeRef(roots)
            .endCell();
    }

    async sendSubmitBatch(
        provider: ContractProvider,
        via: Sender,
        opts: { proof: Bn254Proof; hints: Cell; roots: BatchRoots; nonce?: bigint; value: bigint },
    ) {
        await this.send(provider, via, opts.value, Rollup.buildSubmitBatchBody(opts));
    }

    /**
     * Порция данных батча (data availability). `data` — цепочка ячеек из
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

    /** Депозит TON: на L2 зачтётся приложенная сумма минус комиссия 0,01 TON. */
    async sendDeposit(provider: ContractProvider, via: Sender, opts: { l2Recipient: bigint; value: bigint }) {
        const body = beginCell()
            .storeUint(RollupOpcodes.depositTon, 32)
            .storeUint(0, 64)
            .storeUint(opts.l2Recipient, 160)
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

    async getKeyHash(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('keyHash', []);
        return stack.readBigNumber();
    }

    async getNullifierAddress(provider: ContractProvider, leafIndex: number): Promise<Address> {
        const { stack } = await provider.get('nullifierAddress', [{ type: 'int', value: BigInt(leafIndex) }]);
        return stack.readAddress();
    }
}
