import { Blockchain } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Groth16Verifier } from '../wrappers/Groth16Verifier';
import { loadFixture, terminateCurves } from './helpers/fixtures';
import { cellStats, computePhaseOf } from './helpers/gas';
import { BenchRow, saveBenchSection } from './helpers/benchResults';

// Лимит газа на одну транзакцию: конфиг mainnet, параметры 20 и 21 (gas_limit).
const TX_GAS_LIMIT = 1_000_000;

// 1, 2, 4, 8, 16 — из задания; 32 и 64 — чтобы увидеть, где кончается запас.
const PUBLIC_INPUT_COUNTS = [1, 2, 4, 8, 16, 32, 64];

describe('Бенчмарк газа: Groth16-верификация по числу публичных входов', () => {
    const rows: BenchRow[] = [];

    afterAll(async () => {
        await terminateCurves();
        if (rows.length === PUBLIC_INPUT_COUNTS.length) {
            saveBenchSection('byPublicInputs', rows);
            console.table(
                rows.map(({ publicInputs, gasUsed, codeCells, codeBits }) => ({
                    publicInputs,
                    gasUsed,
                    codeCells,
                    codeBits,
                })),
            );
        }
    });

    it.each(PUBLIC_INPUT_COUNTS)('%i публичных входов: проверка проходит и укладывается в лимит', async (n) => {
        const circuit = `pub${n}`;
        const code = await compile(`VerifierPub${n}`);
        const fixture = await loadFixture(circuit);
        expect(fixture.pubInputs).toHaveLength(n);

        const blockchain = await Blockchain.create();
        const sender = await blockchain.treasury('sender');
        const verifier = blockchain.openContract(Groth16Verifier.createFromCode(code));
        await verifier.sendDeploy(sender.getSender(), toNano('0.05'));

        const result = await verifier.sendVerify(sender.getSender(), {
            proof: fixture.proof,
            pubInputs: fixture.pubInputs,
            value: toNano('1'),
        });
        expect(result.transactions).toHaveTransaction({ from: sender.address, to: verifier.address, success: true });

        // Контроль: тот же верификатор отклоняет изменённый последний вход.
        const forged = [...fixture.pubInputs.slice(0, -1), fixture.pubInputs[n - 1] + 1n];
        expect(await verifier.getVerify(fixture.proof, forged)).toBe(false);

        const gasUsed = Number(computePhaseOf(result.transactions, verifier.address).gasUsed);
        expect(gasUsed).toBeLessThan(TX_GAS_LIMIT);

        const codeSize = cellStats(code);
        const bodySize = cellStats(Groth16Verifier.buildVerifyBody(fixture.proof, fixture.pubInputs));
        rows.push({
            circuit,
            publicInputs: n,
            gasUsed,
            codeCells: codeSize.cells,
            codeBits: codeSize.bits,
            bodyCells: bodySize.cells,
            bodyBits: bodySize.bits,
        });
    });

    it('газ растёт монотонно с числом входов', () => {
        expect(rows).toHaveLength(PUBLIC_INPUT_COUNTS.length);
        const gas = rows.map((r) => r.gasUsed);
        expect(gas).toEqual([...gas].sort((a, b) => a - b));
    });
});
