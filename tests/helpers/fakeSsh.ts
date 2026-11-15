import { createHash } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

// Подставной сервер с GPU для тестов RemoteProver (sequencer/remoteProver.ts) — без сервера и
// без сети. Команды ssh и scp — скрипты-обёртки: ssh исполняет команду локально (bash -c) в
// домашнем каталоге «сервера», scp копирует, переводя «хост:путь» в путь внутри него. На
// «сервере» — настоящие zkvm-evm/host/remote/prove-job.sh и lib.sh (как после push.sh), ELF с мака,
// program.json, prover-shards.env, remote-out/env.sh (как после setup.sh) и подставной хост: вместо
// пруфа он отдаёт готовый пруф SP1 блока цепочки Reth (fixtures/evm_batches/proof-reth-block<N>.json,
// N — по sha256 входа). setsid, timeout (GNU) и nvidia-smi — тоже обёртки: на маке их нет.
//
// Поведение — файлы, которые тест меняет:
//   net.json  — { down?: true, dropNext?: n, dropAfterStart?: n, dropStartReply?: true }: ssh
//               отвечает 255 и scp — 1 («нет связи»); dropAfterStart — n обрывов сразу после первой
//               дошедшей команды start; dropStartReply — start исполнен, а ответ потерян (один раз);
//   host.json — { proofOf?: N (чужой пруф), hang?: true, delayMs?: мс, failRuns?: n (первые n
//               запусков пруфа — код failCode, по умолчанию 1) }.
// Журналы: calls.json — команды ssh и scp (строка JSON на вызов); host-runs.json — запуски хоста (строки: начало с аргументами, конец с кодом).

const ROOT = path.join(__dirname, '..', '..');
export const MAC_ELF = path.join(ROOT, 'zkvm-evm', 'program', 'target', 'elf-compilation', 'riscv64im-succinct-zkvm-elf', 'release', 'rollup-evm-program');

