import { readFileSync } from 'fs';
import path from 'path';
import { groth16CompressProof } from 'export-ton-verifier';
import type { Groth16Proof } from 'snarkjs';
import { CompressedProof } from '../../wrappers/Groth16Verifier';

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'fixtures');

/** Порядок скалярного поля BLS12-381 (r). Публичные входы обязаны быть меньше. */
export const BLS12_381_R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

export type Fixture = {
    proof: CompressedProof;
    pubInputs: bigint[];
    /** Исходные JSON snarkjs — для локальной проверки. */
    raw: { proof: Groth16Proof; publicSignals: string[]; verificationKey: Record<string, unknown> };
};

export function readFixtureJson<T>(circuit: string, file: string): T {
    const fullPath = path.join(FIXTURES_DIR, circuit, file);
    try {
        return JSON.parse(readFileSync(fullPath, 'utf8')) as T;
    } catch (err) {
        throw new Error(
            `Не удалось прочитать ${fullPath}: ${(err as Error).message}. ` +
                `Фикстуры собираются командой "npm run zk:build".`,
        );
    }
}

/** Загружает доказательство схемы и сжимает точки в формат TVM. */
export async function loadFixture(circuit: string): Promise<Fixture> {
    const proof = readFixtureJson<Groth16Proof>(circuit, 'proof.json');
    const publicSignals = readFixtureJson<string[]>(circuit, 'public.json');
    const verificationKey = readFixtureJson<Record<string, unknown>>(circuit, 'verification_key.json');

    const compressed = await groth16CompressProof({ ...proof }, publicSignals);
    return {
        proof: { pi_a: compressed.pi_a, pi_b: compressed.pi_b, pi_c: compressed.pi_c },
        pubInputs: compressed.pubInputs,
        raw: { proof, publicSignals, verificationKey },
    };
}

/**
 * snarkjs держит пул воркеров кривой в глобальной переменной; без явной
 * остановки Jest не завершается.
 */
export async function terminateCurves(): Promise<void> {
    const curve = (globalThis as Record<string, unknown>).curve_bls12381 as
        { terminate?: () => Promise<void> } | undefined;
    await curve?.terminate?.();
}
