import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { Address, beginCell } from '@ton/core';
import { mnemonicNew } from '@ton/crypto';
import { TonClient } from '@ton/ton';
import { childEnv } from '../sequencer/children';
import { CHAIN_ID_FILE, chainIdProblems, randomChainId, resolveDeployChainId, RETH_SCENARIO_CHAIN_ID, usedChainIds } from '../sequencer/chainId';
import { newL2Account, signBridgeWithdrawal } from '../sequencer/l2Keys';
import { startNode } from '../sequencer/node';
import { classifyForced } from '../sequencer/program';
import { GENESIS_HASH, genesisJson } from '../sequencer/protocol';
import { SameWalletRefused, serviceWallet, takeServiceEnv } from '../sequencer/serviceEnv';
import { SequencerWallet } from '../sequencer/ton';
import { passToncenterKey, TrafficRefused, withRetries } from '../sequencer/trafficSafety';

// Правки круга 23 (REVIEW.md): окружение сервиса и кошелёк прогонов (1), свой chainId у каждого
// развёртывания и независимость генезиса от него (2), устойчивость нагрузки — повтор шага и ключ
// API провайдеру Blueprint (3; сценарии нагрузки — tests/SequencerTraffic.spec.ts, «круг 23»),
// сверка выводов в отчёте прогона (4). Прувер на сервере — tests/SequencerRemoteProver.spec.ts.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const report = require('../zk/sequencer-run-reconcile.cjs') as {
    parseBody(step: string, boc: string | undefined): Record<string, string | number> | null;
    owedKeysToRead(rows: object[]): string[];
    reconcile(input: { rows: object[]; withdrawalsCount: string; owed: Record<string, string | null> }): {
        leaves: number;
        claimed: number;
        paidOnClaim: number;
        paidOwed: number;
        owedNow: number;
        unclaimed: number;
        exitClaims: number;
        problems: string[];
        verdict: string;
    };
    exitCodeOf(result: { problems: string[] }): number;
};

const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, '.tools', 'sequencer-test', 'round23');

