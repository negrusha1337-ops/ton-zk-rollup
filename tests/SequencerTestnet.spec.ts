import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { inspect } from 'util';
import { randomBytes } from 'crypto';
import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, Transaction } from '@ton/core';
import { compile } from '@ton/blueprint';
import { mnemonicNew } from '@ton/crypto';
import '@ton/test-utils';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import { dataChunksOf, loadEvmRollupKey, loadProvenRethBatch } from '../wrappers/evmProofs';
import { dataHashStep } from '../wrappers/rollupMath';
import { StateDirBusy } from '../sequencer/state';
import { Rollup, RollupOpcodes } from '../wrappers/Rollup';
import { DEPLOY_VALUE, KEY_FINALIZE_VALUE, KEY_PART_VALUE, PUBLISH_DATA_VALUE } from '../wrappers/rollupValues';
import { DEFAULT_CIRCUITS_DIR } from '../sequencer/proofImport';
import { BatchProof, jobKeyOf, LocalProver, Prover } from '../sequencer/prover';
import { Interrupted, Sequencer, SequencerConfig } from '../sequencer/service';
import { Batch, TestnetSubmitter, TestnetSubmitterOptions } from '../sequencer/submitter';
import { assertTestnetEndpoint, SequencerWallet } from '../sequencer/ton';
import { checkTestnet, serve } from '../sequencer/testnet';
import { fakeProveScript, rethJob } from './helpers/fakeProver';
import { FAKE_CHAIN_ID, fakeNode, fakeQueue, fakeTools } from './helpers/fakeSequencerNode';
import { blockOf, enqueueUpTo, reportOf } from './helpers/rethChain';
import { readProtocolConstants, testConfig } from './helpers/rollupSetup';
import { sandboxChain } from './helpers/sandboxChain';

// Отправщик testnet (sequencer/submitter.ts, TestnetSubmitter) в Sandbox: настоящий контракт с
// ключом программы EVM, настоящий кошелёк v4 секвенсора (мнемоника — новая на каждый запуск), сеть —
// подставная (tests/helpers/sandboxChain.ts) с потерянными ответами, сообщениями в пути и отстающим
// снимком. Батч — блок 1 цепочки Reth с пруфом SP1 (fixtures/sp1_evm_reth1). Сквозной шаг: сервис
// на заглушках узла и хоста + LocalProver на заглушке сторожа + TestnetSubmitter → батч принят.
// Чего здесь нет и что впервые исполнится только в testnet: toncenter (ответы, задержки, 429,
// sync_utime за балансировщиком), sendFile, global_id сети, комиссии кошелька, время блоков L1.

const BLOCK = blockOf(1);
const WORK = path.join(__dirname, '..', '.tools', 'sequencer-test', 'testnet');
const proven = loadProvenRethBatch(1);
const groth16 = (): BatchProof => ({ kind: 'groth16', proof: proven.proof, hintsBoc: proven.hinted.hintsBoc, jobKey: jobKeyOf(rethJob(1)) });
const batch = (): Batch => ({ number: 1, blockHash: BLOCK.hash, report: reportOf(1), proof: groth16() });

