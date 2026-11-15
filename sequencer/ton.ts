import { inspect } from 'util';
import {
    Address,
    beginCell,
    Cell,
    Contract,
    external,
    internal,
    OpenedContract,
    openContract,
    SendMode,
    SenderArguments,
    storeMessage,
} from '@ton/core';
import { mnemonicToPrivateKey, mnemonicValidate } from '@ton/crypto';
import { TonClient, WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import { Blockchain, createShardAccount } from '@ton/sandbox';
import { Rollup } from '../wrappers/Rollup';
import { retrying, TESTNET_V2 } from './queue/toncenter';

// Сеть TON для секвенсора: снимок счёта со временем блока, на котором он прочитан, get-методы на
// этом снимке, отправка внешнего сообщения кошельком секвенсора. Только testnet.
//
// Время и снимок (круг 20, пункт 1). У toncenter за балансировщиком серверы отстают по-разному:
// свежий отвечает временем, отстающий — состоянием. Поэтому состояние контракта и время, на котором
// оно верно, берутся ОДНИМ ответом (getAddressInformation: код, данные и sync_utime), а get-методы
// исполняются над этим снимком локально (эмулятор TVM из @ton/sandbox — тот же код контракта на
// тех же данных). Время L1 (`l1Now`) — sync_utime того же ответа.

/** global_id testnet (параметр конфига 19); у mainnet — −239. */
export const TESTNET_GLOBAL_ID = -3;

export type AccountSnapshot = {
    /** Время блока провайдера, на котором прочитан счёт (sync_utime), с. */
    utime: number;
    balance: bigint;
    state: 'active' | 'uninit' | 'frozen';
    code: Cell | null;
    data: Cell | null;
};

/** То, что секвенсору нужно от сети TON. Реализации: toncenter (testnet) и Sandbox (тесты). */
export interface TonChain {
    account(address: Address): Promise<AccountSnapshot>;
    /** Внешнее сообщение целиком (Message, сериализованное в ячейку). */
    sendExternal(message: Cell): Promise<void>;
    /** global_id сети: testnet — TESTNET_GLOBAL_ID. */
    globalId(): Promise<number>;
}

/** Адрес API — toncenter testnet, и только он (testnetGuard.ts: по адресу mainnet от testnet не отличить). */
export function assertTestnetEndpoint(endpoint: string): void {
    let host: string;
    try {
        host = new URL(endpoint).hostname;
    } catch {
        throw new Error(`адрес API «${endpoint}» не разбирается`);
    }
    if (host !== 'testnet.toncenter.com')
        throw new Error(`адрес API ${host}: секвенсор работает только с testnet.toncenter.com (стенд без аудита)`);
}

/** toncenter v2 testnet. Сеть сверяется ещё и по global_id (`globalId`). */
export class ToncenterChain implements TonChain {
    readonly client: TonClient;

    constructor(
        private readonly options: { endpoint?: string; apiKey?: string; limit: () => Promise<void> },
    ) {
        const endpoint = options.endpoint ?? TESTNET_V2;
        assertTestnetEndpoint(endpoint);
        this.client = new TonClient({ endpoint, apiKey: options.apiKey });
    }

    private call<T>(fn: () => Promise<T>): Promise<T> {
        return retrying(async () => {
            await this.options.limit();
            return fn();
        });
    }

    async account(address: Address): Promise<AccountSnapshot> {
        const info = await this.call(() => this.client.getContractState(address));
        if (!Number.isInteger(info.timestampt) || info.timestampt <= 0)
            throw new Error(`toncenter не сообщил время снимка счёта ${address.toString()}`);
        return {
            utime: info.timestampt,
            balance: info.balance,
            state: info.state === 'active' ? 'active' : info.state === 'frozen' ? 'frozen' : 'uninit',
            code: info.code ? Cell.fromBoc(info.code)[0] : null,
            data: info.data ? Cell.fromBoc(info.data)[0] : null,
        };
    }

    async sendExternal(message: Cell): Promise<void> {
        await this.call(() => this.client.sendFile(message.toBoc()));
    }

    async globalId(): Promise<number> {
        const endpoint = this.options.endpoint ?? TESTNET_V2;
        const answer = await this.call(async () => {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(this.options.apiKey ? { 'X-API-Key': this.options.apiKey } : {}) },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getConfigParam', params: { config_id: 19 } }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok) throw new Error(`toncenter getConfigParam ответил ${response.status}`);
            return (await response.json()) as { result?: { config?: { bytes?: string } } };
        });
        const bytes = answer.result?.config?.bytes;
        if (!bytes) throw new Error('toncenter не отдал параметр конфига 19 (global_id)');
        return Cell.fromBase64(bytes).beginParse().loadInt(32);
    }
}