export type NetBehaviour = { down?: boolean; dropNext?: number; dropAfterStart?: number; dropStartReply?: boolean };
export type HostBehaviour = { proofOf?: number; hang?: boolean; delayMs?: number; failRuns?: number; failCode?: number };
export type SshCall = { tool: 'ssh' | 'scp'; args: string[]; dropped: boolean };
export type HostRun = { args: string[]; pid: number; start: number; end?: number; code?: number };

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function fakeGpuServer(root: string, options: { elf?: string; gpu?: boolean; host?: boolean } = {}) {
    const home = path.join(root, 'server-home');
    const set = path.join(home, 'ton-zk-rollup');
    const bin = path.join(root, 'bin');
    const gpuBin = path.join(root, 'gpu-bin');
    for (const dir of [bin, gpuBin, path.join(set, 'zkvm-evm', 'host', 'remote'), path.join(set, 'remote-out'), path.join(set, 'remote-input'), path.join(set, 'fixtures', 'evm_batches'), path.join(set, 'zkvm-evm', 'target', 'release')])
        mkdirSync(dir, { recursive: true });
    for (const name of ['prove-job.sh', 'lib.sh']) copyFileSync(path.join(ROOT, 'zkvm-evm', 'host', 'remote', name), path.join(set, 'zkvm-evm', 'host', 'remote', name));
    copyFileSync(path.join(ROOT, 'zkvm-evm', 'host', 'prover-shards.env'), path.join(set, 'zkvm-evm', 'host', 'prover-shards.env'));
    copyFileSync(path.join(ROOT, 'fixtures', 'evm_batches', 'program.json'), path.join(set, 'fixtures', 'evm_batches', 'program.json'));
    writeFileSync(path.join(set, 'remote-out', 'env.sh'), '# подставной setup.sh\n');
    const elf = path.join(set, 'remote-input', 'rollup-evm-program.elf');
    if (options.elf === undefined) copyFileSync(MAC_ELF, elf);
    else writeFileSync(elf, options.elf);

    const netFile = path.join(root, 'net.json');
    const hostFile = path.join(root, 'host.json');
    const callsFile = path.join(root, 'calls.json');
    const runsFile = path.join(root, 'host-runs.json');
    const blocks = Object.fromEntries(
        [1, 2, 3, 4, 5]
            .map((n) => [n, path.join(ROOT, 'fixtures', 'evm_batches', 'reth', `block-${n}.bin`)] as const)
            .filter(([, file]) => existsSync(file))
            .map(([n, file]) => [sha256(file), n]),
    );
    const journal = (file: string) => `
const journal = (entry) => fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify(entry) + '\\n');`;
    // Обрыв связи: down — всегда; dropNext — следующие n вызовов; dropAfterStart — после первой start.
    const network = `
const net = fs.existsSync(${JSON.stringify(netFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(netFile)}, 'utf8')) : {};
let dropped = Boolean(net.down);
if (!dropped && net.dropNext > 0) { net.dropNext--; dropped = true; fs.writeFileSync(${JSON.stringify(netFile)}, JSON.stringify(net)); }`;
    const ssh = path.join(bin, 'ssh');
    writeFileSync(
        ssh,
        `#!/usr/bin/env node
const fs = require('fs'); const { spawnSync } = require('child_process');
${journal(callsFile)}
${network}
const args = process.argv.slice(2);
let i = 0;
while (i < args.length) { if (args[i] === '-o') { i += 2; continue; } if (args[i] === '--') { i++; break; } if (args[i].startsWith('-')) { i++; continue; } break; }
const command = args.slice(i + 1).join(' ');
journal({ tool: 'ssh', args: [args[i], command], dropped });
if (dropped) { process.stderr.write('ssh: connect to host ' + args[i] + ': Connection refused (подставной обрыв)\\n'); process.exit(255); }
const gpu = ${options.gpu === false ? 'false' : 'true'};
const PATH = [${JSON.stringify(bin)}, ...(gpu ? [${JSON.stringify(gpuBin)}] : []), process.env.PATH, '/usr/sbin', '/sbin'].join(':');
const run = spawnSync('bash', ['-c', command], { cwd: ${JSON.stringify(home)}, env: { ...process.env, HOME: ${JSON.stringify(home)}, PATH, CANCEL_GRACE_SECONDS: '2' }, stdio: 'inherit' });
// Ответ на start потерян: команда на сервере исполнена, а ssh вернул обрыв (один раз).
if (/ start /.test(' ' + command + ' ') && net.dropStartReply) { net.dropStartReply = false; fs.writeFileSync(${JSON.stringify(netFile)}, JSON.stringify(net)); process.exit(255); }
if (/ start /.test(' ' + command + ' ') && net.dropAfterStart > 0) { net.dropNext = net.dropAfterStart; net.dropAfterStart = 0; fs.writeFileSync(${JSON.stringify(netFile)}, JSON.stringify(net)); }
process.exit(run.status ?? 1);
`,
    );
    const scp = path.join(bin, 'scp');
    writeFileSync(
        scp,
        `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
${journal(callsFile)}
${network}
const args = process.argv.slice(2).filter((arg, index, all) => !(arg === '-o' || all[index - 1] === '-o' || arg === '-q' || arg === '--'));
journal({ tool: 'scp', args, dropped });
if (dropped) { process.stderr.write('lost connection (подставной обрыв)\\n'); process.exit(1); }
const local = (spec) => { const match = /^[A-Za-z0-9._@-]+:(.*)$/.exec(spec); return match ? path.join(${JSON.stringify(home)}, match[1]) : spec; };
try { fs.copyFileSync(local(args[0]), local(args[1])); } catch (error) { process.stderr.write('scp: ' + error.message + '\\n'); process.exit(1); }
`,
    );
    writeFileSync(path.join(bin, 'setsid'), `#!/bin/sh\nexec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "setsid: $!"' "$@"\n`);
    writeFileSync(
        path.join(bin, 'timeout'),
        `#!/bin/bash\nwhile [ $# -gt 0 ]; do case "$1" in -s) shift 2 ;; -*) shift ;; *) break ;; esac; done\nshift\nexec "$@"\n`,
    );
    writeFileSync(path.join(gpuBin, 'nvidia-smi'), `#!/bin/sh\necho "GPU 0: Fake NVIDIA (UUID: GPU-test)"\n`);
    if (options.host !== false) {
        const host = path.join(set, 'zkvm-evm', 'target', 'release', 'rollup-evm-host');
        writeFileSync(
            host,
            `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const b = fs.existsSync(${JSON.stringify(hostFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(hostFile)}, 'utf8')) : {};
// Журнал — дописыванием (строка на событие): два хоста одновременно не теряют записей друг друга.
const event = (entry) => fs.appendFileSync(${JSON.stringify(runsFile)}, JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
const previous = fs.existsSync(${JSON.stringify(runsFile)}) ? fs.readFileSync(${JSON.stringify(runsFile)}, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.args) : [];
const runs = [...previous, { args }];
event({ args, start: Date.now() });
const finish = (code) => { event({ end: Date.now(), code }); process.exit(code); };
process.on('SIGTERM', () => finish(143));
if (b.hang) { setInterval(() => {}, 1000); return; }
setTimeout(() => {
  const proving = runs.filter((entry) => entry.args.includes('--prove') || entry.args.includes('--wrap-groth16')).length;
  if (b.failRuns && proving <= b.failRuns && !args.includes('--prove-compressed')) { process.stderr.write('[хост] пруф не построен (подставной сбой)\\n'); return finish(b.failCode ?? 1); }
  if (args.includes('--prove-compressed')) { fs.writeFileSync(arg('--proof-out'), 'сжатый'); return finish(0); }
  const input = crypto.createHash('sha256').update(fs.readFileSync(arg('--batch-input'))).digest('hex');
  const block = b.proofOf ?? ${JSON.stringify(blocks)}[input];
  fs.writeFileSync(arg('--proof-out'), fs.readFileSync(path.join(${JSON.stringify(ROOT)}, 'fixtures', 'evm_batches', 'proof-reth-block' + block + '.json')));
  finish(0);
}, b.delayMs ?? 50);
`,
        );
        chmodSync(host, 0o755);
    }
    for (const file of ['ssh', 'scp', 'setsid', 'timeout']) chmodSync(path.join(bin, file), 0o755);
    chmodSync(path.join(gpuBin, 'nvidia-smi'), 0o755);

    return {
        ssh,
        scp,
        home,
        jobsDir: path.join(set, 'remote-jobs'),
        net: (behaviour: NetBehaviour) => writeFileSync(netFile, JSON.stringify(behaviour)),
        host: (behaviour: HostBehaviour) => writeFileSync(hostFile, JSON.stringify(behaviour)),
        // Строка на вызов: ssh и scp бывают одновременно (два задания), запись — дописыванием.
        calls: (): SshCall[] => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
        hostRuns: (): HostRun[] => {
            const runs: HostRun[] = [];
            if (!existsSync(runsFile)) return runs;
            for (const entry of readFileSync(runsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Partial<HostRun> & { pid: number })) {
                if (entry.args) runs.push({ args: entry.args, pid: entry.pid, start: entry.start! });
                else Object.assign(runs.find((run) => run.pid === entry.pid && run.end === undefined) ?? {}, { end: entry.end, code: entry.code });
            }
            return runs;
        },
    };
}
