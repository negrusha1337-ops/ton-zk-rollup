import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { ProverJob } from '../../sequencer/prover';
import { blockOf, reportOf } from './rethChain';

// Заглушка сторожа прувера (zkvm-evm/host/prove-guarded.sh) для тестов LocalProver: вместо пруфа
// отдаёт готовый пруф SP1 блока цепочки Reth (fixtures/evm_batches/proof-reth-block<N>.json, N —
// из имени входа батча) либо выходит с кодом сторожа. Поведение — файл, который тест меняет:
//   codes  — коды выхода по запускам (0 — отдать пруф); кончились — 0;
//   hang   — не выходить до SIGTERM (тогда — код 130, как trap сторожа);
//   proofOf — номер блока, пруф которого отдать (чужой пруф);
//   corrupt — испортить одно число пруфа (публичные значения прежние);
//   spawnChild — запустить дочерний процесс с этой меткой в командной строке (живёт до 2 минут):
//               как прувер у настоящего сторожа (круг 21, пункт 4: сироты после остановки). С hang
//               на SIGTERM сторож ждёт выхода дочернего и только потом выходит с кодом 130 (как
//               настоящий: trap гасит прувер) — дочерний сам SIGTERM не получает, его даёт группа.
// Журнал запусков — runs.json: начало и конец каждого запуска, переменные шардов из окружения и
// WALLET_MNEMONIC, если она дошла до сторожа (круг 21, пункт 3: не должна).

const ROOT = path.join(__dirname, '..', '..');

export type FakeProverBehaviour = { codes?: number[]; hang?: boolean; proofOf?: number; corrupt?: boolean; delayMs?: number; spawnChild?: string };
export type FakeProverRun = { input: string; start: number; end?: number; code?: number; elementThreshold?: string; walletMnemonic?: string };

export function fakeProveScript(dir: string) {
    mkdirSync(dir, { recursive: true });
    const behaviourFile = path.join(dir, 'behaviour.json');
    const runsFile = path.join(dir, 'runs.json');
    const script = path.join(dir, 'prove-guarded.js');
    writeFileSync(
        script,
        `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const b = JSON.parse(fs.readFileSync(${JSON.stringify(behaviourFile)}, 'utf8'));
const runs = fs.existsSync(${JSON.stringify(runsFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(runsFile)}, 'utf8')) : [];
const run = { input: path.basename(arg('--batch-input')), start: Date.now(), elementThreshold: process.env.ELEMENT_THRESHOLD, walletMnemonic: process.env.WALLET_MNEMONIC };
runs.push(run);
const save = () => fs.writeFileSync(${JSON.stringify(runsFile)}, JSON.stringify(runs));
save();
const code = (b.codes || []).shift() ?? 0;
fs.writeFileSync(${JSON.stringify(behaviourFile)}, JSON.stringify(b));
const finish = (status) => { run.end = Date.now(); run.code = status; save(); process.exit(status); };
const child = b.spawnChild ? require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', b.spawnChild], { stdio: 'ignore' }) : null;
const childExited = child ? new Promise((resolve) => child.once('exit', resolve)) : Promise.resolve();
if (b.hang) { process.on('SIGTERM', () => childExited.then(() => finish(130))); setInterval(() => {}, 1000); return; }
setTimeout(() => {
  if (code !== 0) { process.stderr.write('[сторож] код ' + code + '\\n'); return finish(code); }
  const block = b.proofOf ?? Number(/block-(\\d+)\\.bin$/.exec(arg('--batch-input'))[1]);
  const proof = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(ROOT)}, 'fixtures', 'evm_batches', 'proof-reth-block' + block + '.json'), 'utf8'));
  if (b.corrupt) proof.proof = proof.proof.slice(0, -2) + (proof.proof.endsWith('00') ? '01' : '00');
  fs.writeFileSync(arg('--proof-out'), JSON.stringify(proof));
  finish(0);
}, b.delayMs ?? 50);
`,
    );
    chmodSync(script, 0o755);
    const behave = (behaviour: FakeProverBehaviour) => writeFileSync(behaviourFile, JSON.stringify(behaviour));
    behave({});
    const runs = (): FakeProverRun[] => (existsSync(runsFile) ? JSON.parse(readFileSync(runsFile, 'utf8')) : []);
    return { script, behave, runs };
}

/** Задание пруверу для блока N цепочки Reth (вход и отчёт — из fixtures/evm_batches/reth). */
export function rethJob(number: number): ProverJob {
    const report = reportOf(number);
    return {
        number,
        blockHash: blockOf(number).hash,
        batchInput: path.join(ROOT, 'fixtures', 'evm_batches', 'reth', `block-${number}.bin`),
        report: path.join(ROOT, 'fixtures', 'evm_batches', 'reth', `block-${number}.json`),
        publicValuesBytes: report.publicValuesBytes,
        programElfSha256: report.programElfSha256,
    };
}