// --- get-методы на снимке ---

let emulator: Promise<Blockchain> | null = null;
/** Снимки исполняются по одному: эмулятор общий, его время и счёт — на один вызов. */
let turn: Promise<unknown> = Promise.resolve();

/** Исполнить get-методы контракта над снимком счёта (локально, тем же кодом на тех же данных). */
export function onSnapshot<C extends Contract, T>(
    contract: C,
    snapshot: AccountSnapshot,
    use: (opened: OpenedContract<C>) => Promise<T>,
): Promise<T> {
    const { code, data } = snapshot;
    if (snapshot.state !== 'active' || !code || !data)
        return Promise.reject(new Error(`счёт ${contract.address.toString()} не активен (${snapshot.state}): get-методы исполнить не на чем`));
    const run = turn.then(async () => {
        emulator ??= Blockchain.create();
        const blockchain = await emulator;
        blockchain.now = snapshot.utime;
        await blockchain.setShardAccount(
            contract.address,
            createShardAccount({ address: contract.address, code, data, balance: snapshot.balance }),
        );
        return use(blockchain.openContract(contract) as unknown as OpenedContract<C>);
    });
    turn = run.catch(() => undefined);
    return run;
}

/** Состояние rollup'а на снимке: get-метод rollupState и время снимка. */
export const rollupOn = (address: Address, snapshot: AccountSnapshot) => <T>(use: (rollup: OpenedContract<Rollup>) => Promise<T>) =>
    onSnapshot(Rollup.createFromAddress(address), snapshot, use);

/**
 * Сообщение, которое отправила бы обёртка контракта (`wrappers/`), — без отправки: тело и сумма
 * берутся у той же функции, что в тестах и скриптах, чтобы не повторять раскладку тел.
 */
export async function messageOf<C extends Contract>(contract: C, send: (opened: OpenedContract<C>, via: { send(args: SenderArguments): Promise<void> }) => Promise<unknown>): Promise<SenderArguments> {
    let captured: SenderArguments | null = null;
    const via = { send: async (args: SenderArguments) => void (captured = args) };
    const opened = openContract(contract, () => ({
        internal: async (sender: typeof via, args: { value: bigint | string; bounce?: boolean | null; sendMode?: SendMode; body?: Cell | string | null }) =>
            sender.send({
                to: contract.address,
                value: typeof args.value === 'string' ? BigInt(args.value) : args.value,
                bounce: args.bounce ?? true,
                sendMode: args.sendMode,
                body: typeof args.body === 'string' || !args.body ? beginCell().endCell() : args.body,
            }),
        getState: () => Promise.reject(new Error('messageOf: только сборка сообщения')),
        get: () => Promise.reject(new Error('messageOf: только сборка сообщения')),
        external: () => Promise.reject(new Error('messageOf: только сборка сообщения')),
        open: () => {
            throw new Error('messageOf: только сборка сообщения');
        },
        getTransactions: () => Promise.reject(new Error('messageOf: только сборка сообщения')),
    }) as never);
    await send(opened, via);
    if (!captured) throw new Error('обёртка контракта не собрала сообщения');
    return captured;
}

// --- кошелёк секвенсора ---

export type WalletVersion = 'v4' | 'v5r1';

type AnyWallet = WalletContractV4 | WalletContractV5R1;

