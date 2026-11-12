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

/** Сжатое доказательство Groth16 в формате, который ждёт TVM (48/96 байт на точку). */
export type CompressedProof = {
    pi_a: Buffer;
    pi_b: Buffer;
    pi_c: Buffer;
};

export const VerifierOpcodes = {
    verify: 0x3b3cca17,
};

/** Коды ошибок сгенерированного верификатора (enum VerifierErrors в .tolk). */
export const VerifierErrors = {
    invalidInputs: 258,
    wrongProof: 260,
    notEnoughValue: 261,
};

/** Ячейка с тремя ссылками piA, piB, piC — формат export-ton-verifier. */
export function proofToCell(proof: CompressedProof): Cell {
    return beginCell()
        .storeRef(beginCell().storeBuffer(proof.pi_a).endCell())
        .storeRef(beginCell().storeBuffer(proof.pi_b).endCell())
        .storeRef(beginCell().storeBuffer(proof.pi_c).endCell())
        .endCell();
}

/**
 * Публичные входы для internal-сообщения: uint8 длина, затем int257 по три
 * на ячейку, ячейки связаны ссылками (так Tolk сериализует array<int>).
 */
export function publicInputsToCell(inputs: bigint[]): Cell {
    if (inputs.length > 255) {
        throw new Error(`Tolk-верификатор принимает не более 255 публичных входов, получено ${inputs.length}`);
    }

    const chunks: bigint[][] = [];
    for (let i = 0; i < inputs.length; i += 3) {
        chunks.push(inputs.slice(i, i + 3));
    }

    const tail = chunks.reduceRight<Cell | null>((next, chunk) => {
        const cell = chunk.reduce((b, value) => b.storeInt(value, 257), beginCell());
        return (next ? cell.storeRef(next) : cell).endCell();
    }, null);

    const root = beginCell().storeUint(inputs.length, 8);
    return (tail ? root.storeSlice(tail.beginParse()) : root).endCell();
}

/**
 * Обёртка над самостоятельным верификатором, который генерирует
 * export-ton-verifier (режим Tolk + Groth16). Одна на все схемы: отличается
 * только код контракта.
 */
export class Groth16Verifier implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Groth16Verifier(address);
    }

    static createFromCode(code: Cell, workchain = 0) {
        const init = { code, data: beginCell().endCell() };
        return new Groth16Verifier(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    static buildVerifyBody(proof: CompressedProof, pubInputs: bigint[]): Cell {
        return beginCell()
            .storeUint(VerifierOpcodes.verify, 32)
            .storeRef(proofToCell(proof))
            .storeRef(publicInputsToCell(pubInputs))
            .endCell();
    }

    async sendVerify(
        provider: ContractProvider,
        via: Sender,
        opts: { proof: CompressedProof; pubInputs: bigint[]; value: bigint },
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: Groth16Verifier.buildVerifyBody(opts.proof, opts.pubInputs),
        });
    }

    async getVerify(provider: ContractProvider, proof: CompressedProof, pubInputs: bigint[]): Promise<boolean> {
        const inputs = new TupleBuilder();
        for (const value of pubInputs) {
            inputs.writeNumber(value);
        }

        const args = new TupleBuilder();
        args.writeSlice(beginCell().storeBuffer(proof.pi_a).endCell());
        args.writeSlice(beginCell().storeBuffer(proof.pi_b).endCell());
        args.writeSlice(beginCell().storeBuffer(proof.pi_c).endCell());
        args.writeTuple(inputs.build());

        const result = await provider.get('verify', args.build());
        return result.stack.readBoolean();
    }
}
