import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { BuildRequest, ExecutionPayload } from '../../sequencer/block/payload';
import { BRIDGE_ADDRESS, BRIDGE_CODE, GAS_LIMIT, GENESIS_HASH, ZERO_HASH } from '../../sequencer/protocol';
import { queueStep } from '../../sequencer/queue/messages';
import { QueuedItem, QueueSource } from '../../sequencer/queue/types';
import { NodeRpc } from '../../sequencer/rpc';
import { blockOf, reportOf, rethExpected } from './rethChain';

// Заглушки для сервиса сборщика (sequencer/service.ts) без узла и без бинарников: узел L2 в
// памяти, отвечающий блоком 1 цепочки Reth (fixtures/evm_batches/reth), очередь L1 из одного её
// депозита и скрипты на месте хоста и rsp, поведение которых тест задаёт файлом. Нужны модульным
// тестам веток сервиса, которые на настоящем узле не воспроизвести (отчёт о другом блоке, сбой
// инструмента, срок приёма, устаревший кандидат).

export const FAKE_CHAIN_ID = BigInt(rethExpected.chainId);
const BLOCK = blockOf(1);

/** Отрезок блока 1: первый депозит очереди цепочки. */
export function fakeQueue(): QueueSource {
    const first = rethExpected.queue[0];
    if (first.kind !== 'deposit') throw new Error('первый элемент очереди цепочки — не депозит');
    const item: QueuedItem = {
        item: { kind: 'deposit', number: 1, l2Recipient: first.l2Recipient, amount: BigInt(first.amount) },
        message: { lt: '100', hash: 'aa'.repeat(32), number: 1 },
    };
    const head = { count: 1, hash: queueStep(0n, item.item) };
    return {
        read: async (from) => ({
            head,
            processed: { count: 0, hash: 0n },
            from,
            items: from.count === 0 ? [item] : [],
        }),
    };
}

export type FakeNode = {
    rpc: NodeRpc;
    calls: string[];
    /** Перезапуск узла: неканонические блоки в памяти теряются. */
    restart(): void;
    /** Подмена ответа на метод (после записи вызова). */
    override: Partial<Record<string, (params: unknown[]) => unknown>>;
    tags: { head: string; safe: string; finalized: string };
};

/** Узел в памяти: testing_buildBlockV1 отвечает блоком 1 цепочки (хеш — фикстуры), остальное — по нему. */
export function fakeNode(): FakeNode {
    const known = new Map<string, ExecutionPayload>();
    const canonical = new Map<number, string>([[0, GENESIS_HASH]]);
    const tags = { head: GENESIS_HASH, safe: GENESIS_HASH, finalized: GENESIS_HASH };
    const calls: string[] = [];
    const override: FakeNode['override'] = {};
    const blockByNumber = (number: number) => {
        const hash = canonical.get(number);
        if (!hash) return null;
        if (hash === GENESIS_HASH) return { hash, number: '0x0', timestamp: '0x0', parentHash: ZERO_HASH };
        const payload = known.get(hash)!;
        return { hash, number: payload.blockNumber, timestamp: payload.timestamp, parentHash: payload.parentHash };
    };
    const numberOfTag = (tag: string): number => {
        const named = (tags as Record<string, string>)[tag === 'latest' ? 'head' : tag];
        if (named) return named === GENESIS_HASH ? 0 : Number(BigInt(known.get(named)!.blockNumber));
        return Number(BigInt(tag));
    };
    const handlers: Record<string, (params: any[]) => unknown> = {
        eth_chainId: () => '0x' + FAKE_CHAIN_ID.toString(16),
        eth_getCode: ([address]) => (String(address).toLowerCase() === BRIDGE_ADDRESS ? BRIDGE_CODE : '0x'),
        eth_getBlockByNumber: ([tag]) => blockByNumber(numberOfTag(String(tag))),
        testing_buildBlockV1: ([request]: BuildRequest[]) => ({
            executionPayload: {
                parentHash: request.parentBlockHash,
                feeRecipient: request.payloadAttributes.suggestedFeeRecipient,
                stateRoot: ZERO_HASH,
                prevRandao: ZERO_HASH,
                blockNumber: '0x1',
                gasLimit: '0x' + GAS_LIMIT.toString(16),
                gasUsed: '0x0',
                timestamp: request.payloadAttributes.timestamp,
                extraData: '0x',
                blockHash: BLOCK.hash,
                transactions: request.transactions,
                withdrawals: request.payloadAttributes.withdrawals,
                blobGasUsed: '0x0',
                excessBlobGas: '0x0',
            } satisfies ExecutionPayload,
        }),
        engine_newPayloadV3: ([payload]: ExecutionPayload[]) => {
            known.set(payload.blockHash, payload);
            return { status: 'VALID' };
        },
        engine_forkchoiceUpdatedV3: ([state]: { headBlockHash: string; safeBlockHash: string; finalizedBlockHash: string }[]) => {
            if (state.headBlockHash !== GENESIS_HASH && !known.has(state.headBlockHash))
                return { payloadStatus: { status: 'SYNCING' } };
            const number = state.headBlockHash === GENESIS_HASH ? 0 : Number(BigInt(known.get(state.headBlockHash)!.blockNumber));
            // Как reth v2.2.0 (проверено): голова — предок нынешней → VALID и не меняется НИЧЕГО,
            // ни голова, ни safe, ни finalized.
            if (number < numberOfTag('head') && canonical.get(number) === state.headBlockHash)
                return { payloadStatus: { status: 'VALID' } };
            canonical.set(number, state.headBlockHash);
            for (const [height] of [...canonical]) if (height > number) canonical.delete(height);
            tags.head = state.headBlockHash;
            tags.safe = state.safeBlockHash;
            tags.finalized = state.finalizedBlockHash;
            return { payloadStatus: { status: 'VALID' } };
        },
        eth_getBlockReceipts: () => [],
        debug_getRawBlock: () => '0x' + reportOf(1).dataChunksHex.join(''),
        eth_getProof: () => ({ accountProof: [] }),
        // Пул: три перевода одного отправителя по 2 млн газа (бюджет пула по умолчанию — 5 млн).
        txpool_content: () => ({
            pending: {
                ['0x' + '99'.repeat(20)]: Object.fromEntries(
                    [0, 1, 2].map((nonce) => [
                        String(nonce),
                        {
                            hash: '0x' + String(nonce).repeat(64),
                            from: '0x' + '99'.repeat(20),
                            nonce: '0x' + nonce.toString(16),
                            type: '0x2',
                            chainId: '0x' + FAKE_CHAIN_ID.toString(16),
                            gas: '0x' + (2_000_000).toString(16),
                        },
                    ]),
                ),
            },
        }),
        eth_getRawTransactionByHash: ([hash]) => '0x02' + String(hash).slice(2, 10),
    };
    const call = async (method: string, params: unknown[]) => {
        calls.push(method);
        const handler = override[method] ?? handlers[method];
        if (!handler) throw new Error(`заглушка узла не знает метода ${method}`);
        return handler(params as any[]);
    };
    return {
        rpc: { eth: call as NodeRpc['eth'], engine: call as NodeRpc['engine'] },
        calls,
        override,
        tags,
        restart: () => {
            for (const [hash] of known) if (![...canonical.values()].includes(hash)) known.delete(hash);
        },
    };
}