/**
 * Кошелёк секвенсора из мнемоники (как у Blueprint: WALLET_MNEMONIC, WALLET_VERSION, по желанию
 * WALLET_ID / SUBWALLET_NUMBER). Секретный ключ живёт только в замыкании этого объекта: не
 * печатается (inspect и JSON показывают адрес), не пишется на диск и не уходит в сообщения об ошибках.
 */
export class SequencerWallet {
    private constructor(
        readonly version: WalletVersion,
        readonly contract: AnyWallet,
        private readonly sign: (seqno: number, validUntil: number, messages: SenderArguments[]) => Cell,
    ) {}

    get address(): Address {
        return this.contract.address;
    }

    static async fromEnv(env: NodeJS.ProcessEnv = process.env): Promise<SequencerWallet> {
        const words = (env.WALLET_MNEMONIC ?? '').trim().split(/\s+/).filter(Boolean);
        const version = (env.WALLET_VERSION ?? '').trim().toLowerCase();
        if (words.length === 0 || version === '')
            throw new Error('кошелёк секвенсора: нужны переменные окружения WALLET_MNEMONIC и WALLET_VERSION (как у Blueprint)');
        if (version !== 'v4' && version !== 'v5r1')
            throw new Error(`кошелёк секвенсора: WALLET_VERSION=${version} не поддерживается — только v4 или v5r1`);
        const number = (name: string): number | undefined => {
            const value = env[name];
            if (value === undefined || value === '') return undefined;
            if (!/^\d+$/.test(value)) throw new Error(`кошелёк секвенсора: ${name} — не целое число`);
            return Number(value);
        };
        let keyPair: { publicKey: Buffer; secretKey: Buffer };
        try {
            if (!(await mnemonicValidate(words))) throw new Error('мнемоника не проходит проверку');
            keyPair = await mnemonicToPrivateKey(words);
        } catch {
            // Текст ошибки библиотеки может нести слова мнемоники — не пересказывается.
            throw new Error('кошелёк секвенсора: WALLET_MNEMONIC не разбирается как мнемоника TON');
        }
        const contract: AnyWallet =
            version === 'v4'
                ? WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId: number('WALLET_ID') })
                : WalletContractV5R1.create({
                      publicKey: keyPair.publicKey,
                      walletId: {
                          networkGlobalId: TESTNET_GLOBAL_ID,
                          context: { workchain: 0, subwalletNumber: number('SUBWALLET_NUMBER') ?? 0, walletVersion: 'v5r1' },
                      },
                  });
        const secretKey = keyPair.secretKey;
        const sign = (seqno: number, validUntil: number, messages: SenderArguments[]) =>
            (contract as unknown as { createTransfer(args: object): Cell }).createTransfer({
                seqno,
                secretKey,
                timeout: validUntil,
                sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
                messages: messages.map((message) =>
                    internal({ to: message.to, value: message.value, bounce: message.bounce ?? true, body: message.body ?? undefined }),
                ),
            });
        return new SequencerWallet(version, contract, sign);
    }

    /** seqno и баланс кошелька на снимке (неразвёрнутый — seqno 0). */
    async state(snapshot: AccountSnapshot): Promise<{ seqno: number; balance: bigint; deployed: boolean }> {
        if (snapshot.state !== 'active') return { seqno: 0, balance: snapshot.balance, deployed: false };
        const seqno = await onSnapshot(this.contract, snapshot, (wallet) => wallet.getSeqno());
        return { seqno, balance: snapshot.balance, deployed: true };
    }

    /** Внешнее сообщение кошельку: перевод `message` с этим seqno, действителен до `validUntil` (время L1). */
    external(seqno: number, validUntil: number, message: SenderArguments, deployed: boolean): Cell {
        const body = this.sign(seqno, validUntil, [message]);
        const ext = external({ to: this.address, init: deployed ? undefined : this.contract.init, body });
        return beginCell().store(storeMessage(ext)).endCell();
    }

    toJSON() {
        return { wallet: this.address.toString({ testOnly: true }), version: this.version };
    }

    [inspect.custom]() {
        return `SequencerWallet(${this.address.toString({ testOnly: true })}, ${this.version})`;
    }
}
