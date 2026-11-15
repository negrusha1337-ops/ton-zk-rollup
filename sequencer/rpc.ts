import { createHmac } from 'crypto';

// JSON-RPC узла L2: обычный (eth_, debug_, testing_, txpool_) и Engine API под JWT (HS256).
// Узел слушает только 127.0.0.1: пространство testing и Engine API наружу не открываются.

export class RpcError extends Error {
    constructor(
        readonly method: string,
        readonly detail: unknown,
    ) {
        super(`${method}: ${JSON.stringify(detail)}`);
    }
}

export type RpcCall = <T = any>(method: string, params: unknown[]) => Promise<T>;

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Токен Engine API: HS256 от общего секрета узла, со временем выпуска «сейчас». */
export function engineToken(secret: Buffer, now = Math.floor(Date.now() / 1000)): string {
    const body = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iat: now }))}`;
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** Клиент JSON-RPC. С `jwtSecret` — для Engine API. Ошибка узла — исключение RpcError. */
export function rpcClient(url: string, jwtSecret?: Buffer, timeoutMs = 120_000): RpcCall {
    let id = 0;
    return async <T>(method: string, params: unknown[]): Promise<T> => {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(jwtSecret ? { authorization: `Bearer ${engineToken(jwtSecret)}` } : {}),
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new RpcError(method, { httpStatus: response.status });
        const answer = (await response.json()) as { result?: T; error?: unknown };
        if (answer.error !== undefined) throw new RpcError(method, answer.error);
        return answer.result as T;
    };
}

/** Узел L2 для сборщика: два клиента — обычный и Engine API. */
export type NodeRpc = { eth: RpcCall; engine: RpcCall };
