import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { BRIDGE_ADDRESS, BRIDGE_CODE, GENESIS_HASH, genesisJson } from './protocol';
import { childEnv, track } from './children';
import { NodeRpc, rpcClient } from './rpc';

// Локальный узел reth v2.2.0 для сборщика: генезис протокола (мост-предустановка), JSON-RPC и
// Engine API только на 127.0.0.1, без пиров. Клиента консенсуса нет: блоки собирает сервис
// (testing_buildBlockV1), голову и финальность двигает он же (engine_forkchoiceUpdatedV3).
// Узел гасится при выходе процесса и по сигналам (children.ts) — фоновым он не остаётся.

export type NodeOptions = {
    reth: string;
    /** Каталог узла: генезис, секрет Engine API, база, журналы. */
    dir: string;
    chainId: bigint;
    httpPort: number;
    authPort: number;
    p2pPort: number;
};

export type RunningNode = {
    rpc: NodeRpc;
    rpcUrl: string;
    genesisPath: string;
    stop(): Promise<void>;
};

async function portBusy(port: number): Promise<boolean> {
    try {
        await fetch(`http://127.0.0.1:${port}`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(1000) });
        return true;
    } catch {
        return false;
    }
}

/** Пишет генезис (если его ещё нет — тот же файл переиспользуется) и секрет, поднимает узел. */
export async function startNode(options: NodeOptions): Promise<RunningNode> {
    for (const port of [options.httpPort, options.authPort]) {
        if (await portBusy(port)) throw new Error(`порт ${port} занят: на нём уже кто-то отвечает`);
    }
    mkdirSync(options.dir, { recursive: true });
    const genesisPath = path.join(options.dir, 'genesis.json');
    writeFileSync(genesisPath, JSON.stringify(genesisJson(options.chainId), null, 2));
    // Секрет Engine API — новый на каждый запуск узла: он живёт только в памяти сервиса и в
    // каталоге узла (вне репозитория).
    const secret = randomBytes(32);
    const jwtPath = path.join(options.dir, 'jwt.hex');
    writeFileSync(jwtPath, secret.toString('hex'), { mode: 0o600 });
    // mode действует только при создании файла: прежний файл с иными правами — тоже 600.
    chmodSync(jwtPath, 0o600);
    const child = track(spawn(
        'nice',
        [
            '-n',
            '15',
            options.reth,
            'node',
            '--chain',
            genesisPath,
            '--datadir',
            path.join(options.dir, 'data'),
            '--http',
            '--http.addr',
            '127.0.0.1',
            '--http.port',
            String(options.httpPort),
            '--http.api',
            'eth,debug,net,web3,testing,txpool',
            '--authrpc.addr',
            '127.0.0.1',
            '--authrpc.port',
            String(options.authPort),
            '--authrpc.jwtsecret',
            jwtPath,
            '--port',
            String(options.p2pPort),
            '--disable-discovery',
            '--ipcdisable',
            '--max-outbound-peers',
            '0',
            '--max-inbound-peers',
            '0',
            // Доказательства счетов отправителей принудительных транзакций берутся на родителе.
            '--rpc.eth-proof-window',
            '100000',
            // Блок сохраняется на диск сразу, как станет каноническим: перезапуск узла его не теряет.
            '--engine.persistence-threshold',
            '0',
            '--log.file.directory',
            path.join(options.dir, 'logs'),
        ],
        { stdio: 'ignore', env: childEnv() },
    ));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const rpcUrl = `http://127.0.0.1:${options.httpPort}`;
    const rpc: NodeRpc = { eth: rpcClient(rpcUrl), engine: rpcClient(`http://127.0.0.1:${options.authPort}`, secret) };
    const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([exited, new Promise((resolve) => (timer = setTimeout(resolve, 15_000)))]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
        }
    };
    try {
        for (let attempt = 0; ; attempt++) {
            if (child.exitCode !== null) throw new Error(`reth завершился при запуске (код ${child.exitCode})`);
            try {
                await rpc.eth('eth_blockNumber', []);
                break;
            } catch {
                if (attempt > 300) throw new Error('reth не поднялся за минуту');
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
        }
        await checkGenesis(rpc, options.chainId);
    } catch (error) {
        await stop();
        throw error;
    }
    return { rpc, rpcUrl, genesisPath, stop };
}

/** Узел — той цепочки и с тем генезисом, что закреплены протоколом. */
export async function checkGenesis(rpc: NodeRpc, chainId: bigint): Promise<void> {
    if (BigInt(await rpc.eth<string>('eth_chainId', [])) !== chainId) throw new Error('узел другой цепочки (chainId)');
    const genesis = await rpc.eth<{ hash: string }>('eth_getBlockByNumber', ['0x0', false]);
    if (genesis.hash !== GENESIS_HASH)
        throw new Error(`хеш генезиса у узла ${genesis.hash}, а константа протокола — ${GENESIS_HASH}`);
    if ((await rpc.eth<string>('eth_getCode', [BRIDGE_ADDRESS, '0x0'])) !== BRIDGE_CODE)
        throw new Error('по адресу моста в генезисе не код моста');
}