describe('круг 23', () => {
    let dir: string;
    beforeEach(() => {
        dir = path.join(WORK, randomBytes(4).toString('hex'));
        mkdirSync(dir, { recursive: true });
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    describe('1: окружение сервиса — только SEQUENCER_MNEMONIC', () => {
        const NAMES = ['SEQUENCER_MNEMONIC', 'SEQUENCER_WALLET_VERSION', 'WALLET_MNEMONIC', 'WALLET_VERSION', 'TONCENTER_API_KEY'];
        const saved = { ...process.env };
        // `blueprint test` загружает .env проекта в окружение: тест его не видит и не трогает.
        beforeEach(() => {
            for (const name of NAMES) delete process.env[name];
        });
        afterEach(() => {
            for (const name of NAMES) {
                if (saved[name] === undefined) delete process.env[name];
                else process.env[name] = saved[name];
            }
        });
        const envFile = (lines: string[]) => {
            const file = path.join(dir, '.env');
            writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
            return file;
        };

        it('.env читается сам и без печати; переменная процесса главнее строки файла; обе пары удалены из окружения', async () => {
            const [fileWords, envWords] = [(await mnemonicNew()).join(' '), (await mnemonicNew()).join(' ')];
            const file = envFile([`SEQUENCER_MNEMONIC="${fileWords}"`, 'SEQUENCER_WALLET_VERSION=v5r1', 'WALLET_MNEMONIC="другая мнемоника"', 'WALLET_VERSION=v4', 'TONCENTER_API_KEY=ключ']);
            const printed: string[] = [];
            const spies = [
                jest.spyOn(console, 'log').mockImplementation((...args) => void printed.push(args.join(' '))),
                jest.spyOn(console, 'info').mockImplementation((...args) => void printed.push(args.join(' '))),
                jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => (printed.push(String(chunk)), true)),
            ];
            let fromFile: SequencerWallet;
            try {
                fromFile = await serviceWallet(takeServiceEnv({ file }));
                process.env.SEQUENCER_MNEMONIC = envWords;
                process.env.SEQUENCER_WALLET_VERSION = 'v5r1';
                process.env.WALLET_MNEMONIC = 'тоже другая';
                process.env.WALLET_VERSION = 'v4';
                const env = takeServiceEnv({ file });
                expect(env.values.TONCENTER_API_KEY).toBe('ключ');
                const fromProcess = await serviceWallet(env);
                expect(fromProcess.address.equals(fromFile.address)).toBe(false);
                expect(fromProcess.address.equals((await SequencerWallet.fromEnv({ SEQUENCER_MNEMONIC: envWords, SEQUENCER_WALLET_VERSION: 'v5r1' })).address)).toBe(true);
            } finally {
                spies.forEach((spy) => spy.mockRestore());
            }
            expect(printed).toEqual([]);
            for (const name of ['SEQUENCER_MNEMONIC', 'SEQUENCER_WALLET_VERSION', 'WALLET_MNEMONIC', 'WALLET_VERSION']) expect(process.env[name]).toBeUndefined();
            expect(fromFile!.address.equals((await SequencerWallet.fromEnv({ SEQUENCER_MNEMONIC: fileWords, SEQUENCER_WALLET_VERSION: 'v5r1' })).address)).toBe(true);
        });

        it('кошелёк прогонов (WALLET_MNEMONIC) сервис не берёт: без SEQUENCER_* — отказ', async () => {
            const file = envFile([`WALLET_MNEMONIC="${(await mnemonicNew()).join(' ')}"`, 'WALLET_VERSION=v5r1']);
            await expect(serviceWallet(takeServiceEnv({ file }))).rejects.toThrow(
                'кошелёк секвенсора: нужны SEQUENCER_MNEMONIC и SEQUENCER_WALLET_VERSION (в .env проекта или в окружении)',
            );
            // И с версией сервиса — без SEQUENCER_MNEMONIC мнемоника прогонов не подставляется.
            writeFileSync(file, readFileSync(file, 'utf8') + 'SEQUENCER_WALLET_VERSION=v5r1\n');
            await expect(serviceWallet(takeServiceEnv({ file }))).rejects.toThrow('кошелёк секвенсора: нужны SEQUENCER_MNEMONIC и SEQUENCER_WALLET_VERSION');
        });

        it('дочерним мнемоника сервиса не передаётся (childEnv)', () => {
            const env = childEnv({ SEQUENCER_MNEMONIC: 'слова сервиса', WALLET_MNEMONIC: 'слова прогонов', TONCENTER_API_KEY: 'ключ', OTHER: '1' });
            expect([env.SEQUENCER_MNEMONIC, env.WALLET_MNEMONIC, env.TONCENTER_API_KEY, env.OTHER]).toEqual([undefined, undefined, undefined, '1']);
        });

        it('тот же ключ в SEQUENCER_MNEMONIC и WALLET_MNEMONIC — отказ «кошелёк сервиса совпадает с кошельком прогонов»', async () => {
            const words = (await mnemonicNew()).join(' ');
            const file = envFile([`SEQUENCER_MNEMONIC="${words}"`, 'SEQUENCER_WALLET_VERSION=v5r1', `WALLET_MNEMONIC="${words}"`, 'WALLET_VERSION=v5r1']);
            const refused = serviceWallet(takeServiceEnv({ file }));
            await expect(refused).rejects.toThrow(SameWalletRefused);
            await expect(serviceWallet(takeServiceEnv({ file }))).rejects.toThrow(/^кошелёк сервиса совпадает с кошельком прогонов/);
            // Разные мнемоники — годится; без WALLET_MNEMONIC — тоже.
            writeFileSync(file, `SEQUENCER_MNEMONIC="${words}"\nSEQUENCER_WALLET_VERSION=v5r1\nWALLET_MNEMONIC="${(await mnemonicNew()).join(' ')}"\n`);
            expect((await serviceWallet(takeServiceEnv({ file }))).version).toBe('v5r1');
            expect((await serviceWallet(takeServiceEnv({ file: null, env: { SEQUENCER_MNEMONIC: words, SEQUENCER_WALLET_VERSION: 'v4' } }))).version).toBe('v4');
        });
    });

    describe('2: свой chainId у развёртывания; генезис от chainId не зависит', () => {
        it('генезис узла при другом chainId отличается только полем config.chainId', () => {
            const strip = (genesis: object) => JSON.parse(JSON.stringify(genesis, (key, value) => (key === 'chainId' ? undefined : value)));
            const other = randomChainId(usedChainIds());
            expect((genesisJson(RETH_SCENARIO_CHAIN_ID) as { config: { chainId: number } }).config.chainId).toBe(Number(RETH_SCENARIO_CHAIN_ID));
            expect((genesisJson(other) as { config: { chainId: number } }).config.chainId).toBe(Number(other));
            expect(strip(genesisJson(other))).toEqual(strip(genesisJson(RETH_SCENARIO_CHAIN_ID)));
        });

        it('случайный chainId — 40 бит, не бывший в прогонах; записан в каталоге, повтор берёт его же; другой --chain-id — отказ', () => {
            const used = usedChainIds();
            expect(used.has(RETH_SCENARIO_CHAIN_ID)).toBe(true);
            const lines: string[] = [];
            const stateDir = path.join(dir, 'service');
            // Генератор сначала выдаёт занятое значение — оно пропускается.
            const values = [Number(RETH_SCENARIO_CHAIN_ID), 2 ** 39 + 12345];
            const chosen = resolveDeployChainId({ stateDir, flag: undefined, used, log: (line) => lines.push(line), random: () => values.shift()! });
            expect(chosen).toBe(BigInt(2 ** 39 + 12345));
            expect(JSON.parse(readFileSync(path.join(stateDir, CHAIN_ID_FILE), 'utf8'))).toMatchObject({ chainId: String(chosen), source: 'random' });
            expect(lines[0]).toMatch(new RegExp(`^chainId ${chosen} \\(случайный\\) записан в `));
            expect(resolveDeployChainId({ stateDir, flag: undefined, used, log: () => undefined })).toBe(chosen);
            expect(resolveDeployChainId({ stateDir, flag: String(chosen), used, log: () => undefined })).toBe(chosen);
            expect(() => resolveDeployChainId({ stateDir, flag: '777', used, log: () => undefined })).toThrow(
                new RegExp(`записан chainId ${chosen}, а --chain-id=777: развёртывание этого каталога начато с другим chainId`),
            );
            for (let index = 0; index < 50; index++) {
                const value = randomChainId(used);
                expect(value >= 2n ** 39n && value < 2n ** 40n).toBe(true);
            }
        });

        it('--chain-id: сценарный, Linea, вне 1…2^53 − 1, не число — отказ до записи; годный — записан', () => {
            const used = usedChainIds();
            const attempt = (flag: string) => () => resolveDeployChainId({ stateDir: path.join(dir, flag), flag, used, log: () => undefined });
            expect(attempt('362107787851')).toThrow(/chainId 362107787851 уже был в прогонах/);
            expect(attempt('59141')).toThrow(/сеть Linea/);
            expect(attempt('0')).toThrow(/не число от 1 до 2\^53 − 1/);
            expect(attempt(String(2n ** 53n))).toThrow(/не число от 1 до 2\^53 − 1/);
            expect(() => resolveDeployChainId({ stateDir: dir, flag: '0x10', used, log: () => undefined })).toThrow('--chain-id — целое число, получено «0x10»');
            expect(existsSync(path.join(dir, '362107787851', CHAIN_ID_FILE))).toBe(false);
            expect(attempt('424242')()).toBe(424242n);
            expect(JSON.parse(readFileSync(path.join(dir, '424242', CHAIN_ID_FILE), 'utf8'))).toMatchObject({ source: 'flag' });
            expect(chainIdProblems(2n ** 53n - 1n, new Set())).toEqual([]);
        });

        it('chainId из bench/testnet-run-*.json считаются занятыми (по ключам chainId / chain_id на любой глубине)', () => {
            const bench = path.join(dir, 'bench');
            mkdirSync(bench);
            writeFileSync(path.join(bench, 'testnet-run-a.json'), JSON.stringify({ deployment: { chainId: '123456789' }, steps: [{ chain_id: 987 }] }));
            writeFileSync(path.join(bench, 'other.json'), JSON.stringify({ chainId: '555' }));
            expect([...usedChainIds(bench)].sort()).toEqual([123456789n, 987n, RETH_SCENARIO_CHAIN_ID].sort());
        });

        const tools = {
            reth: path.join(ROOT, '.tools', 'reth', 'bin', 'reth'),
            rsp: path.join(ROOT, '.tools', 'rsp', 'target', 'release', 'rsp'),
            host: path.join(ROOT, 'zkvm-evm', 'target', 'release', 'rollup-evm-host'),
        };
        const haveReth = existsSync(tools.reth);
        const haveHost = existsSync(tools.host);

        if (!haveReth) it.todo('узел reth со случайным chainId — ждёт .tools/reth/bin/reth (PROVING.md)');
        else it('узел reth со случайным chainId: тот же GENESIS_HASH (checkGenesis при старте), eth_chainId — новый', async () => {
            const chainId = randomChainId(usedChainIds());
            const node = await startNode({ reth: tools.reth, dir: path.join(dir, 'node'), chainId, httpPort: 8771, authPort: 8775, p2pPort: 30611 });
            try {
                expect(BigInt(await node.rpc.eth<string>('eth_chainId', []))).toBe(chainId);
                expect((await node.rpc.eth<{ hash: string }>('eth_getBlockByNumber', ['0x0', false])).hash).toBe(GENESIS_HASH);
            } finally {
                await node.stop();
            }
        }, 120_000);

        if (!haveHost) it.todo('хост принимает произвольный chainId — ждёт zkvm-evm/target/release/rollup-evm-host (PROVING.md)');
        else it('хост принимает произвольный chainId: вывод через мост, подписанный под него, годен по форме, под другой — нет', async () => {
            const chainId = randomChainId(usedChainIds());
            const bytes = signBridgeWithdrawal(newL2Account(), { chainId, nonce: 0, amountNano: 50_000_000n, recipientHash: 1n });
            const verdicts = await classifyForced({ host: tools.host, rsp: tools.rsp, executeInZkvm: false }, chainId, [bytes], path.join(dir, 'host'));
            expect(verdicts).toEqual([expect.objectContaining({ form: 'valid' })]);
            const foreign = await classifyForced({ host: tools.host, rsp: tools.rsp, executeInZkvm: false }, chainId + 1n, [bytes], path.join(dir, 'host2'));
            expect(foreign).toEqual([expect.objectContaining({ form: 'skipped', reason: expect.stringMatching(/ForeignChainId/) })]);
        }, 120_000);
    });

    describe('3: нагрузка — ключ API провайдеру Blueprint, повтор шага', () => {
        it('TONCENTER_API_KEY вписывается в клиент Blueprint: заголовок X-API-Key у следующего запроса', async () => {
            const headers: Record<string, string>[] = [];
            const client = new TonClient({
                endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
                httpAdapter: async (config) => {
                    headers.push({ ...(config.headers as Record<string, string>) });
                    throw new Error('сеть не нужна: запрос перехвачен тестом');
                },
            });
            const provider = { api: () => client };
            expect(passToncenterKey(provider, undefined)).toBe('absent');
            await expect(client.getBalance(new Address(0, Buffer.alloc(32)))).rejects.toThrow('перехвачен тестом');
            expect(headers[0]['X-API-Key']).toBeUndefined();
            expect(passToncenterKey(provider, 'ключ-теста')).toBe('passed');
            await expect(client.getBalance(new Address(0, Buffer.alloc(32)))).rejects.toThrow('перехвачен тестом');
            expect(headers[1]['X-API-Key']).toBe('ключ-теста');
            expect(passToncenterKey({}, 'ключ')).toBe('unsupported');
            expect(passToncenterKey({ api: () => ({}) }, 'ключ')).toBe('unsupported');
        });

        it('withRetries: сбой — журнал, пауза, повтор; подряд maxFailures — выход с текстом; отказ по защите — сразу', async () => {
            const lines: string[] = [];
            const pauses: number[] = [];
            const options = { maxFailures: 3, pauseSeconds: 7, sleep: async (ms: number) => void pauses.push(ms), log: (line: string) => void lines.push(line) };
            let calls = 0;
            expect(await withRetries('шаг', async () => (++calls < 3 ? Promise.reject(new Error(`сбой ${calls}`)) : 'готово'), options)).toBe('готово');
            expect(lines).toEqual(['Сбой шага «шаг» (1 подряд из 3): сбой 1', 'Сбой шага «шаг» (2 подряд из 3): сбой 2']);
            expect(pauses).toEqual([7000, 7000]);
            await expect(withRetries('шаг', async () => Promise.reject(new Error('toncenter 502')), options)).rejects.toThrow(
                /^нагрузка остановлена: 3 сбоев подряд на шаге «шаг», последний — toncenter 502\. Журнал сохранён/,
            );
            calls = 0;
            await expect(withRetries('шаг', async () => (calls++, Promise.reject(new TrafficRefused('чужой кошелёк'))), options)).rejects.toThrow('чужой кошелёк');
            expect(calls).toBe(1);
        });
    });

    describe('4: сверка выводов в отчёте прогона', () => {
        const recipient = new Address(0, Buffer.alloc(32, 0x77));
        const hash = recipient.hash.toString('hex');
        const claimedBody = (key: bigint, amount: bigint) =>
            beginCell().storeUint(0x52420011, 32).storeUint(0, 64).storeUint(key, 256).storeAddress(recipient).storeCoins(amount).endCell().toBoc().toString('base64');
        const payOwedBody = (key: bigint) => beginCell().storeUint(0x5242000c, 32).storeUint(0, 64).storeUint(key, 256).endCell().toBoc().toString('base64');
        const row = (step: string, boc: string | undefined, out: { to: string; valueNano: string }[] = [], success = true) => ({
            step,
            success,
            hash: randomBytes(4).toString('hex'),
            out,
            body: report.parseBody(step, boc),
        });
        const paid = (key: bigint, amount = 50_000_000n) => row('nullifierClaimed', claimedBody(key, amount), [{ to: hash, valueNano: String(amount) }]);
        const indebted = (key: bigint, amount = 50_000_000n) => row('nullifierClaimed', claimedBody(key, amount));

        it('разбор тел: NullifierClaimed и PayOwed; чужой опкод — null', () => {
            expect(report.parseBody('nullifierClaimed', claimedBody(3n, 7n))).toEqual({ key: '3', recipientHash: hash, amountNano: '7' });
            expect(report.parseBody('payOwed', payOwedBody(4n))).toEqual({ key: '4' });
            expect(report.parseBody('payOwed', claimedBody(3n, 7n))).toBeNull();
            expect(report.parseBody('deposit', claimedBody(3n, 7n))).toBeNull();
        });

        it('сошлось: выплачено сразу, по PayOwed, долг записан — код 0; выход счёта (ключ ≥ 2^32) отдельно', () => {
            const rows = [paid(0n), indebted(1n), row('payOwed', payOwedBody(1n), [{ to: hash, valueNano: '50000000' }]), indebted(2n), paid(2n ** 100n), row('withdraw', undefined)];
            expect(report.owedKeysToRead(rows)).toEqual(['0', '1', '2']);
            const result = report.reconcile({ rows, withdrawalsCount: '4', owed: { '0': null, '1': null, '2': '50000000' } });
            expect(result).toMatchObject({ leaves: 4, claimed: 3, paidOnClaim: 1, paidOwed: 1, owedNow: 1, unclaimed: 1, exitClaims: 1, problems: [], verdict: 'сошлось' });
            expect(report.exitCodeOf(result)).toBe(0);
        });

        it('не сошлось — каждая причина своей строкой, код 2', () => {
            const check = (rows: object[], owed: Record<string, string | null>, problem: RegExp, withdrawalsCount = '4') => {
                const result = report.reconcile({ rows, withdrawalsCount, owed });
                expect(result.verdict).toBe('не сошлось');
                expect(result.problems).toEqual([expect.stringMatching(problem)]);
                expect(report.exitCodeOf(result)).toBe(2);
            };
            check([indebted(0n)], { '0': null }, /^лист 0: погашен, не выплачен и долга у контракта нет — выплата потеряна$/);
            check([paid(0n)], { '0': '50000000' }, /^лист 0: выплачен, а у контракта записан долг 50000000 нанотон$/);
            check([paid(5n)], { '5': null }, /^лист 5 погашен, а листьев у контракта 4$/);
            check([indebted(0n)], { '0': '1' }, /^лист 0: долг 1 нанотон, а в подтверждении 50000000$/);
            check([paid(0n), row('payOwed', payOwedBody(0n), [{ to: hash, valueNano: '50000000' }])], { '0': null }, /^лист 0: PayOwed после выплаты — выплачен дважды$/);
            check([row('payOwed', payOwedBody(3n), [{ to: hash, valueNano: '1' }])], {}, /^PayOwed по листу 3 без подтверждения нуллификатора$/);
            check([paid(0n, 10n), paid(0n, 10n)], { '0': null }, /^лист 0: второе подтверждение нуллификатора/);
            // Выплата не той суммы — не выплата.
            check([row('nullifierClaimed', claimedBody(0n, 10n), [{ to: hash, valueNano: '9' }])], { '0': null }, /выплата потеряна/);
            check([paid(0n)], {}, /^лист 0: долг не прочитан/);
            // Неуспешные транзакции не считаются.
            expect(report.reconcile({ rows: [row('nullifierClaimed', claimedBody(0n, 1n), [], false)], withdrawalsCount: '1', owed: {} }).verdict).toBe('сошлось');
        });
    });
});
