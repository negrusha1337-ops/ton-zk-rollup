import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

/** Пруф Groth16 на BN254 в аффинных координатах (элементы Fp2 — пары [c0, c1]). */
export type Bn254Proof = {
    a: [bigint, bigint];
    b: [[bigint, bigint], [bigint, bigint]];
    c: [bigint, bigint];
};

/** Ключ верификации частями — поле hinted.keyUpload фикстуры (zk/gen-bn254-groth16-fixture.mjs). */
export type KeyUpload = {
    ic0: [bigint, bigint];
    alphaBeta: Cell;
    fixedLines: Cell;
    table0Parts: Cell[];
    table1Parts: Cell[];
};

export type KeyUploadJson = {
    ic0: string[];
    alphaBetaBoc: string;
    fixedLinesBoc: string;
    table0PartsBoc: string[];
    table1PartsBoc: string[];
};

export function keyUploadFromJson(json: KeyUploadJson): KeyUpload {
    return {
        ic0: [BigInt(json.ic0[0]), BigInt(json.ic0[1])],
        alphaBeta: Cell.fromBase64(json.alphaBetaBoc),
        fixedLines: Cell.fromBase64(json.fixedLinesBoc),
        table0Parts: json.table0PartsBoc.map((boc) => Cell.fromBase64(boc)),
        table1Parts: json.table1PartsBoc.map((boc) => Cell.fromBase64(boc)),
    };
}

export const Bn254VerifierOpcodes = {
    verifyProof: 0x42543234,
    uploadKeyPart: 0x42543235,
    finalizeKey: 0x42543236,
};

export const Bn254VerifierErrors = {
    wrongProof: 7100,
    unknownMessage: 7101,
    notOwner: 7102,
    keyAlreadyFinalized: 7103,
    keyNotFinalized: 7104,
    badKeyPart: 7105,
};

/** Номера частей ключа — как в контракте. */
export const KeySlots = {
    table0: 0,
    table1: 16,
    fixedLines: 32,
};

/** Обёртка над contracts/bn254_groth16_verifier.tolk. */
export class Bn254Groth16Verifier implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Bn254Groth16Verifier(address);
    }

    /** Контракт без ключа: ключ загружается частями и фиксируется владельцем. */
    static createFromConfig(config: { owner: Address }, code: Cell, workchain = 0) {
        const data = beginCell()
            .storeAddress(config.owner)
            .storeBit(false) // vkData: ещё нет
            .storeBit(false) // parts: пустой словарь
            .storeUint(0, 32)
            .storeUint(0, 256)
            .storeUint(0, 256)
            .endCell();
        const init = { code, data };
        return new Bn254Groth16Verifier(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    /** Все части ключа в порядке загрузки. */
    static keyParts(key: KeyUpload): { slot: number; part: Cell }[] {
        return [
            { slot: KeySlots.fixedLines, part: key.fixedLines },
            ...key.table0Parts.map((part, i) => ({ slot: KeySlots.table0 + i, part })),
            ...key.table1Parts.map((part, i) => ({ slot: KeySlots.table1 + i, part })),
        ];
    }

    static buildUploadBody(slot: number, part: Cell, queryId = 0n): Cell {
        return beginCell()
            .storeUint(Bn254VerifierOpcodes.uploadKeyPart, 32)
            .storeUint(queryId, 64)
            .storeUint(slot, 8)
            .storeRef(part)
            .endCell();
    }

    static buildFinalizeBody(key: KeyUpload, queryId = 0n): Cell {
        return beginCell()
            .storeUint(Bn254VerifierOpcodes.finalizeKey, 32)
            .storeUint(queryId, 64)
            .storeUint(key.ic0[0], 254)
            .storeUint(key.ic0[1], 254)
            .storeRef(key.alphaBeta)
            .storeUint(key.table0Parts.length, 8)
            .storeUint(key.table1Parts.length, 8)
            .endCell();
    }

    /** Ключ в собранном виде — то, что получится в контракте после фиксации. */
    static assembleKey(key: KeyUpload): Cell {
        const table = (parts: Cell[]) => {
            const root = beginCell();
            for (let i = 0; i < parts.length; i += 4) {
                root.storeRef(
                    parts
                        .slice(i, i + 4)
                        .reduce((node, part) => node.storeRef(part), beginCell())
                        .endCell(),
                );
            }
            return root.endCell();
        };
        return beginCell()
            .storeUint(key.ic0[0], 254)
            .storeUint(key.ic0[1], 254)
            .storeRef(key.alphaBeta)
            .storeRef(key.fixedLines)
            .storeRef(table(key.table0Parts))
            .storeRef(table(key.table1Parts))
            .endCell();
    }

    async sendUploadKeyPart(
        provider: ContractProvider,
        via: Sender,
        opts: { slot: number; part: Cell; value: bigint },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Bn254Groth16Verifier.buildUploadBody(opts.slot, opts.part),
        });
    }

    async sendFinalizeKey(provider: ContractProvider, via: Sender, opts: { key: KeyUpload; value: bigint }) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Bn254Groth16Verifier.buildFinalizeBody(opts.key),
        });
    }

    static buildVerifyBody(opts: { proof: Bn254Proof; inputs: [bigint, bigint]; hints: Cell; queryId?: bigint }): Cell {
        const { a, b, c } = opts.proof;
        const bCell = beginCell()
            .storeUint(b[0][0], 254)
            .storeUint(b[0][1], 254)
            .storeUint(b[1][0], 254)
            .storeUint(b[1][1], 254)
            .endCell();
        const proofCell = beginCell()
            .storeUint(a[0], 254)
            .storeUint(a[1], 254)
            .storeUint(c[0], 254)
            .storeUint(c[1], 254)
            .storeRef(bCell)
            .endCell();
        return beginCell()
            .storeUint(Bn254VerifierOpcodes.verifyProof, 32)
            .storeUint(opts.queryId ?? 0n, 64)
            .storeUint(opts.inputs[0], 256)
            .storeUint(opts.inputs[1], 256)
            .storeRef(proofCell)
            .storeRef(opts.hints)
            .endCell();
    }

    async sendVerify(
        provider: ContractProvider,
        via: Sender,
        opts: { proof: Bn254Proof; inputs: [bigint, bigint]; hints: Cell; value: bigint; queryId?: bigint },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Bn254Groth16Verifier.buildVerifyBody(opts),
        });
    }

    async getState(
        provider: ContractProvider,
    ): Promise<{ verifiedCount: number; lastInput0: bigint; lastInput1: bigint }> {
        const { stack } = await provider.get('verifierState', []);
        return {
            verifiedCount: stack.readNumber(),
            lastInput0: stack.readBigNumber(),
            lastInput1: stack.readBigNumber(),
        };
    }

    /** Хеш зафиксированного ключа; 0n, пока ключ не зафиксирован. */
    async getKeyHash(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('keyHash', []);
        return stack.readBigNumber();
    }

    async getHasKeyPart(provider: ContractProvider, slot: number): Promise<boolean> {
        const { stack } = await provider.get('hasKeyPart', [{ type: 'int', value: BigInt(slot) }]);
        return stack.readBoolean();
    }
}
