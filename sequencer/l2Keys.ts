import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { childEnv } from './children';
import { BRIDGE_ADDRESS, FORCED_TX_GAS_CAP } from './protocol';

// Счета L2 для нагрузки на сервис (scripts/sequencerTraffic.ts): ключи secp256k1 в памяти, адрес
// и подпись транзакций EIP-1559 — отдельным процессом sequencer/testing/evm-wallet.mjs (jest не
// импортирует @noble/curves, только ESM); ключ идёт ему на stdin, не в аргументы.
//
// На диск — только ключи счетов, с которых будет принудительный вывод (без ключа его не
// подписать): `.tools/sequencer-traffic/keys.json`, права 600, каталог вне git (.tools/). Это
// тестовые ключи L2 без ценности, но в репозиторий они не попадают. У счетов только для депозита
// ключ остаётся в памяти и пропадает: хранится один адрес (в журнале нагрузки).

export const DEFAULT_TRAFFIC_DIR = path.join(__dirname, '..', '.tools', 'sequencer-traffic');
const WALLET_SCRIPT = path.join(__dirname, 'testing', 'evm-wallet.mjs');
/** Порядок группы secp256k1: годный ключ — от 1 до n − 1. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GWEI = 1_000_000_000n;

export type L2Account = { address: string; secret: Buffer };

/** Запись keys.json: ключ счёта L2 нагрузки (hex) и контракт, под который он заведён. */
export type StoredL2Key = { address: string; secret: string; rollup: string; createdAt: string };

type WalletAnswer = { address: string; raw: string[] };

function walletProcess(secret: Buffer, transactions: object[]): WalletAnswer {
    const output = execFileSync(process.execPath, [WALLET_SCRIPT], {
        input: JSON.stringify({ secret: secret.toString('hex'), transactions }),
        encoding: 'utf8',
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const answer = JSON.parse(output) as WalletAnswer;
    if (!/^0x[0-9a-f]{40}$/.test(answer.address)) throw new Error('evm-wallet.mjs вернул не адрес L2');
    return answer;
}

/** Новый счёт L2: ключ из системного источника случайности, адрес — keccak открытого ключа. */
export function newL2Account(): L2Account {
    for (;;) {
        const secret = randomBytes(32);
        const value = BigInt('0x' + secret.toString('hex'));
        if (value === 0n || value >= SECP256K1_N) continue;
        return { address: walletProcess(secret, []).address, secret };
    }
}

/**
 * Принудительный вывод через мост: EIP-1559, получатель — мост, данные — 32 байта хеша адреса
 * получателя на L1, сумма — в нанотонах (1 нанотон = 1 gwei), лимит газа — предел принудительной
 * транзакции программы, цены — те, что у сценария Reth (maxFee 2 gwei, чаевые 1 gwei).
 */
export function signBridgeWithdrawal(
    account: L2Account,
    fields: { chainId: bigint; nonce: number; amountNano: bigint; recipientHash: bigint },
): Buffer {
    const answer = walletProcess(account.secret, [
        {
            type: 2,
            chainId: fields.chainId.toString(),
            nonce: fields.nonce,
            gas: FORCED_TX_GAS_CAP.toString(),
            to: BRIDGE_ADDRESS,
            value: (fields.amountNano * GWEI).toString(),
            data: '0x' + fields.recipientHash.toString(16).padStart(64, '0'),
            maxFee: (2n * GWEI).toString(),
            maxPriority: GWEI.toString(),
        },
    ]);
    if (answer.address !== account.address) throw new Error('evm-wallet.mjs подписал другим ключом');
    return Buffer.from(answer.raw[0].slice(2), 'hex');
}

/** Ключи из keys.json (нет файла — пусто). Права шире 600 — отказ: файл кто-то трогал. */
export function loadL2Keys(file: string): StoredL2Key[] {
    if (!existsSync(file)) return [];
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new Error(`${file}: права ${mode.toString(8)}, а должны быть 600 — проверьте, кто менял файл, и верните chmod 600`);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`${file}: не список ключей`);
    return parsed as StoredL2Key[];
}

/** Дописать ключ в keys.json атомарно, права 600 (и у прежнего файла). */
export function storeL2Key(file: string, entry: StoredL2Key): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const keys = [...loadL2Keys(file).filter((key) => key.address !== entry.address), entry];
    // Временный файл сразу с правами 600: ни в один момент ключи не лежат с правами по umask.
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify(keys, null, 1) + '\n', { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
}

/** Счёт по записи keys.json. */
export const accountOf = (key: StoredL2Key): L2Account => ({ address: key.address, secret: Buffer.from(key.secret, 'hex') });
