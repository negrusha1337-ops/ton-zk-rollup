import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import * as snarkjs from 'snarkjs';
import { Groth16Verifier, VerifierErrors } from '../wrappers/Groth16Verifier';
import { BLS12_381_R, Fixture, loadFixture, terminateCurves } from './helpers/fixtures';

// Пример из документации TON: c = a * b, публичный сигнал один (c = 33).
describe('Multiplier: Groth16 (BLS12-381) верификатор', () => {
    let code: Cell;
    let fixture: Fixture;
    let blockchain: Blockchain;
    let sender: SandboxContract<TreasuryContract>;
    let verifier: SandboxContract<Groth16Verifier>;

    beforeAll(async () => {
        code = await compile('VerifierMultiplier');
        fixture = await loadFixture('multiplier');
    });

    afterAll(terminateCurves);

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        sender = await blockchain.treasury('sender');
        verifier = blockchain.openContract(Groth16Verifier.createFromCode(code));

        const deploy = await verifier.sendDeploy(sender.getSender(), toNano('0.05'));
        expect(deploy.transactions).toHaveTransaction({
            from: sender.address,
            to: verifier.address,
            deploy: true,
            success: true,
        });
    });

    it('фикстура корректна вне блокчейна (snarkjs)', async () => {
        const ok = await snarkjs.groth16.verify(
            fixture.raw.verificationKey,
            fixture.raw.publicSignals,
            fixture.raw.proof,
        );
        expect(ok).toBe(true);
        expect(fixture.pubInputs).toEqual([33n]);
    });

    it('валидное доказательство проходит (get-метод)', async () => {
        expect(await verifier.getVerify(fixture.proof, fixture.pubInputs)).toBe(true);
    });

    it('валидное доказательство проходит (internal-сообщение)', async () => {
        const result = await verifier.sendVerify(sender.getSender(), {
            proof: fixture.proof,
            pubInputs: fixture.pubInputs,
            value: toNano('0.15'),
        });
        expect(result.transactions).toHaveTransaction({ from: sender.address, to: verifier.address, success: true });
    });

    it('отклоняет чужой публичный вход', async () => {
        const forged = [34n];
        expect(await verifier.getVerify(fixture.proof, forged)).toBe(false);

        const result = await verifier.sendVerify(sender.getSender(), {
            proof: fixture.proof,
            pubInputs: forged,
            value: toNano('0.15'),
        });
        expect(result.transactions).toHaveTransaction({
            to: verifier.address,
            success: false,
            exitCode: VerifierErrors.wrongProof,
        });
    });

    it('отклоняет подменённую точку доказательства (валидная точка, но не та)', async () => {
        // pi_a — корректная точка G1, но на месте pi_c она ломает уравнение спаривания.
        const forged = { ...fixture.proof, pi_c: fixture.proof.pi_a };
        expect(await verifier.getVerify(forged, fixture.pubInputs)).toBe(false);

        const result = await verifier.sendVerify(sender.getSender(), {
            proof: forged,
            pubInputs: fixture.pubInputs,
            value: toNano('0.15'),
        });
        expect(result.transactions).toHaveTransaction({
            to: verifier.address,
            success: false,
            exitCode: VerifierErrors.wrongProof,
        });
    });

    it('отклоняет испорченные байты доказательства', async () => {
        const corrupted = Buffer.from(fixture.proof.pi_a);
        corrupted[20] ^= 0xff;
        const forged = { ...fixture.proof, pi_a: corrupted };

        await expect(verifier.getVerify(forged, fixture.pubInputs)).rejects.toThrow();

        const result = await verifier.sendVerify(sender.getSender(), {
            proof: forged,
            pubInputs: fixture.pubInputs,
            value: toNano('0.15'),
        });
        expect(result.transactions).toHaveTransaction({ to: verifier.address, success: false });
        expect(result.transactions).not.toHaveTransaction({ to: verifier.address, success: true });
    });

    it('отклоняет публичный вход вне поля (c + r даёт ту же точку, но не принимается)', async () => {
        const aliased = [fixture.pubInputs[0] + BLS12_381_R];
        const result = await verifier.sendVerify(sender.getSender(), {
            proof: fixture.proof,
            pubInputs: aliased,
            value: toNano('0.15'),
        });
        expect(result.transactions).toHaveTransaction({
            to: verifier.address,
            success: false,
            exitCode: VerifierErrors.invalidInputs,
        });
    });

    it('требует минимум 0.05 TON на проверку', async () => {
        const result = await verifier.sendVerify(sender.getSender(), {
            proof: fixture.proof,
            pubInputs: fixture.pubInputs,
            value: toNano('0.01'),
        });
        expect(result.transactions).toHaveTransaction({
            to: verifier.address,
            success: false,
            exitCode: VerifierErrors.notEnoughValue,
        });
    });
});
