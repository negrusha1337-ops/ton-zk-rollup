import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import {
    Bn254Groth16Verifier,
    Bn254Proof,
    Bn254VerifierErrors,
    KeySlots,
    KeyUploadJson,
    keyUploadFromJson,
} from '../wrappers/Bn254Groth16Verifier';
import { cellStats, computePhaseOf } from './helpers/gas';

jest.setTimeout(120_000);

// Лимит газа на транзакцию: конфиг mainnet, параметр 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;

function saveVerifierBench(directory: string, data: Record<string, number>) {
    const file = path.join(__dirname, '..', 'bench', `bn254-verifier-transaction-${directory}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
        file,
        JSON.stringify(
            {
                source: 'Измерено в @ton/sandbox тестом tests/Bn254Verifier.spec.ts; не редактировать вручную',
                note: `Полная транзакция: internal-сообщение с пруфом (${directory}) и подсказками, проверка и запись состояния`,
                ...data,
            },
            null,
            2,
        ) + '\n',
    );
}

// Полная транзакция: пруф zkVM и подсказки приходят internal-сообщением,
// контракт проверяет пруф и обновляет своё состояние.
describe.each([
    { name: 'SP1 v6', directory: 'sp1_v6_fibonacci' },
    { name: 'RISC Zero', directory: 'risc0_v3_test_receipt' },
])('Bn254Groth16Verifier: пруф $name в одной транзакции', ({ name, directory }) => {
    const fixture = (file: string) =>
        JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', directory, file), 'utf8'));
    const raw = fixture('proof.json');
    const hinted = (
        fixture('onchain.json') as {
            hinted: {
                vkDataBoc: string;
                keyUpload: KeyUploadJson;
                hintsBoc: string;
                inputs: string[];
                forgery: { inputs: string[]; hintsBoc: string };
            };
        }
    ).hinted;
    const proof: Bn254Proof = {
        a: [BigInt(raw.pi_a[0]), BigInt(raw.pi_a[1])],
        b: [
            [BigInt(raw.pi_b[0][0]), BigInt(raw.pi_b[0][1])],
            [BigInt(raw.pi_b[1][0]), BigInt(raw.pi_b[1][1])],
        ],
        c: [BigInt(raw.pi_c[0]), BigInt(raw.pi_c[1])],
    };
    const inputs: [bigint, bigint] = [BigInt(hinted.inputs[0]), BigInt(hinted.inputs[1])];
    const hints = Cell.fromBase64(hinted.hintsBoc);
    const key = keyUploadFromJson(hinted.keyUpload);
    let keyStats: Record<string, number> = {};

    let code: Cell;
    let blockchain: Blockchain;
    let sender: SandboxContract<TreasuryContract>;
    let verifier: SandboxContract<Bn254Groth16Verifier>;

    let ready: BlockchainSnapshot;

    // Развёртывание и загрузка ключа выполняются один раз; каждый тест стартует с этого снимка.
    beforeAll(async () => {
        code = await compile('Bn254Groth16Verifier');
        blockchain = await Blockchain.create();
        sender = await blockchain.treasury('sender');
        verifier = blockchain.openContract(Bn254Groth16Verifier.createFromConfig({ owner: sender.address }, code));
        const deploy = await verifier.sendDeploy(sender.getSender(), toNano('1'));
        expect(deploy.transactions).toHaveTransaction({ to: verifier.address, deploy: true, success: true });

        // Ключ загружается так же, как это будет в сети: частями, каждая — отдельным сообщением.
        let uploadGas = 0;
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key)) {
            const upload = await verifier.sendUploadKeyPart(sender.getSender(), { slot, part, value: toNano('0.1') });
            expect(upload.transactions).toHaveTransaction({ to: verifier.address, success: true });
            uploadGas += Number(computePhaseOf(upload.transactions, verifier.address).gasUsed);
        }
        const finalize = await verifier.sendFinalizeKey(sender.getSender(), { key, value: toNano('0.1') });
        expect(finalize.transactions).toHaveTransaction({ to: verifier.address, success: true });
        keyStats.uploadGasTotal = uploadGas + Number(computePhaseOf(finalize.transactions, verifier.address).gasUsed);
        ready = blockchain.snapshot();
    });

    beforeEach(async () => {
        await blockchain.loadFrom(ready);
    });

    it('ключ собирается из частей, и каждая часть проходит в одно сообщение кошелька', async () => {
        // Собранный контрактом ключ обязан совпасть с тем, под который строились подсказки:
        // его хеш входит в транскрипт проверки.
        const expected = Cell.fromBase64(hinted.vkDataBoc);
        expect(Bn254Groth16Verifier.assembleKey(key).hash().equals(expected.hash())).toBe(true);
        expect(await verifier.getKeyHash()).toBe(BigInt('0x' + expected.hash().toString('hex')));
        expect(await verifier.getHasKeyPart(KeySlots.fixedLines)).toBe(false); // части удалены после фиксации

        // Внешнее сообщение кошелька ограничено 64 КБ (конфиг-параметр 43, max_ext_msg_size).
        const sizes = Bn254Groth16Verifier.keyParts(key).map(
            ({ slot, part }) => Bn254Groth16Verifier.buildUploadBody(slot, part).toBoc().length,
        );
        expect(Math.max(...sizes)).toBeLessThan(48 * 1024);
        keyStats = {
            ...keyStats,
            parts: sizes.length,
            largestPartBytes: Math.max(...sizes),
            totalBytes: sizes.reduce((a, b) => a + b, 0),
        };
    });

    it('чужой не может загружать ключ, а после фиксации его нельзя менять', async () => {
        const stranger = await blockchain.treasury('stranger');
        const fresh = blockchain.openContract(Bn254Groth16Verifier.createFromConfig({ owner: stranger.address }, code));
        await fresh.sendDeploy(sender.getSender(), toNano('1'));
        const foreign = await fresh.sendUploadKeyPart(sender.getSender(), {
            slot: KeySlots.fixedLines,
            part: key.fixedLines,
            value: toNano('0.1'),
        });
        expect(foreign.transactions).toHaveTransaction({
            to: fresh.address,
            success: false,
            exitCode: Bn254VerifierErrors.notOwner,
        });
        // Без ключа пруфы не принимаются.
        const early = await fresh.sendVerify(sender.getSender(), { proof, inputs, hints, value: toNano('1') });
        expect(early.transactions).toHaveTransaction({
            to: fresh.address,
            success: false,
            exitCode: Bn254VerifierErrors.keyNotFinalized,
        });

        const late = await verifier.sendUploadKeyPart(sender.getSender(), {
            slot: KeySlots.fixedLines,
            part: key.fixedLines,
            value: toNano('0.1'),
        });
        expect(late.transactions).toHaveTransaction({
            to: verifier.address,
            success: false,
            exitCode: Bn254VerifierErrors.keyAlreadyFinalized,
        });
    });

    it('принимает настоящий пруф и укладывается в лимит газа транзакции', async () => {
        const result = await verifier.sendVerify(sender.getSender(), { proof, inputs, hints, value: toNano('1') });
        const phase = computePhaseOf(result.transactions, verifier.address);
        const body = cellStats(Bn254Groth16Verifier.buildVerifyBody({ proof, inputs, hints }));
        console.table({
            пруф: name,
            'газ транзакции': Number(phase.gasUsed),
            'запас до лимита': TX_GAS_LIMIT - Number(phase.gasUsed),
            'ячеек в сообщении': body.cells,
            'бит в сообщении': body.bits,
            'ячеек кода': cellStats(code).cells,
            'ячеек ключа': cellStats(Cell.fromBase64(hinted.vkDataBoc)).cells,
        });
        saveVerifierBench(directory, {
            gasUsed: Number(phase.gasUsed),
            gasLimit: TX_GAS_LIMIT,
            messageCells: body.cells,
            messageBits: body.bits,
            codeCells: cellStats(code).cells,
            keyCells: cellStats(Cell.fromBase64(hinted.vkDataBoc)).cells,
            ...keyStats,
        });

        expect(result.transactions).toHaveTransaction({ from: sender.address, to: verifier.address, success: true });
        expect(Number(phase.gasUsed)).toBeLessThan(TX_GAS_LIMIT);
        expect(await verifier.getState()).toEqual({ verifiedCount: 1, lastInput0: inputs[0], lastInput1: inputs[1] });
    });

    it('отклоняет пруф с другим дайджестом и не меняет состояние', async () => {
        const result = await verifier.sendVerify(sender.getSender(), {
            proof,
            inputs: [inputs[0] ^ 1n, inputs[1]],
            hints,
            value: toNano('1'),
        });
        // Наклоны сложений в подсказках посчитаны для настоящего дайджеста, поэтому
        // подделка ловится уже на первом сложении (7006), не доходя до итогового равенства.
        expect(result.transactions).toHaveTransaction({ to: verifier.address, success: false, exitCode: 7006 });
        expect((await verifier.getState()).verifiedCount).toBe(0);
    });

    it('отклоняет испорченное частное кодом WrongProof', async () => {
        // Частное bigQ не проверяется по дороге — только итоговым равенством.
        const refs = [...hints.refs];
        const chain = refs[3].beginParse();
        const first = chain.loadUintBig(254);
        refs[3] = beginCell()
            .storeUint(first ^ 1n, 254)
            .storeSlice(chain)
            .endCell();
        const forged = refs.reduce((builder, cell) => builder.storeRef(cell), beginCell()).endCell();

        const result = await verifier.sendVerify(sender.getSender(), {
            proof,
            inputs,
            hints: forged,
            value: toNano('1'),
        });
        expect(result.transactions).toHaveTransaction({
            to: verifier.address,
            success: false,
            exitCode: Bn254VerifierErrors.wrongProof,
        });
        expect((await verifier.getState()).verifiedCount).toBe(0);
    });

    it('отклоняет «лучшую подделку» для другого дайджеста кодом WrongProof', async () => {
        // Подсказки честно посчитаны для ложного утверждения (тот же пруф, другой дайджест):
        // все промежуточные проверки проходят, не сходится только итоговое равенство.
        const forgedInputs: [bigint, bigint] = [BigInt(hinted.forgery.inputs[0]), BigInt(hinted.forgery.inputs[1])];
        expect(forgedInputs[0]).not.toBe(inputs[0]);

        const result = await verifier.sendVerify(sender.getSender(), {
            proof,
            inputs: forgedInputs,
            hints: Cell.fromBase64(hinted.forgery.hintsBoc),
            value: toNano('1'),
        });
        expect(result.transactions).toHaveTransaction({
            to: verifier.address,
            success: false,
            exitCode: Bn254VerifierErrors.wrongProof,
        });
        expect((await verifier.getState()).verifiedCount).toBe(0);
    });
});