describe('TestnetSubmitter в Sandbox: настоящий контракт, кошелёк по мнемонике, сбои сети', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let wallet: SequencerWallet;
    let ready: BlockchainSnapshot;
    let dir: string;
    let net: ReturnType<typeof sandboxChain>;
    let lines: string[];
    const submitter = (options: Partial<TestnetSubmitterOptions> = {}) =>
        new TestnetSubmitter({
            chain: net.chain,
            rollup: rollup.address,
            wallet,
            stateDir: path.join(dir, 'state'),
            pollMs: 0,
            pollAttempts: 20,
            log: (line) => lines.push(line),
            // Часы машины — время Sandbox: проверка «снимок из будущего» (круг 22, 2) от настоящих часов не зависит.
            now: () => blockchain.now!,
            ...options,
        });
    const opsTo = (results: { transactions: Transaction[] }[]) =>
        results.flatMap((result) =>
            result.transactions.flatMap((transaction) => {
                const message = transaction.inMessage;
                if (!message || message.info.type !== 'internal' || !rollup.address.equals(message.info.dest)) return [];
                const description = transaction.description;
                const ok = description.type === 'generic' && description.computePhase.type === 'vm' && description.computePhase.success;
                const body = message.body.beginParse();
                return body.remainingBits >= 32 && ok ? [body.loadUint(32)] : [];
            }),
        );
    const submits = () => opsTo(net.results).filter((op) => op === RollupOpcodes.submitBatch).length;
    const chunks = reportOf(1).dataChunksHex.length;

    beforeAll(async () => {
        const code = await compile('Rollup');
        const nullifierCode = await compile('RollupNullifier');
        const constants = await readProtocolConstants(code, nullifierCode);
        const key = loadEvmRollupKey();
        wallet = await SequencerWallet.fromEnv({ WALLET_MNEMONIC: (await mnemonicNew()).join(' '), WALLET_VERSION: 'v4' });
        blockchain = await Blockchain.create();
        blockchain.now = BLOCK.timestamp;
        owner = await blockchain.treasury('owner');
        const user = await blockchain.treasury('user');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                testConfig(constants, { owner: owner.address, sequencer: wallet.address, nullifierCode, chainId: FAKE_CHAIN_ID, escapeTimeout: 3600 * 12 }),
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key.upload))
            await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
        await rollup.sendFinalizeKey(owner.getSender(), { key: key.upload, value: KEY_FINALIZE_VALUE });
        expect(await rollup.getKeyHash()).toBe(key.keyHash);
        await enqueueUpTo({ blockchain, rollup, sequencer: owner, user }, BLOCK.headAtBatch);
        // Кошелёк секвенсора пополнен, но не развёрнут: первое сообщение несёт его init.
        await owner.send({ to: wallet.address, value: toNano('3'), bounce: false });
        blockchain.now = BLOCK.timestamp + 60;
        ready = blockchain.snapshot();
    }, 300_000);
    beforeEach(async () => {
        await blockchain.loadFrom(ready);
        dir = path.join(WORK, randomBytes(4).toString('hex'));
        mkdirSync(dir, { recursive: true });
        net = sandboxChain(blockchain);
        lines = [];
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('честный батч: данные порциями и SubmitBatch с пруфом — принят; повтор ничего не шлёт', async () => {
        expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: false });
        expect((await rollup.getRollupState()).stateRoot).toBe(BigInt(BLOCK.hash));
        expect(opsTo(net.results)).toEqual([...Array(chunks).fill(RollupOpcodes.publishData), RollupOpcodes.submitBatch]);
        expect(net.attempts).toHaveLength(chunks + 1);
        expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: true });
        expect(net.attempts).toHaveLength(chunks + 1);
        expect(await submitter().contractState()).toEqual({ batchIndex: 1, stateRoot: BigInt(BLOCK.hash), utime: BLOCK.timestamp + 60 });
    }, 120_000);

    it('сбой между отправкой и записью: ответ потерян — повтор без дубля; сообщение в пути — ждать, не слать', async () => {
        net.control.fault = { kind: 'loseAck' };
        net.control.which = (index) => index === chunks + 1;
        await expect(submitter().submit(batch())).rejects.toThrow('сеть не ответила (сообщение дошло)');
        net.control.fault = null;
        expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: true });
        expect(submits()).toBe(1);
        expect(net.attempts).toHaveLength(chunks + 1);

        await blockchain.loadFrom(ready);
        rmSync(path.join(dir, 'state'), { recursive: true, force: true });
        net = sandboxChain(blockchain);
        net.control.fault = { kind: 'hold', releaseAfter: 8 };
        net.control.which = (index) => index === chunks + 1;
        await expect(submitter({ pollAttempts: 3 }).submit(batch())).rejects.toThrow(/^не дождался: кошелёк принял сообщение «батч 1»/);
        // «Перезапуск»: сообщение ещё в пути — новое не шлётся, пока кошелёк его не примет.
        expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: true });
        expect(submits()).toBe(1);
        expect(net.attempts).toHaveLength(chunks + 1);
    }, 120_000);

    it('сообщение не дошло: повтор — только после конца его срока (время L1 позже validUntil при прежнем seqno)', async () => {
        net.control.fault = { kind: 'drop' };
        net.control.which = (index) => index === chunks + 1;
        await expect(submitter().submit(batch())).rejects.toThrow('сеть не ответила (сообщение не дошло)');
        net.control.fault = null;
        net.control.tick = 30; // время L1 идёт с каждым чтением: срок сообщения (120 с) истечёт
        expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: false });
        expect(submits()).toBe(1);
        expect(net.attempts).toHaveLength(chunks + 2);
        expect(lines.some((line) => /сообщение «батч 1» \(seqno \d+\) не принято кошельком до срока \d+ \(\+60 с\): не дошло/.test(line))).toBe(true);
    }, 120_000);

    describe('круг 21: монотонные снимки, срок сообщения, отказ контракта, сброс и продолжение данных', () => {
        const raw = () => rollup.address.toRawString();
        const publishOps = () => Array(chunks).fill(RollupOpcodes.publishData);

        it('снимок rollup\'а старее подтверждения порции — перечитывается: дубля порции нет, данные верны', async () => {
            net.control.tick = 1;
            net.control.rewind = { address: raw(), delivery: 1, skip: 1, reads: 1 };
            expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: false });
            expect(net.attempts).toHaveLength(chunks + 1);
            expect(opsTo(net.results)).toEqual([...publishOps(), RollupOpcodes.submitBatch]);
            expect(await rollup.getRollupState()).toMatchObject({ batchIndex: 1, stateRoot: BigInt(BLOCK.hash) });
        }, 120_000);

        it('снимок кошелька старее последнего — seqno не из прошлого: сообщение с годным seqno, без лишней попытки', async () => {
            net.control.tick = 1;
            net.control.rewind = { address: wallet.address.toRawString(), delivery: 1, skip: 1, reads: 1 };
            expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: false });
            expect(net.attempts).toHaveLength(chunks + 1);
            expect(opsTo(net.results)).toEqual([...publishOps(), RollupOpcodes.submitBatch]);
        }, 120_000);

        it('после подтверждения SubmitBatch снимок отстал — «принят» не теряется и SubmitBatch не повторяется', async () => {
            net.control.tick = 1;
            net.control.rewind = { address: raw(), delivery: chunks + 1, skip: 1, reads: 1 };
            expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: false });
            expect(net.attempts).toHaveLength(chunks + 1);
            expect(submits()).toBe(1);
        }, 120_000);

        it('наибольшее время снимка переживает перезапуск (stateDir/l1-seen.json)', async () => {
            const old = await net.snapshot(rollup.address);
            net.control.tick = 5;
            const seen = (await submitter().contractState()).utime;
            expect(seen).toBe(old.utime + 5);
            net.control.lag.set(raw(), old);
            net.control.lagReads.set(raw(), 1);
            expect((await submitter().contractState()).utime).toBe(seen + 10);
            // Отстающий сервер так и не догнал: предел перечитываний — отказ шага, не старое состояние.
            net.control.lagReads.set(raw(), 100);
            await expect(submitter({ staleRereads: 2 }).contractState()).rejects.toThrow(/^снимок счёта .* на время \d+ \(lt \d+\), а уже виден снимок на \d+ \(lt \d+\): 3 ответов подряд/);
        }, 60_000);

        it('«не дошло» — только после validUntil + expiryMargin: в запасе ждать, после — слать снова', async () => {
            net.control.fault = { kind: 'drop' };
            net.control.which = (index) => index === 1;
            await expect(submitter().submit(batch())).rejects.toThrow('сеть не ответила (сообщение не дошло)');
            net.control.fault = null;
            const outbox = JSON.parse(require('fs').readFileSync(path.join(dir, 'state', 'outbox.json'), 'utf8')) as { validUntil: number };
            blockchain.now = outbox.validUntil + 30;
            await expect(submitter({ pollAttempts: 2 }).submit(batch())).rejects.toThrow(/^не дождался: кошелёк принял сообщение «данные батча 1/);
            expect(net.attempts).toHaveLength(1);
            blockchain.now = outbox.validUntil + 61;
            expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: false });
            expect(net.attempts).toHaveLength(chunks + 2);
        }, 120_000);

        it('отказ контракта сообщению, принятому кошельком (SubmitBatch после срока), — по транзакции контракта, сразу', async () => {
            const { maxBlockAge } = await rollup.getDeployment();
            blockchain.now = BLOCK.timestamp + maxBlockAge + 10;
            const outcome = await submitter({ pollAttempts: 50 }).submit(batch());
            expect(outcome).toEqual({ accepted: false, reason: expect.stringMatching(/^контракт отверг сообщение «батч 1» \(код \d+\)/) });
            // Без списка транзакций — прежний ответ по истечении ожидания.
            await blockchain.loadFrom(ready);
            rmSync(path.join(dir, 'state'), { recursive: true, force: true });
            net = sandboxChain(blockchain);
            net.control.listTransactions = false;
            blockchain.now = BLOCK.timestamp + maxBlockAge + 10;
            expect(await submitter({ pollAttempts: 3 }).submit(batch())).toEqual({
                accepted: false,
                reason: expect.stringMatching(/^сообщение «батч 1» кошелёк отправил \(seqno \d+\), а контракт его не учёл/),
            });
        }, 120_000);

        it('перед каждой отправкой — своя блокировка: снята — StateDirBusy, сообщение не уходит', async () => {
            let calls = 0;
            const assertHeld = () => {
                if (++calls > chunks) throw new StateDirBusy('блокировка снята');
            };
            await expect(submitter({ assertHeld }).submit(batch())).rejects.toThrow(StateDirBusy);
            expect(net.attempts).toHaveLength(chunks);
            expect(require('fs').existsSync(path.join(dir, 'state', 'outbox.json'))).toBe(false);
        }, 120_000);

        it('чужие данные батча у контракта — сброс (DiscardBatchData), затем порции и SubmitBatch', async () => {
            const foreign = dataChunksOf(reportOf(2))[0];
            await rollup.sendPublishData(blockchain.sender(wallet.address), { batchIndex: 1, data: foreign, value: PUBLISH_DATA_VALUE });
            expect(await rollup.getBatchDataHash(1)).not.toBe(0n);
            expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: false });
            expect(opsTo(net.results)).toEqual([RollupOpcodes.discardBatchData, ...publishOps(), RollupOpcodes.submitBatch]);
            expect(net.attempts).toHaveLength(chunks + 2);
        }, 120_000);

        it('часть порций уже опубликована — продолжение с середины, без сброса и без повтора', async () => {
            // Данные блока 1, разрезанные на три порции (у настоящих блоков цепочки порция одна).
            const whole = Buffer.from(reportOf(1).dataChunksHex[0], 'hex');
            const parts = [whole.subarray(0, 200), whole.subarray(200, 400), whole.subarray(400)].map((part) => part.toString('hex'));
            const report = { ...reportOf(1), dataChunksHex: parts };
            const cells = dataChunksOf(report);
            const hash = cells.reduce(dataHashStep, 0n);
            report.publicValues = { ...report.publicValues, batchHash: '0x' + hash.toString(16).padStart(64, '0') };
            await rollup.sendPublishData(blockchain.sender(wallet.address), { batchIndex: 1, data: cells[0], value: PUBLISH_DATA_VALUE });
            const outcome = await submitter().submit({ ...batch(), report });
            // Данные опубликованы целиком; дальше — сверка публичного входа (отчёт подменён тестом).
            expect(outcome).toEqual({ accepted: false, reason: expect.stringMatching(/^контракт ждёт публичный вход/) });
            expect(opsTo(net.results)).toEqual([RollupOpcodes.publishData, RollupOpcodes.publishData]);
            expect(net.attempts).toHaveLength(2);
            expect(await rollup.getBatchDataHash(1)).toBe(hash);
        }, 120_000);
    });

    describe('круг 22: монотонность и по lt счёта, снимок из будущего', () => {
        const raw = () => rollup.address.toRawString();
        const seenFile = () => path.join(dir, 'state', 'l1-seen.json');

        it('снимок кошелька с тем же временем и прежним seqno после доставки — по lt старее: перечитан, без ложного «не учёл»', async () => {
            // tick 0: время L1 не меняется — отличить отстающий снимок можно только по lt.
            net.control.rewind = { address: wallet.address.toRawString(), delivery: 1, skip: 1, reads: 1 };
            expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: false });
            expect(net.attempts).toHaveLength(chunks + 1);
            expect(opsTo(net.results)).toEqual([...Array(chunks).fill(RollupOpcodes.publishData), RollupOpcodes.submitBatch]);
        }, 120_000);

        it('после SubmitBatch снимок контракта с тем же временем и «не принят» — по lt старее: «принят» не теряется', async () => {
            net.control.rewind = { address: raw(), delivery: chunks + 1, skip: 1, reads: 1 };
            expect(await submitter().submit(batch())).toEqual({ accepted: true, alreadyAccepted: false });
            expect(net.attempts).toHaveLength(chunks + 1);
            expect(submits()).toBe(1);
            // На диске — и время, и lt.
            const seen = JSON.parse(readFileSync(seenFile(), 'utf8'));
            expect(seen[raw()]).toEqual({ utime: blockchain.now, lt: (await net.snapshot(rollup.address)).lt.toString() });
        }, 120_000);

        it('снимок из будущего (позже часов машины больше чем на maxFutureSkew) — сбой, в l1-seen.json не записан', async () => {
            const honest = await net.snapshot(rollup.address);
            expect((await submitter().contractState()).utime).toBe(honest.utime);
            net.control.lag.set(raw(), { ...honest, utime: honest.utime + 601 });
            await expect(submitter().contractState()).rejects.toThrow(/^снимок счёта .* на время \d+ — позже часов машины \(\d+\) больше чем на 600 с/);
            expect(JSON.parse(readFileSync(seenFile(), 'utf8'))[raw()].utime).toBe(honest.utime);
            // Предел — параметр; ровно на пределе снимок годен.
            net.control.lag.set(raw(), { ...honest, utime: honest.utime + 30 });
            await expect(submitter({ maxFutureSkew: 29 }).contractState()).rejects.toThrow('больше чем на 29 с');
            expect((await submitter({ maxFutureSkew: 30 }).contractState()).utime).toBe(honest.utime + 30);
            net.control.lag.clear();
        }, 60_000);

        it('l1-seen.json в прежнем формате (только время) читается; испорченный — отказ со ссылкой на README', async () => {
            mkdirSync(path.join(dir, 'state'), { recursive: true });
            writeFileSync(seenFile(), JSON.stringify({ [raw()]: blockchain.now! - 5 }));
            expect((await submitter().contractState()).utime).toBe(blockchain.now);
            writeFileSync(seenFile(), JSON.stringify({ [raw()]: { utime: 1, lt: 'x' } }));
            expect(() => submitter()).toThrow(/l1-seen\.json: не таблица «адрес → \{ utime, lt \}» \(sequencer\/README\.md/);
        }, 60_000);
    });

    it('кошелёк, сеть и ключ: чужой секвенсор — отказ; ключ не печатается; не testnet — отказ', async () => {
        const stranger = await SequencerWallet.fromEnv({ WALLET_MNEMONIC: (await mnemonicNew()).join(' '), WALLET_VERSION: 'v5r1' });
        const other = new TestnetSubmitter({ chain: net.chain, rollup: rollup.address, wallet: stranger, stateDir: dir });
        await expect(other.deployment()).rejects.toThrow(/^секвенсор контракта — .*, а кошелёк из WALLET_MNEMONIC — .*: батчи от него контракт не примет$/);
        expect(await submitter().deployment()).toEqual({ chainId: FAKE_CHAIN_ID, maxBlockAge: (await rollup.getDeployment()).maxBlockAge });
        const words = (await mnemonicNew()).join(' ');
        const shown = await SequencerWallet.fromEnv({ WALLET_MNEMONIC: words, WALLET_VERSION: 'v4' });
        for (const text of [inspect(shown), JSON.stringify(shown), String(shown)]) for (const word of words.split(' ')) expect(text).not.toContain(` ${word} `);
        expect(inspect(shown)).toBe(`SequencerWallet(${shown.address.toString({ testOnly: true })}, v4)`);
        await expect(SequencerWallet.fromEnv({ WALLET_MNEMONIC: 'тайное слово', WALLET_VERSION: 'v4' })).rejects.toThrow(
            new Error('кошелёк секвенсора: WALLET_MNEMONIC не разбирается как мнемоника TON'),
        );
        await expect(SequencerWallet.fromEnv({ WALLET_MNEMONIC: words, WALLET_VERSION: 'v3r2' })).rejects.toThrow('WALLET_VERSION=v3r2 не поддерживается');
        await expect(SequencerWallet.fromEnv({})).rejects.toThrow('нужны переменные окружения WALLET_MNEMONIC и WALLET_VERSION');
        expect(() => assertTestnetEndpoint('https://toncenter.com/api/v2/jsonRPC')).toThrow(
            'адрес API toncenter.com: секвенсор работает только с testnet.toncenter.com (стенд без аудита)',
        );
        expect(() => assertTestnetEndpoint('https://testnet.toncenter.com/api/v2/jsonRPC')).not.toThrow();
    }, 60_000);

    describe('сервис целиком: узел и хост — заглушки, прувер — LocalProver на заглушке сторожа, отправщик — testnet', () => {
        const circuits = require('fs').existsSync(path.join(DEFAULT_CIRCUITS_DIR, 'Groth16Verifier.sol'));
        const service = (prover: Prover, faults?: { stopAfter?: 'built' }) => {
            const tools = fakeTools(path.join(dir, 'tools'));
            const config: SequencerConfig = {
                chainId: FAKE_CHAIN_ID,
                feeRecipient: '0x' + '5e'.repeat(20),
                stateDir: path.join(dir, 'state'),
                rpcUrl: 'http://127.0.0.1:1',
                genesisPath: path.join(dir, 'genesis.json'),
                includePool: false,
                tools: tools.tools,
                maxBatchQueueItems: 32,
                maxBlockAge: 1800,
                expectedProofTime: 600,
                now: () => blockchain.now!,
            };
            return new Sequencer(config, {
                node: nodeRpc,
                queue: fakeQueue(),
                prover,
                submitter: submitter(),
                l1Now: async () => blockchain.now!,
                log: (line) => lines.push(line),
                faults,
            });
        };
        let nodeRpc: ReturnType<typeof fakeNode>['rpc'];
        beforeEach(() => (nodeRpc = fakeNode().rpc));

        (circuits ? it : it.skip)('блок 1: проверен, пруф (импорт и сверка), батч принят настоящим контрактом в Sandbox; check проходит', async () => {
            const fake = fakeProveScript(path.join(dir, 'fake'));
            fake.behave({ proofOf: 1 }); // вход батча сервиса — blocks/1/batch.bin
            blockchain.now = BLOCK.timestamp;
            const prover = new LocalProver({ dir: path.join(dir, 'state', 'proofs'), script: fake.script });
            const instance = service(prover);
            await instance.start();
            try {
                expect(await instance.step()).toMatchObject({ kind: 'checked', number: 1, hash: BLOCK.hash });
                blockchain.now = BLOCK.timestamp + 60;
                expect(await instance.step()).toEqual({ kind: 'accepted', number: 1, hash: BLOCK.hash, alreadyAccepted: false });
            } finally {
                instance.close();
            }
            expect(await rollup.getRollupState()).toMatchObject({ batchIndex: 1, stateRoot: BigInt(BLOCK.hash) });
            expect(submits()).toBe(1);
            // Режим check на том же контракте: всё сходится, ничего не отправлено.
            const sent = net.attempts.length;
            const checkNow = (overrides = {}) =>
                checkTestnet({ chain: net.chain, rollup: rollup.address, wallet, now: () => blockchain.now!, maxBlockAge: 1800, expectedProofTime: 600, ...overrides });
            expect((await checkNow()).problems).toEqual([]);
            // Круг 21, 5а: кошелёк v4 — предупреждение (не отказ), v5r1 — без него.
            const warning = /^ВНИМАНИЕ: кошелёк секвенсора v4 — рекомендуется WALLET_VERSION=v5r1 и отдельная мнемоника/;
            expect((await checkNow()).lines).toContainEqual(expect.stringMatching(warning));
            const v5 = await SequencerWallet.fromEnv({ WALLET_MNEMONIC: (await mnemonicNew()).join(' '), WALLET_VERSION: 'v5r1' });
            expect((await checkNow({ wallet: v5 })).lines).not.toContainEqual(expect.stringMatching(warning));
            // Пруф по умолчанию (1800 с) в срок 1800 с не помещается; сеть не testnet; чужой кошелёк.
            expect((await checkNow({ expectedProofTime: 1800 })).problems).toEqual([expect.stringMatching(/^время проверки кандидата 300 с \+ время пруфа 1800 с/)]);
            net.control.globalId = -239;
            const stranger = await SequencerWallet.fromEnv({ WALLET_MNEMONIC: (await mnemonicNew()).join(' '), WALLET_VERSION: 'v4' });
            expect((await checkNow({ wallet: stranger })).problems).toEqual([
                'сеть с global_id -239 — не testnet (-3)',
                expect.stringMatching(/^секвенсор контракта .*, а кошелёк — /),
                'на кошельке 0 TON, нужно не меньше 0.2 TON',
            ]);
            expect(net.attempts).toHaveLength(sent);
        }, 180_000);

        (circuits ? it : it.skip)('круг 21, 2: негодный пруф (ProofRejected) в цикле run — код 2 и «ОСТАНОВКА», прувер не повторяется', async () => {
            const fake = fakeProveScript(path.join(dir, 'fake'));
            fake.behave({ proofOf: 1, corrupt: true });
            blockchain.now = BLOCK.timestamp;
            const prover = new LocalProver({ dir: path.join(dir, 'state', 'proofs'), script: fake.script });
            const printed: string[] = [];
            expect(await serve(service(prover), { pollSeconds: 0 }, (line) => printed.push(line))).toBe(2);
            expect(printed.filter((line) => line.startsWith('ОСТАНОВКА: '))).toEqual([expect.stringMatching(/^ОСТАНОВКА: import-sp1-fixture\.mjs отказал/)]);
            expect(fake.runs()).toHaveLength(1);
            expect(net.attempts).toHaveLength(0);
        }, 180_000);

        it('А1 через отправщик testnet: батч мог уйти, а снимок контракта отстал — waiting; снимок догнал — пересборка', async () => {
            const prover: Prover = { prove: async () => groth16() };
            blockchain.now = BLOCK.timestamp;
            const first = service(prover);
            await first.start();
            await first.step();
            blockchain.now = BLOCK.timestamp + 60;
            net.control.fault = { kind: 'drop' };
            await expect(first.step()).rejects.toThrow('сеть не ответила (сообщение не дошло)');
            first.close();
            net.control.fault = null;
            const deadline = BLOCK.timestamp + 1800;
            const stale = await net.snapshot(rollup.address);
            net.control.lag.set(rollup.address.toRawString(), { ...stale, utime: deadline - 10 });
            blockchain.now = deadline + 500;
            const second = service(prover);
            await second.start();
            expect(await second.step()).toMatchObject({ kind: 'waiting', number: 1 });
            second.close();
            net.control.lag.clear();
            const third = service(prover, { stopAfter: 'built' });
            await third.start();
            await expect(third.step()).rejects.toThrow(Interrupted);
            expect(third.snapshot.rebuild).toMatchObject({ number: 1, replaces: BLOCK.hash });
            third.close();
            expect(submits()).toBe(0);
        }, 120_000);
    });
});
