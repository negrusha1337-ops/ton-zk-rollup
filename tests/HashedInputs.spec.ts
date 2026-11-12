import { createHash } from 'crypto';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { VerifierErrors, Groth16Verifier } from '../wrappers/Groth16Verifier';
import { HashedInputsVerifier, RollupValues } from '../wrappers/HashedInputsVerifier';
import { Fixture, loadFixture, readFixtureJson, terminateCurves } from './helpers/fixtures';
import { cellStats, computePhaseOf } from './helpers/gas';
import { saveBenchSection } from './helpers/benchResults';

const TX_GAS_LIMIT = 1_000_000;
const MASK_253 = (1n << 253n) - 1n;

/** То же, что делает контракт: sha256 от 4 × 32 байт (big-endian), обрезка до 253 бит. */
function hashRollupValues(values: RollupValues): bigint {
    const bytes = [values.oldStateRoot, values.newStateRoot, values.batchHash, values.withdrawalsRoot]
        .map((v) => v.toString(16).padStart(64, '0'))
        .join('');
    const digest = createHash('sha256').update(Buffer.from(bytes, 'hex')).digest('hex');
    return BigInt('0x' + digest) & MASK_253;
}

// Вариант «один публичный вход»: контракт сам хеширует четыре 256-битных
// значения rollup'а, схема доказывает тот же SHA-256 внутри.
describe('HashedInputs: один публичный вход = SHA-256 от значений rollup', () => {
    let code: Cell;
    let fixture: Fixture;
    let values: RollupValues;
    let blockchain: Blockchain;
    let sender: SandboxContract<TreasuryContract>;
    let verifier: SandboxContract<HashedInputsVerifier>;

    beforeAll(async () => {
        code = await compile('HashedInputsVerifier');
        fixture = await loadFixture('hash4');
        const preimage = readFixtureJson<Record<keyof RollupValues, string>>('hash4', 'preimage.json');
        values = {
            oldStateRoot: BigInt(preimage.oldStateRoot),
            newStateRoot: BigInt(preimage.newStateRoot),
            batchHash: BigInt(preimage.batchHash),
            withdrawalsRoot: BigInt(preimage.withdrawalsRoot),
        };
    });

    afterAll(terminateCurves);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        sender = await blockchain.treasury('sender');
        verifier = blockchain.openContract(HashedInputsVerifier.createFromCode(code));
        await verifier.sendDeploy(sender.getSender(), toNano('0.05'));
    });

    it('значения действительно 256-битные и не помещаются в поле без обрезки', () => {
        expect(Object.values(values).some((v) => v > MASK_253)).toBe(true);
    });

    it('контракт, JS и схема дают один и тот же публичный вход', async () => {
        const expected = hashRollupValues(values);
        const onChain = await verifier.getHashInputs(values);
        expect(onChain.hash).toBe(expected);
        expect(fixture.pubInputs).toEqual([expected]);
    });

    it('валидное доказательство проходит', async () => {
        expect(await verifier.getVerify(fixture.proof, values)).toBe(true);

        const result = await verifier.sendVerify(sender.getSender(), {
            proof: fixture.proof,
            values,
            value: toNano('0.15'),
        });
        expect(result.transactions).toHaveTransaction({ from: sender.address, to: verifier.address, success: true });
    });

    it.each(['oldStateRoot', 'newStateRoot', 'batchHash', 'withdrawalsRoot'] as const)(
        'отклоняет доказательство, если подменить %s',
        async (field) => {
            const forged = { ...values, [field]: values[field] ^ 1n };
            expect(await verifier.getVerify(fixture.proof, forged)).toBe(false);

            const result = await verifier.sendVerify(sender.getSender(), {
                proof: fixture.proof,
                values: forged,
                value: toNano('0.15'),
            });
            expect(result.transactions).toHaveTransaction({
                to: verifier.address,
                success: false,
                exitCode: VerifierErrors.wrongProof,
            });
        },
    );

    it('бенчмарк: газ полной проверки и отдельно хеширования', async () => {
        const result = await verifier.sendVerify(sender.getSender(), {
            proof: fixture.proof,
            values,
            value: toNano('1'),
        });
        const gasUsed = Number(computePhaseOf(result.transactions, verifier.address).gasUsed);
        expect(gasUsed).toBeLessThan(TX_GAS_LIMIT);

        // Газ get-метода, который делает только хеширование (включая вызов метода).
        const hashOnly = await verifier.getHashInputs(values);

        // Для сравнения — «голый» верификатор с одним входом на той же цепочке.
        const plainCode = await compile('VerifierPub1');
        const plainFixture = await loadFixture('pub1');
        const plain = blockchain.openContract(Groth16Verifier.createFromCode(plainCode));
        await plain.sendDeploy(sender.getSender(), toNano('0.05'));
        const plainResult = await plain.sendVerify(sender.getSender(), {
            proof: plainFixture.proof,
            pubInputs: plainFixture.pubInputs,
            value: toNano('1'),
        });
        const plainGas = Number(computePhaseOf(plainResult.transactions, plain.address).gasUsed);

        const codeSize = cellStats(code);
        const bodySize = cellStats(HashedInputsVerifier.buildVerifyBody(fixture.proof, values));
        saveBenchSection(
            'hashedSingleInput',
            [
                {
                    circuit: 'hash4',
                    publicInputs: 1,
                    gasUsed,
                    codeCells: codeSize.cells,
                    codeBits: codeSize.bits,
                    bodyCells: bodySize.cells,
                    bodyBits: bodySize.bits,
                    note: '4 значения по 256 бит хешируются в контракте (HASHEXT_SHA256), схема считает SHA-256',
                },
            ],
            {
                hashGetterGas: Number(hashOnly.gasUsed),
                plainSingleInputGas: plainGas,
                overheadVsPlainSingleInput: gasUsed - plainGas,
            },
        );
    });
});
