import { existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import { Address, beginCell, Cell, fromNano, Sender, SenderArguments, Transaction } from '@ton/core';
import { batchRootsOf, dataChunksOf, EvmBatchReport, publicInputOf } from '../wrappers/evmProofs';
import { BatchRoots, Rollup } from '../wrappers/Rollup';
import { dataHashStep } from '../wrappers/rollupMath';
import { ESCAPE_SERVICE_VALUE, PUBLISH_DATA_VALUE, SUBMIT_BATCH_VALUE } from '../wrappers/rollupValues';
import { BatchProof } from './prover';
import { deserialize, serialize, writeAtomically } from './state';
import { AccountSnapshot, messageOf, rollupOn, SequencerWallet, TonChain } from './ton';

// Отправщик батчей. Договор у всех реализаций один: данные батча (PublishData) — порциями, уже
// опубликованные не повторяются, чужие сбрасываются; до SubmitBatch публичный вход, который
// соберёт контракт, сверяется с 11 словами программы; принятый батч второй раз не шлётся.
// Реализации: SandboxSubmitter (Sandbox, двойник или настоящий контракт) и TestnetSubmitter
// (testnet: кошелёк по мнемонике, ожидание по состоянию контракта, исходящий журнал от дублей).

export type Batch = { number: number; blockHash: string; report: EvmBatchReport; proof: BatchProof };

export type SubmitOutcome = { accepted: true; alreadyAccepted: boolean } | { accepted: false; reason: string };

/**
 * Что контракт знает о батчах: номер последнего принятого и его корень (хеш блока), и время блока
 * L1, на котором это прочитано (круг 20, пункт 1): «не принят» верно ровно на это время.
 */
export type ContractBatchState = { batchIndex: number; stateRoot: bigint; utime: number };

/** Параметры развёртывания, которые сервис сверяет со своей конфигурацией при старте. */
export type ContractDeployment = { chainId: bigint; maxBlockAge: number };

export interface BatchSubmitter {
    submit(batch: Batch): Promise<SubmitOutcome>;
    /** Состояние контракта сейчас: сервис спрашивает его ДО проверки срока и до пересборки. */
    contractState(): Promise<ContractBatchState>;
    /** Параметры развёртывания контракта (get-метод deployment). */
    deployment(): Promise<ContractDeployment>;
}

/** Батч по номеру: уже принят, принят другим блоком, ждёт другого номера — или можно отправлять (null). */
function acceptanceOutcome(state: { batchIndex: number; stateRoot: bigint }, batch: Batch): SubmitOutcome | null {
    if (state.batchIndex > batch.number)
        return { accepted: false, reason: `контракт принял уже батч ${state.batchIndex} — дальше батча ${batch.number} сервиса` };
    if (state.batchIndex === batch.number) {
        if (state.stateRoot !== BigInt(batch.blockHash))
            return { accepted: false, reason: `контракт принял батч ${batch.number} с другим блоком 0x${state.stateRoot.toString(16)}` };
        return { accepted: true, alreadyAccepted: true };
    }
    if (state.batchIndex !== batch.number - 1)
        return { accepted: false, reason: `контракт ждёт батч ${state.batchIndex + 1}, а не ${batch.number}` };
    return null;
}

/** Публичный вход контракта против 11 слов программы. null — совпали. */
function publicInputProblem(required: bigint, report: EvmBatchReport): string | null {
    const proven = publicInputOf(report.publicValuesBytes);
    return required === proven
        ? null
        : `контракт ждёт публичный вход 0x${required.toString(16)}, а программа доказывает 0x${proven.toString(16)}`;
}

/** Двойник контракта в Sandbox, открытый тестом, и то, что тесту нужно знать об отправках. */
export type SandboxRollup = {
    getRollupState(): Promise<{ stateRoot: bigint; batchIndex: number }>;
    getBatchDataHash(batchIndex: number): Promise<bigint>;
    getExpectedPublicInput(roots: BatchRoots): Promise<bigint>;
    getDeployment(): Promise<{ chainId: bigint; maxBlockAge: number }>;
    sendPublishData(
        via: Sender,
        opts: { batchIndex: number; data: Cell; value: bigint },
    ): Promise<{ transactions: Transaction[] }>;
    sendDiscardBatchData(
        via: Sender,
        opts: { batchIndex: number; value: bigint },
    ): Promise<{ transactions: Transaction[] }>;
    sendSubmitBatch(
        via: Sender,
        opts: Parameters<Rollup['sendSubmitBatch']>[2],
    ): Promise<{ transactions: Transaction[] }>;
};

/** Исход транзакции контракта в результате отправки: успех либо код выхода. */
function contractOutcome(
    result: { transactions: Transaction[] },
    address: { equals(other: unknown): boolean },
): { success: boolean; exitCode: number | null } {
    for (const transaction of result.transactions) {
        const message = transaction.inMessage;
        if (!message || message.info.type !== 'internal' || !address.equals(message.info.dest)) continue;
        const description = transaction.description;
        if (description.type !== 'generic' || description.computePhase.type !== 'vm')
            return { success: false, exitCode: null };
        return {
            success: description.computePhase.success && !description.aborted,
            exitCode: description.computePhase.exitCode,
        };
    }
    return { success: false, exitCode: null };
}

export class SandboxSubmitter implements BatchSubmitter {
    constructor(
        private readonly rollup: SandboxRollup & { address: { equals(other: unknown): boolean } },
        private readonly sender: Sender,
        private readonly record: (result: { transactions: Transaction[] }) => void = () => {},
        /** Время L1 Sandbox (blockchain.now): время снимка состояния. */
        private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    ) {}

    async contractState(): Promise<ContractBatchState> {
        const { batchIndex, stateRoot } = await this.rollup.getRollupState();
        return { batchIndex, stateRoot, utime: this.now() };
    }

    async deployment(): Promise<ContractDeployment> {
        const { chainId, maxBlockAge } = await this.rollup.getDeployment();
        return { chainId, maxBlockAge };
    }

    async submit(batch: Batch): Promise<SubmitOutcome> {
        const early = acceptanceOutcome(await this.rollup.getRollupState(), batch);
        if (early) return early;

        // Данные батча: уже опубликованные целиком не повторяются, частично — сбрасываются.
        const chunks = dataChunksOf(batch.report);
        const want = BigInt(batch.report.publicValues.batchHash);
        const have = await this.rollup.getBatchDataHash(batch.number);
        if (have !== want) {
            if (have !== 0n) {
                const discarded = await this.rollup.sendDiscardBatchData(this.sender, {
                    batchIndex: batch.number,
                    value: PUBLISH_DATA_VALUE,
                });
                this.record(discarded);
                if (!contractOutcome(discarded, this.rollup.address).success)
                    return { accepted: false, reason: 'контракт не сбросил чужие данные батча' };
            }
            for (const data of chunks) {
                const published = await this.rollup.sendPublishData(this.sender, {
                    batchIndex: batch.number,
                    data,
                    value: PUBLISH_DATA_VALUE,
                });
                this.record(published);
                const outcome = contractOutcome(published, this.rollup.address);
                if (!outcome.success)
                    return { accepted: false, reason: `PublishData отвергнут (код ${outcome.exitCode})` };
            }
            if ((await this.rollup.getBatchDataHash(batch.number)) !== want)
                return { accepted: false, reason: 'хеш опубликованных данных не равен batchHash программы' };
        }

        // Публичный вход, который контракт соберёт из своего хранилища, — ровно 11 слов программы.
        const roots = batchRootsOf(batch.report);
        const problem = publicInputProblem(await this.rollup.getExpectedPublicInput(roots), batch.report);
        if (problem) return { accepted: false, reason: problem };
        const hints = batch.proof.hintsBoc ? Cell.fromBase64(batch.proof.hintsBoc) : beginCell().endCell();
        const submitted = await this.rollup.sendSubmitBatch(this.sender, {
            proof: batch.proof.proof,
            hints,
            roots,
            value: SUBMIT_BATCH_VALUE,
        });
        this.record(submitted);
        const outcome = contractOutcome(submitted, this.rollup.address);
        if (!outcome.success) return { accepted: false, reason: `SubmitBatch отвергнут (код ${outcome.exitCode})` };
        const after = await this.rollup.getRollupState();
        if (after.batchIndex !== batch.number || after.stateRoot !== BigInt(batch.blockHash))
            return { accepted: false, reason: 'после SubmitBatch состояние контракта не то' };
        return { accepted: true, alreadyAccepted: false };
    }
}


// --- testnet ---

/** Чем контракт показывает, что сообщение учтено: хеш данных батча или номер принятого батча. */
type Effect = { kind: 'dataHash'; batch: number; value: bigint } | { kind: 'batchIndex'; atLeast: number };

const sameEffect = (a: Effect, b: Effect): boolean =>
    a.kind === 'dataHash' && b.kind === 'dataHash'
        ? a.batch === b.batch && a.value === b.value
        : a.kind === 'batchIndex' && b.kind === 'batchIndex' && a.atLeast === b.atLeast;

/**
 * Запись исходящего журнала: внешнее сообщение кошельку ушло (или могло уйти) с этим seqno и
 * сроком. Пока запись есть, новое сообщение не шлётся: сначала выясняется, принял ли кошелёк
 * прежнее (seqno вырос — тогда ждать его следствия у контракта) или его срок истёк (время L1 позже
 * validUntil + expiryMargin при прежнем seqno — сообщение не дошло и уже не дойдёт).
 * `bodyHash` и `sentUtime` — чтобы узнать транзакцию контракта с этим сообщением (отказ — сразу).
 */
type Outbox = {
    what: string;
    seqno: number;
    validUntil: number;
    effect: Effect;
    messageHash: string;
    sentAt: string;
    bodyHash?: string;
    sentUtime?: number;
};

/** Чем кончилось прежнее сообщение из журнала. */
type Settled =
    | { kind: 'none' }
    | { kind: 'expired' }
    | { kind: 'seen'; effect: Effect }
    | { kind: 'failed'; reason: string };

export type TestnetSubmitterOptions = {
    chain: TonChain;
    rollup: Address;
    wallet: SequencerWallet;
    /** Каталог состояния сервиса: исходящий журнал — outbox.json, время снимков — l1-seen.json. */
    stateDir: string;
    /** Пауза между опросами состояния, мс; по умолчанию 3 с. */
    pollMs?: number;
    /** Сколько опросов ждать одного изменения; по умолчанию 100 (5 минут). */
    pollAttempts?: number;
    /** Срок действия внешнего сообщения после времени L1, с; по умолчанию 120. */
    messageTtl?: number;
    /**
     * Запас после срока сообщения, с (круг 21, 5б): «не дошло» — только при времени L1 позже
     * validUntil + expiryMargin. Отстающий сервер toncenter иначе дал бы дубль. По умолчанию 60.
     */
    expiryMargin?: number;
    /** Сколько раз перечитать снимок старее уже виденного (круг 21, 1); по умолчанию 20. */
    staleRereads?: number;
    /** Перепроверка своей блокировки каталога — перед каждой отправкой (круг 21, 5в). */
    assertHeld?: () => void;
    log?: (line: string) => void;
};

const ton = (nano: bigint) => `${fromNano(nano)} TON`;

/** Снимок старее уже виденного не уходит за `staleRereads` перечитываний (круг 21, пункт 1). */
export class StaleSnapshot extends Error {}

/** Ожидание по состоянию не дождалось изменения за `pollAttempts` опросов. */
class PollTimeout extends Error {}

/**
 * Отправщик в testnet. Сообщения — переводы кошелька секвенсора (WALLET_MNEMONIC) на контракт с
 * суммами из wrappers/rollupValues.ts. Каждое ожидание — по состоянию контракта и кошелька (снимки
 * с временем блока), не по таймеру. Повтор после любого сбоя не шлёт дубль: исходящий журнал
 * (outbox.json, записывается ДО отправки) держит seqno и срок последнего сообщения.
 *
 * Снимки монотонны (круг 21, пункт 1): у toncenter за балансировщиком следующий ответ может прийти
 * от отстающего сервера — с прежним seqno кошелька и прежним хешем данных, что дало бы дубль порции
 * или сообщение с негодным seqno. Поэтому по каждому адресу помнится наибольшее время снимка (в
 * процессе и в stateDir/l1-seen.json — переживает перезапуск), и снимок старее него перечитывается.
 */
export class TestnetSubmitter implements BatchSubmitter {
    private readonly outboxFile: string;
    private readonly seenFile: string;
    private readonly seen: Map<string, number>;

    constructor(private readonly options: TestnetSubmitterOptions) {
        this.outboxFile = path.join(options.stateDir, 'outbox.json');
        this.seenFile = path.join(options.stateDir, 'l1-seen.json');
        this.seen = new Map(Object.entries(this.readSeen()));
    }

    private log(line: string) {
        this.options.log?.(`отправщик: ${line}`);
    }

    private readSeen(): Record<string, number> {
        if (!existsSync(this.seenFile)) return {};
        const parsed = JSON.parse(readFileSync(this.seenFile, 'utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Object.values(parsed).some((value) => !Number.isInteger(value)))
            throw new Error(`${this.seenFile}: не таблица «адрес → время снимка»`);
        return parsed as Record<string, number>;
    }

    /** Запомнить время снимка: в процессе и на диске (наибольшее из записанного и нового). */
    private remember(key: string, utime: number): void {
        if (utime <= (this.seen.get(key) ?? 0)) return;
        this.seen.set(key, utime);
        const merged = { ...this.readSeen() };
        for (const [address, time] of this.seen) merged[address] = Math.max(merged[address] ?? 0, time);
        writeAtomically(this.seenFile, JSON.stringify(merged, null, 1) + '\n');
    }

    /** Снимок счёта не старее уже виденного по этому адресу; старее — перечитать (с паузой и пределом). */
    private async fresh(address: Address): Promise<AccountSnapshot> {
        const key = address.toRawString();
        const rereads = this.options.staleRereads ?? 20;
        for (let attempt = 0; ; attempt++) {
            const floor = this.seen.get(key) ?? 0;
            const snapshot = await this.options.chain.account(address);
            if (snapshot.utime >= floor) {
                this.remember(key, snapshot.utime);
                return snapshot;
            }
            if (attempt >= rereads)
                throw new StaleSnapshot(
                    `снимок счёта ${address.toString({ testOnly: true })} на время ${snapshot.utime}, а уже виден снимок на ${floor}: ` +
                        `${rereads + 1} ответов подряд от отстающего сервера; повтор шага продолжит без дубля`,
                );
            await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 3000));
        }
    }

    /** Снимок счёта rollup'а: get-методы и время L1 из одного ответа, не старее уже виденного. */
    snapshot(): Promise<AccountSnapshot> {
        return this.fresh(this.options.rollup);
    }

    /** Время L1 — время блока провайдера в снимке счёта rollup'а. */
    async l1Now(): Promise<number> {
        return (await this.snapshot()).utime;
    }

    private on(snapshot: AccountSnapshot) {
        return rollupOn(this.options.rollup, snapshot);
    }

    async contractState(): Promise<ContractBatchState> {
        const snapshot = await this.snapshot();
        const { batchIndex, stateRoot } = await this.on(snapshot)((rollup) => rollup.getRollupState());
        return { batchIndex, stateRoot, utime: snapshot.utime };
    }

    async deployment(): Promise<ContractDeployment> {
        const deployment = await this.on(await this.snapshot())((rollup) => rollup.getDeployment());
        if (!deployment.sequencer.equals(this.options.wallet.address))
            throw new Error(
                `секвенсор контракта — ${deployment.sequencer.toString({ testOnly: true })}, а кошелёк из WALLET_MNEMONIC — ` +
                    `${this.options.wallet.address.toString({ testOnly: true })}: батчи от него контракт не примет`,
            );
        return { chainId: deployment.chainId, maxBlockAge: deployment.maxBlockAge };
    }

    private readOutbox(): Outbox | null {
        return existsSync(this.outboxFile) ? deserialize<Outbox>(readFileSync(this.outboxFile, 'utf8')) : null;
    }

    private async poll<T>(description: string, check: () => Promise<T | null>): Promise<T> {
        const attempts = this.options.pollAttempts ?? 100;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const value = await check();
            if (value !== null) return value;
            await new Promise((resolve) => setTimeout(resolve, this.options.pollMs ?? 3000));
        }
        throw new PollTimeout(`не дождался: ${description} (${attempts} опросов); повтор шага продолжит без дубля`);
    }

    /** Следствие сообщения уже видно у контракта (на снимке не старее виденного). */
    private async effectHolds(effect: Effect): Promise<boolean> {
        const on = this.on(await this.snapshot());
        if (effect.kind === 'batchIndex') return (await on((rollup) => rollup.getRollupState())).batchIndex >= effect.atLeast;
        return (await on((rollup) => rollup.getBatchDataHash(effect.batch))) === effect.value;
    }

    /**
     * Транзакция контракта с сообщением из журнала, если контракт его отверг (круг 21, 5е): код
     * выхода. null — такой транзакции нет (ещё не дошла) или она успешна. Сеть без списка
     * транзакций — null: тогда отказ виден только по истечении ожидания.
     */
    private async rejectedByContract(outbox: Outbox): Promise<string | null> {
        const list = this.options.chain.transactions;
        if (!list || !outbox.bodyHash || outbox.sentUtime === undefined) return null;
        for (const transaction of await list.call(this.options.chain, this.options.rollup, 16)) {
            const message = transaction.inMessage;
            if (!message || message.info.type !== 'internal' || !this.options.wallet.address.equals(message.info.src)) continue;
            if (transaction.now < outbox.sentUtime || message.body.hash().toString('hex') !== outbox.bodyHash) continue;
            const description = transaction.description;
            if (description.type !== 'generic') return 'транзакция не обычная';
            if (description.computePhase.type !== 'vm') return `вычисление пропущено (${description.computePhase.reason})`;
            if (!description.computePhase.success) return `код ${description.computePhase.exitCode}`;
            if (description.aborted) return `фаза действий не прошла (код вычисления ${description.computePhase.exitCode})`;
        }
        return null;
    }

    /**
     * Прежнее сообщение из журнала: дождаться, пока кошелёк его примет (seqno вырос) и контракт
     * покажет его следствие (или отвергнет его), либо пока истечёт его срок. Журнал после этого пуст.
     */
    private async settleOutbox(): Promise<Settled> {
        const outbox = this.readOutbox();
        if (!outbox) return { kind: 'none' };
        const margin = this.options.expiryMargin ?? 60;
        const verdict = await this.poll(`кошелёк принял сообщение «${outbox.what}» (seqno ${outbox.seqno}) либо истёк его срок`, async () => {
            const snapshot = await this.fresh(this.options.wallet.address);
            const { seqno } = await this.options.wallet.state(snapshot);
            if (seqno > outbox.seqno) return 'applied' as const;
            if (snapshot.utime > outbox.validUntil + margin) return 'expired' as const;
            return null;
        });
        if (verdict === 'expired') {
            this.log(`сообщение «${outbox.what}» (seqno ${outbox.seqno}) не принято кошельком до срока ${outbox.validUntil} (+${margin} с): не дошло`);
            rmSync(this.outboxFile, { force: true });
            return { kind: 'expired' };
        }
        const result = await this.poll(`контракт учёл «${outbox.what}»`, async () => {
            if (await this.effectHolds(outbox.effect)) return { seen: true as const };
            const rejected = await this.rejectedByContract(outbox);
            return rejected === null ? null : { seen: false as const, rejected };
        }).catch((error) => {
            // Сбой сети — не ответ контракта: журнал остаётся, повтор шага продолжит ожидание.
            if (error instanceof PollTimeout) return { seen: false as const, rejected: null };
            throw error;
        });
        rmSync(this.outboxFile, { force: true });
        if (!result.seen && result.rejected !== null)
            return { kind: 'failed', reason: `контракт отверг сообщение «${outbox.what}» (${result.rejected}): смотрите транзакции контракта в обозревателе` };
        if (!result.seen)
            return {
                kind: 'failed',
                reason: `сообщение «${outbox.what}» кошелёк отправил (seqno ${outbox.seqno}), а контракт его не учёл: смотрите транзакции контракта в обозревателе`,
            };
        this.log(`«${outbox.what}» учтено контрактом`);
        return { kind: 'seen', effect: outbox.effect };
    }

    /** Довести прежнее сообщение: строка — отказ, true — это и было ожидаемое следствие, false — нет. */
    private async settled(effect: Effect): Promise<string | boolean> {
        const settled = await this.settleOutbox();
        if (settled.kind === 'failed') return settled.reason;
        // Следствие только что увидено: повторная проверка по новому снимку не нужна (круг 21, 1).
        return settled.kind === 'seen' && sameEffect(settled.effect, effect);
    }

    /**
     * Одно сообщение на контракт: прежнее из журнала — до конца; следствие уже есть — ничего;
     * иначе запись в журнал, отправка и снова до конца (принято кошельком и учтено контрактом
     * либо истёк срок — тогда ещё попытка).
     */
    private async sendOnce(what: string, message: SenderArguments, effect: Effect): Promise<string | null> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const done = await this.settled(effect);
            if (typeof done === 'string') return done;
            if (done || (await this.effectHolds(effect))) return null;
            const snapshot = await this.fresh(this.options.wallet.address);
            const wallet = await this.options.wallet.state(snapshot);
            if (wallet.balance < message.value)
                return `на кошельке секвенсора ${ton(wallet.balance)}, а сообщению «${what}» нужно ${ton(message.value)} и комиссия`;
            const validUntil = snapshot.utime + (this.options.messageTtl ?? 120);
            const external = this.options.wallet.external(wallet.seqno, validUntil, message, wallet.deployed);
            const outbox: Outbox = {
                what,
                seqno: wallet.seqno,
                validUntil,
                effect,
                messageHash: external.hash().toString('hex'),
                sentAt: new Date().toISOString(),
                bodyHash: (message.body ?? beginCell().endCell()).hash().toString('hex'),
                sentUtime: snapshot.utime,
            };
            // Отправка — только под своей блокировкой каталога (круг 21, 5в).
            this.options.assertHeld?.();
            // Журнал — ДО отправки: сбой между отправкой и записью иначе дал бы дубль.
            writeAtomically(this.outboxFile, serialize(outbox));
            this.log(`«${what}»: seqno ${wallet.seqno}, ${ton(message.value)}, действительно до ${validUntil}`);
            await this.options.chain.sendExternal(external);
        }
        const done = await this.settled(effect);
        if (typeof done === 'string') return done;
        if (done || (await this.effectHolds(effect))) return null;
        return `сообщение «${what}» не дошло до кошелька за три попытки (каждая — до конца срока)`;
    }

    async submit(batch: Batch): Promise<SubmitOutcome> {
        // Прежнее сообщение — сначала: пока оно в пути, состояние контракта ещё не окончательное.
        const pending = await this.settleOutbox();
        if (pending.kind === 'failed') return { accepted: false, reason: pending.reason };
        const early = acceptanceOutcome(await this.contractState(), batch);
        if (early) return early;
        const rollup = Rollup.createFromAddress(this.options.rollup);
        const dataHash = async () => this.on(await this.snapshot())((opened) => opened.getBatchDataHash(batch.number));

        // Данные: префиксы хеша — что уже опубликовано (продолжить), иначе чужое (сбросить).
        const chunks = dataChunksOf(batch.report);
        const prefixes = chunks.reduce((hashes, chunk) => [...hashes, dataHashStep(hashes[hashes.length - 1], chunk)], [0n]);
        if (prefixes[prefixes.length - 1] !== BigInt(batch.report.publicValues.batchHash))
            return { accepted: false, reason: 'хеш порций данных отчёта не равен batchHash программы' };
        if (!prefixes.includes(await dataHash())) {
            const discard = await messageOf(rollup, (opened, via) =>
                opened.sendDiscardBatchData(via as Sender, { batchIndex: batch.number, value: ESCAPE_SERVICE_VALUE }),
            );
            const failed = await this.sendOnce(`сброс чужих данных батча ${batch.number}`, discard, { kind: 'dataHash', batch: batch.number, value: 0n });
            if (failed) return { accepted: false, reason: failed };
        }
        for (;;) {
            const published = prefixes.indexOf(await dataHash());
            if (published < 0) return { accepted: false, reason: `данные батча ${batch.number} у контракта изменились посторонним сообщением` };
            if (published === chunks.length) break;
            const chunk = await messageOf(rollup, (opened, via) =>
                opened.sendPublishData(via as Sender, { batchIndex: batch.number, data: chunks[published], value: PUBLISH_DATA_VALUE }),
            );
            const failed = await this.sendOnce(`данные батча ${batch.number}, порция ${published + 1} из ${chunks.length}`, chunk, {
                kind: 'dataHash',
                batch: batch.number,
                value: prefixes[published + 1],
            });
            if (failed) return { accepted: false, reason: failed };
        }

        // Публичный вход — на снимке с опубликованными данными.
        const roots = batchRootsOf(batch.report);
        const required = await this.on(await this.snapshot())((opened) => opened.getExpectedPublicInput(roots));
        const problem = publicInputProblem(required, batch.report);
        if (problem) return { accepted: false, reason: problem };
        const hints = batch.proof.hintsBoc ? Cell.fromBase64(batch.proof.hintsBoc) : beginCell().endCell();
        const submit = await messageOf(rollup, (opened, via) =>
            opened.sendSubmitBatch(via as Sender, { proof: batch.proof.proof, hints, roots, value: SUBMIT_BATCH_VALUE }),
        );
        const failed = await this.sendOnce(`батч ${batch.number}`, submit, { kind: 'batchIndex', atLeast: batch.number });
        if (failed) return { accepted: false, reason: failed };
        const final = acceptanceOutcome(await this.contractState(), batch);
        if (!final || !final.accepted) return final ?? { accepted: false, reason: 'после SubmitBatch контракт не принял батч' };
        return { accepted: true, alreadyAccepted: false };
    }
}
