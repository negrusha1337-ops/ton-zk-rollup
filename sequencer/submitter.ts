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

/**
 * Запись исходящего журнала: внешнее сообщение кошельку ушло (или могло уйти) с этим seqno и
 * сроком. Пока запись есть, новое сообщение не шлётся: сначала выясняется, принял ли кошелёк
 * прежнее (seqno вырос — тогда ждать его следствия у контракта) или его срок истёк (время L1 позже
 * validUntil при прежнем seqno — сообщение не дошло и уже не дойдёт).
 */
type Outbox = { what: string; seqno: number; validUntil: number; effect: Effect; messageHash: string; sentAt: string };

export type TestnetSubmitterOptions = {
    chain: TonChain;
    rollup: Address;
    wallet: SequencerWallet;
    /** Каталог состояния сервиса: исходящий журнал — outbox.json. */
    stateDir: string;
    /** Пауза между опросами состояния, мс; по умолчанию 3 с. */
    pollMs?: number;
    /** Сколько опросов ждать одного изменения; по умолчанию 100 (5 минут). */
    pollAttempts?: number;
    /** Срок действия внешнего сообщения после времени L1, с; по умолчанию 120. */
    messageTtl?: number;
    log?: (line: string) => void;
};

const ton = (nano: bigint) => `${fromNano(nano)} TON`;

/**
 * Отправщик в testnet. Сообщения — переводы кошелька секвенсора (WALLET_MNEMONIC) на контракт с
 * суммами из wrappers/rollupValues.ts. Каждое ожидание — по состоянию контракта и кошелька (снимки
 * с временем блока), не по таймеру. Повтор после любого сбоя не шлёт дубль: исходящий журнал
 * (outbox.json, записывается ДО отправки) держит seqno и срок последнего сообщения.
 */
export class TestnetSubmitter implements BatchSubmitter {
    private readonly outboxFile: string;

    constructor(private readonly options: TestnetSubmitterOptions) {
        this.outboxFile = path.join(options.stateDir, 'outbox.json');
    }

    private log(line: string) {
        this.options.log?.(`отправщик: ${line}`);
    }

    /** Снимок счёта rollup'а: get-методы и время L1 из одного ответа. */
    snapshot(): Promise<AccountSnapshot> {
        return this.options.chain.account(this.options.rollup);
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
        throw new Error(`не дождался: ${description} (${attempts} опросов); повтор шага продолжит без дубля`);
    }

    /** Следствие сообщения уже видно у контракта (на свежем снимке). */
    private async effectHolds(effect: Effect): Promise<boolean> {
        const on = this.on(await this.snapshot());
        if (effect.kind === 'batchIndex') return (await on((rollup) => rollup.getRollupState())).batchIndex >= effect.atLeast;
        return (await on((rollup) => rollup.getBatchDataHash(effect.batch))) === effect.value;
    }

    /**
     * Прежнее сообщение из журнала: дождаться, пока кошелёк его примет (seqno вырос) и контракт
     * покажет его следствие, либо пока истечёт его срок. Журнал после этого пуст. Строка — отказ:
     * кошелёк сообщение отправил, а контракт его не учёл (отклонил).
     */
    private async settleOutbox(): Promise<string | null> {
        const outbox = this.readOutbox();
        if (!outbox) return null;
        const verdict = await this.poll(`кошелёк принял сообщение «${outbox.what}» (seqno ${outbox.seqno}) либо истёк его срок`, async () => {
            const snapshot = await this.options.chain.account(this.options.wallet.address);
            const { seqno } = await this.options.wallet.state(snapshot);
            if (seqno > outbox.seqno) return 'applied' as const;
            if (snapshot.utime > outbox.validUntil) return 'expired' as const;
            return null;
        });
        if (verdict === 'expired') {
            this.log(`сообщение «${outbox.what}» (seqno ${outbox.seqno}) не принято кошельком до срока ${outbox.validUntil}: не дошло`);
            rmSync(this.outboxFile, { force: true });
            return null;
        }
        const seen = await this.poll(`контракт учёл «${outbox.what}»`, async () => ((await this.effectHolds(outbox.effect)) ? true : null)).then(
            () => true,
            () => false,
        );
        rmSync(this.outboxFile, { force: true });
        if (!seen)
            return `сообщение «${outbox.what}» кошелёк отправил (seqno ${outbox.seqno}), а контракт его не учёл: смотрите транзакции контракта в обозревателе`;
        this.log(`«${outbox.what}» учтено контрактом`);
        return null;
    }

    /**
     * Одно сообщение на контракт: прежнее из журнала — до конца; следствие уже есть — ничего;
     * иначе запись в журнал, отправка и снова до конца (принято кошельком и учтено контрактом
     * либо истёк срок — тогда ещё попытка).
     */
    private async sendOnce(what: string, message: SenderArguments, effect: Effect): Promise<string | null> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const failed = await this.settleOutbox();
            if (failed) return failed;
            if (await this.effectHolds(effect)) return null;
            const snapshot = await this.options.chain.account(this.options.wallet.address);
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
            };
            // Журнал — ДО отправки: сбой между отправкой и записью иначе дал бы дубль.
            writeAtomically(this.outboxFile, serialize(outbox));
            this.log(`«${what}»: seqno ${wallet.seqno}, ${ton(message.value)}, действительно до ${validUntil}`);
            await this.options.chain.sendExternal(external);
        }
        const failed = await this.settleOutbox();
        if (failed) return failed;
        if (await this.effectHolds(effect)) return null;
        return `сообщение «${what}» не дошло до кошелька за три попытки (каждая — до конца срока)`;
    }

    async submit(batch: Batch): Promise<SubmitOutcome> {
        // Прежнее сообщение — сначала: пока оно в пути, состояние контракта ещё не окончательное.
        const pending = await this.settleOutbox();
        if (pending) return { accepted: false, reason: pending };
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