/** Что делает скрипт-заглушка хоста: отчёт, код выхода, stderr; `failTimes` — сколько первых запусков упасть. */
export type HostBehaviour = {
    identity: object;
    report: object;
    exitCode?: number;
    stderr?: string;
    failTimes?: number;
    failExitCode?: number;
};

/**
 * Скрипты на месте хоста и rsp. Хост: `--identity` — печатает identity; расчёт — пишет report и
 * пустой вход батча либо падает, как велит файл поведения. rsp — пишет файл входа блока.
 */
export function fakeTools(dir: string) {
    mkdirSync(dir, { recursive: true });
    const behaviourFile = path.join(dir, 'host-behaviour.json');
    const host = path.join(dir, 'host.js');
    const rsp = path.join(dir, 'rsp.js');
    writeFileSync(
        host,
        `#!/usr/bin/env node
const fs = require('fs');
const file = ${JSON.stringify(behaviourFile)};
const b = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
if (args.includes('--identity')) { console.log(JSON.stringify(b.identity)); process.exit(0); }
// Форма принудительных: байты с 0xff — мусор (пропуск), остальные — годные от одного отправителя.
if (args.includes('--classify-forced')) {
  const items = JSON.parse(fs.readFileSync(arg('--classify-forced'), 'utf8'));
  const verdicts = items.map((hex, index) => hex.startsWith('0xff')
    ? { index, form: 'skipped', reason: 'мусор' }
    : { index, form: 'valid', signer: '0x' + 'ab'.repeat(20), hash: '0x' + '00'.repeat(32) });
  fs.writeFileSync(arg('--report'), JSON.stringify({ chainId: arg('--chain-id'), verdicts }));
  process.exit(0);
}
if (b.failTimes > 0) {
  b.failTimes--; fs.writeFileSync(file, JSON.stringify(b));
  process.stderr.write('Свидетель не продолжает предыдущий батч: не совпал хеш очереди.\\n');
  process.exit(b.failExitCode ?? 2);
}
if (b.exitCode) { process.stderr.write(b.stderr || ''); process.exit(b.exitCode); }
fs.writeFileSync(arg('--write-input'), '');
fs.writeFileSync(arg('--report'), JSON.stringify(b.report));
`,
    );
    writeFileSync(
        rsp,
        `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const dir = path.join(arg('--cache-dir'), 'input', ${JSON.stringify(FAKE_CHAIN_ID.toString())});
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, arg('--block-number') + '.bin'), '');
`,
    );
    chmodSync(host, 0o755);
    chmodSync(rsp, 0o755);
    const keys = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'evm_batches', 'program.json'), 'utf8'));
    const honestIdentity = {
        programElfSha256: '0x' + keys.programElfSha256,
        sourcesSha256: keys.sourcesSha256,
        sourcesSha256OnDisk: keys.sourcesSha256,
        hostSha256: 'cc'.repeat(32),
        hostSha256OnDisk: 'cc'.repeat(32),
    };
    const behave = (behaviour: Partial<HostBehaviour>) =>
        writeFileSync(behaviourFile, JSON.stringify({ identity: honestIdentity, report: reportOf(1), ...behaviour }));
    behave({});
    return { tools: { host, rsp, executeInZkvm: false }, behave, honestIdentity };
}
