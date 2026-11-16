// Спайк агрегации: газ одной проверки пруфа Groth16 SP1 настоящим верификатором BN254
// (contracts/bn254_groth16_verifier.tolk) в Sandbox — так же, как tests/Bn254Verifier.spec.ts:
// развёртывание, ключ частями, фиксация, Verify одним internal-сообщением; затем «лучшая
// подделка» (честные подсказки для ложного дайджеста) обязана получить код wrongProof.
//
//   npx ts-node zkvm-evm/spike-aggregate/ton/verify-gas.ts <каталог> [<каталог> …]
//
// Каталоги — раскладка check-proof.mjs плюс onchain.json от gen-bn254-groth16-fixture.mjs --dir.
// Это НЕ rollup-контракт: газ батча в rollup-контракте больше на его собственную логику.
import { readFileSync } from 'fs';
import path from 'path';
import { Blockchain } from '@ton/sandbox';
import { Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import {
    Bn254Groth16Verifier,
    Bn254Proof,
    Bn254VerifierErrors,
    keyUploadFromJson,
    KeyUploadJson,
} from '../../../wrappers/Bn254Groth16Verifier';
import { computePhaseOf } from '../../../tests/helpers/gas';

type Hinted = {
    keyUpload: KeyUploadJson;
    hintsBoc: string;
    inputs: string[];
    forgery: { inputs: string[]; hintsBoc: string };
};

async function measure(directory: string, code: Cell) {
    const read = (file: string) => JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
    const raw = read('proof.json');
    const hinted = (read('onchain.json') as { hinted: Hinted }).hinted;
    const proof: Bn254Proof = {
        a: [BigInt(raw.pi_a[0]), BigInt(raw.pi_a[1])],
        b: [
            [BigInt(raw.pi_b[0][0]), BigInt(raw.pi_b[0][1])],
            [BigInt(raw.pi_b[1][0]), BigInt(raw.pi_b[1][1])],
        ],
        c: [BigInt(raw.pi_c[0]), BigInt(raw.pi_c[1])],
    };
    const inputs: [bigint, bigint] = [BigInt(hinted.inputs[0]), BigInt(hinted.inputs[1])];
    const key = keyUploadFromJson(hinted.keyUpload);

    const blockchain = await Blockchain.create();
    const sender = await blockchain.treasury('sender');
    const verifier = blockchain.openContract(Bn254Groth16Verifier.createFromConfig({ owner: sender.address }, code));
    await verifier.sendDeploy(sender.getSender(), toNano('1'));
    for (const { slot, part } of Bn254Groth16Verifier.keyParts(key)) {
        const upload = await verifier.sendUploadKeyPart(sender.getSender(), { slot, part, value: toNano('0.1') });
        if (!computePhaseOf(upload.transactions, verifier.address).success) throw new Error('часть ключа не принята');
    }
    await verifier.sendFinalizeKey(sender.getSender(), { key, value: toNano('0.1') });
    const snapshot = blockchain.snapshot();

    const result = await verifier.sendVerify(sender.getSender(), { proof, inputs, hints: Cell.fromBase64(hinted.hintsBoc), value: toNano('1') });
    const phase = computePhaseOf(result.transactions, verifier.address);
    const state = await verifier.getState();
    if (!phase.success || state.verifiedCount !== 1) throw new Error(`${directory}: пруф не принят (код ${phase.exitCode})`);

    await blockchain.loadFrom(snapshot);
    const forged = await verifier.sendVerify(sender.getSender(), {
        proof,
        inputs: [BigInt(hinted.forgery.inputs[0]), BigInt(hinted.forgery.inputs[1])],
        hints: Cell.fromBase64(hinted.forgery.hintsBoc),
        value: toNano('1'),
    });
    const forgedPhase = computePhaseOf(forged.transactions, verifier.address);
    if (forgedPhase.success || forgedPhase.exitCode !== Bn254VerifierErrors.wrongProof) {
        throw new Error(`${directory}: подделка не отклонена кодом ${Bn254VerifierErrors.wrongProof} (код ${forgedPhase.exitCode})`);
    }
    return {
        directory: path.basename(directory),
        gasUsed: Number(phase.gasUsed),
        forgeryExitCode: forgedPhase.exitCode,
        forgeryGasUsed: Number(forgedPhase.gasUsed),
    };
}

async function main() {
    const directories = process.argv.slice(2);
    if (directories.length === 0) throw new Error('нужен хотя бы один каталог');
    const code = await compile('Bn254Groth16Verifier');
    const results = [];
    for (const directory of directories) results.push(await measure(path.resolve(directory), code));
    console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
