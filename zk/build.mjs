// Полная пересборка ZK-артефактов: Circom -> trusted setup (bls12-381) ->
// доказательство. Результат (verification_key.json, proof.json, public.json)
// кладётся в fixtures/<имя>/ и коммитится, чтобы `npx blueprint test`
// работал без Circom.
//
// Запуск:  node zk/build.mjs            — все схемы
//          node zk/build.mjs pub4 hash4 — только указанные
//
// ВНИМАНИЕ: trusted setup здесь одноучастниковый, со случайной энтропией,
// которая нигде не сохраняется. Это годится ТОЛЬКО для разработки и тестов.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { CIRCUITS } from './circuits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'circuits', 'build');
const FIXTURES = path.join(ROOT, 'fixtures');
const SNARKJS = path.join(ROOT, 'node_modules', '.bin', 'snarkjs');
const DEFAULT_CURVE = 'bls12-381';
/** Имя простого поля для circom по имени кривой snarkjs. */
const CIRCOM_PRIME = { 'bls12-381': 'bls12381', bn128: 'bn128' };

function findCircom() {
    const local = path.join(ROOT, '.tools', 'bin', 'circom');
    if (process.env.CIRCOM_BIN) return process.env.CIRCOM_BIN;
    return existsSync(local) ? local : 'circom';
}

function run(bin, args) {
    // В лог — относительные пути и без энтропии.
    const shown = args.map((a) => (a.startsWith('-e=') ? '-e=<random>' : a.replace(ROOT + path.sep, '')));
    console.log(`  $ ${path.basename(bin)} ${shown.join(' ')}`);
    try {
        execFileSync(bin, args, { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    } catch (err) {
        throw new Error(`Команда завершилась с ошибкой: ${path.basename(bin)} ${args[0]} (${err.message})`);
    }
}

const entropy = () => randomBytes(32).toString('hex');

/** Powers of Tau нужной степени; кешируется в circuits/build/ptau. */
function ensurePtau(power, curve) {
    const dir = path.join(BUILD, 'ptau');
    const tag = curve === DEFAULT_CURVE ? '' : `${curve}_`;
    const final = path.join(dir, `pot${tag}${power}_final.ptau`);
    if (existsSync(final)) return final;

    mkdirSync(dir, { recursive: true });
    const p0 = path.join(dir, `pot${tag}${power}_0000.ptau`);
    const p1 = path.join(dir, `pot${tag}${power}_0001.ptau`);
    console.log(`[ptau] ${curve}, степень ${power}`);
    run(SNARKJS, ['powersoftau', 'new', curve, String(power), p0]);
    run(SNARKJS, ['powersoftau', 'contribute', p0, p1, '--name=stage0-dev', `-e=${entropy()}`]);
    run(SNARKJS, ['powersoftau', 'prepare', 'phase2', p1, final]);
    return final;
}

/** Минимальная степень двойки, вмещающая схему (правило snarkjs groth16 setup). */
function requiredPower(r1csInfo) {
    const domain = r1csInfo.nConstraints + r1csInfo.nPubInputs + r1csInfo.nOutputs + 1;
    return Math.max(8, Math.ceil(Math.log2(domain)));
}

async function buildCircuit(circuit) {
    const dir = path.join(BUILD, circuit.name);
    mkdirSync(dir, { recursive: true });
    const curve = circuit.curve ?? DEFAULT_CURVE;
    console.log(`\n[${circuit.name}] (${curve})`);

    let source = circuit.sourceFile ? path.join(ROOT, circuit.sourceFile) : null;
    if (circuit.mainSource) {
        source = path.join(dir, `${circuit.name}.circom`);
        writeFileSync(source, circuit.mainSource);
    }
    const base = path.basename(source, '.circom');

    run(findCircom(), [
        source,
        '--r1cs',
        '--wasm',
        '--prime',
        CIRCOM_PRIME[curve],
        '-l',
        path.join(ROOT, 'node_modules'),
        '-o',
        dir,
    ]);

    const r1cs = path.join(dir, `${base}.r1cs`);
    const info = await snarkjs.r1cs.info(r1cs);
    const power = requiredPower(info);
    console.log(
        `  ограничений: ${info.nConstraints}, публичных сигналов: ${info.nPubInputs + info.nOutputs}, ptau: 2^${power}`,
    );

    const ptau = ensurePtau(power, curve);
    const zkey0 = path.join(dir, 'circuit_0000.zkey');
    const zkey = path.join(dir, 'circuit_final.zkey');
    run(SNARKJS, ['groth16', 'setup', r1cs, ptau, zkey0]);
    run(SNARKJS, ['zkey', 'contribute', zkey0, zkey, '--name=stage0-dev', `-e=${entropy()}`]);

    const out = path.join(FIXTURES, circuit.name);
    mkdirSync(out, { recursive: true });
    const vkey = path.join(out, 'verification_key.json');
    const proof = path.join(out, 'proof.json');
    const pub = path.join(out, 'public.json');
    const input = path.join(dir, 'input.json');
    writeFileSync(input, JSON.stringify(circuit.input));

    run(SNARKJS, ['zkey', 'export', 'verificationkey', zkey, vkey]);
    run(SNARKJS, ['groth16', 'fullprove', input, path.join(dir, `${base}_js`, `${base}.wasm`), zkey, proof, pub]);
    run(SNARKJS, ['groth16', 'verify', vkey, pub, proof]);

    writeFileSync(
        path.join(out, 'meta.json'),
        JSON.stringify(
            {
                circuit: circuit.name,
                curve,
                constraints: info.nConstraints,
                publicSignals: info.nPubInputs + info.nOutputs,
                ptauPower: power,
            },
            null,
            2,
        ) + '\n',
    );
    for (const [file, content] of Object.entries(circuit.extraFixture ?? {})) {
        writeFileSync(path.join(out, file), JSON.stringify(content, null, 2) + '\n');
    }
}

const wanted = process.argv.slice(2);
const selected = wanted.length ? CIRCUITS.filter((c) => wanted.includes(c.name)) : CIRCUITS;
const unknown = wanted.filter((w) => !CIRCUITS.some((c) => c.name === w));
if (unknown.length) {
    console.error(`Неизвестные схемы: ${unknown.join(', ')}. Доступны: ${CIRCUITS.map((c) => c.name).join(', ')}`);
    process.exit(1);
}

try {
    for (const circuit of selected) {
        await buildCircuit(circuit);
    }
    console.log('\nГотово. Дальше: npm run zk:verifiers');
    process.exit(0); // snarkjs держит воркеры кривой, выходим явно
} catch (err) {
    console.error(`\nСборка прервана: ${err.message}`);
    process.exit(1);
}
