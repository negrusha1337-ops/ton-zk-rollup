import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    TupleBuilder,
} from '@ton/core';
import { CompressedProof, proofToCell } from './Groth16Verifier';

/** Четыре 256-битных публичных значения rollup'а. */
export type RollupValues = {
    oldStateRoot: bigint;
    newStateRoot: bigint;
    batchHash: bigint;
    withdrawalsRoot: bigint;
};

export const HashedVerifierOpcodes = {
    verifyHashed: 0x5a4b0001,
};

/** Обёртка над contracts/hashed_inputs_verifier.tolk. */
export class HashedInputsVerifier implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromCode(code: Cell, workchain = 0) {
        const init = { code, data: beginCell().endCell() };
        return new HashedInputsVerifier(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    static buildVerifyBody(proof: CompressedProof, values: RollupValues): Cell {
        // 4 × 256 бит в одну ячейку не помещаются, поэтому вторая пара — по ссылке.
        const commitments = beginCell()
            .storeUint(values.batchHash, 256)
            .storeUint(values.withdrawalsRoot, 256)
            .endCell();

        return beginCell()
            .storeUint(HashedVerifierOpcodes.verifyHashed, 32)
            .storeRef(proofToCell(proof))
            .storeUint(values.oldStateRoot, 256)
            .storeUint(values.newStateRoot, 256)
            .storeRef(commitments)
            .endCell();
    }

    async sendVerify(
        provider: ContractProvider,
        via: Sender,
        opts: { proof: CompressedProof; values: RollupValues; value: bigint },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: HashedInputsVerifier.buildVerifyBody(opts.proof, opts.values),
        });
    }

    private static valuesToTuple(args: TupleBuilder, values: RollupValues) {
        args.writeNumber(values.oldStateRoot);
        args.writeNumber(values.newStateRoot);
        args.writeNumber(values.batchHash);
        args.writeNumber(values.withdrawalsRoot);
    }

    /** Возвращает хеш и газ, потраченный get-методом (для бенчмарка хеширования). */
    async getHashInputs(provider: ContractProvider, values: RollupValues): Promise<{ hash: bigint; gasUsed: bigint }> {
        const args = new TupleBuilder();
        HashedInputsVerifier.valuesToTuple(args, values);
        const result = await provider.get('hashInputs', args.build());
        return { hash: result.stack.readBigNumber(), gasUsed: result.gasUsed ?? 0n };
    }

    async getVerify(provider: ContractProvider, proof: CompressedProof, values: RollupValues): Promise<boolean> {
        const args = new TupleBuilder();
        args.writeSlice(beginCell().storeBuffer(proof.pi_a).endCell());
        args.writeSlice(beginCell().storeBuffer(proof.pi_b).endCell());
        args.writeSlice(beginCell().storeBuffer(proof.pi_c).endCell());
        HashedInputsVerifier.valuesToTuple(args, values);
        const result = await provider.get('verify', args.build());
        return result.stack.readBoolean();
    }
}
