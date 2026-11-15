import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { emptyWithdrawalFrontier } from '../wrappers/rollupMath';
import { BuildRequest, ExecutionPayload } from './block/payload';
import { WithdrawalState } from './block/expected';
import { GENESIS_HASH } from './protocol';
import { MessageCursor, QueuedItem, QueueMark } from './queue/types';

// Состояние сервиса на диске. Один файл state.json (запись — временный файл и переименование) и
// каталоги блоков с тем, что нужно пруверу и отправщику. Перезапуск продолжает с записанного:
// кандидат, отданный узлу, не собирается заново (у нового было бы другое время и другой хеш).

/** Последний блок, принятый программой: от него строится следующий. */
export type Tip = {
    number: number;
    hash: string;
    timestamp: number;
    /** Отметка очереди после блока и сообщение её последнего элемента. */
    queue: QueueMark;
    cursor: MessageCursor | null;
    tree: WithdrawalState;
    /** Отчёт хоста о блоке (--previous-report следующего); у генезиса нет. */
    report: string | null;
};

/** Кандидат в работе. Фаза — что с ним уже сделано. */
export type Pending = {
    number: number;
    attempt: number;
    /** built — узел собрал; inserted — newPayload VALID; tentative — временная голова (нужна для свидетеля). */
    phase: 'built' | 'inserted' | 'tentative';
    withPool: boolean;
    request: BuildRequest;
    forcedCount: number;
    payload: ExecutionPayload;
    segment: QueuedItem[];
    /** Отправители годных по форме принудительных отрезка (для доказательств счетов). */
    signers: string[];
    dir: string;
};

/** Блок, принятый программой, и что с его батчем. */
export type BlockRecord = {
    number: number;
    hash: string;
    status: 'checked' | 'proven' | 'accepted';
    dir: string;
};

export type Rejection = { number: number; attempt: number; hash: string; reason: string; at: string };

export type SequencerState = {
    version: 1;
    chainId: string;
    tip: Tip;
    /** Последний батч, принятый контрактом (финальность узла). */
    accepted: { number: number; hash: string };
    pending: Pending | null;
    blocks: BlockRecord[];
    rejections: Rejection[];
};

// --- сериализация: bigint и Buffer — строками ---
const replacer = (_key: string, value: unknown) => {
    if (typeof value === 'bigint') return { $bigint: value.toString() };
    if (
        value &&
        typeof value === 'object' &&
        (value as { type?: string }).type === 'Buffer' &&
        Array.isArray((value as { data?: unknown }).data)
    ) {
        return { $buffer: Buffer.from((value as { data: number[] }).data).toString('hex') };
    }
    return value;
};
const reviver = (_key: string, value: unknown) => {
    if (value && typeof value === 'object') {
        if ('$bigint' in value) return BigInt((value as { $bigint: string }).$bigint);
        if ('$buffer' in value) return Buffer.from((value as { $buffer: string }).$buffer, 'hex');
    }
    return value;
};

export const serialize = (value: unknown) => JSON.stringify(value, replacer, 1) + '\n';
export const deserialize = <T>(text: string): T => JSON.parse(text, reviver) as T;

/** Запись через временный файл и переименование: прерванная запись не портит прежний файл. */
export function writeAtomically(file: string, contents: string | Buffer): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, contents);
    renameSync(temporary, file);
}

export function genesisState(chainId: bigint): SequencerState {
    return {
        version: 1,
        chainId: chainId.toString(),
        tip: {
            number: 0,
            hash: GENESIS_HASH,
            timestamp: 0,
            queue: { count: 0, hash: 0n },
            cursor: null,
            tree: { frontier: emptyWithdrawalFrontier(), count: 0n },
            report: null,
        },
        accepted: { number: 0, hash: GENESIS_HASH },
        pending: null,
        blocks: [],
        rejections: [],
    };
}

/** Каталог состояния по умолчанию: вне git (.tools в .gitignore). */
export const DEFAULT_STATE_DIR = path.join(__dirname, '..', '.tools', 'sequencer');

export class StateStore {
    readonly file: string;

    constructor(readonly dir: string) {
        this.file = path.join(dir, 'state.json');
    }

    load(chainId: bigint): SequencerState {
        if (!existsSync(this.file)) return genesisState(chainId);
        const state = deserialize<SequencerState>(readFileSync(this.file, 'utf8'));
        if (state.version !== 1) throw new Error(`state.json версии ${state.version}: сервис знает только версию 1`);
        if (state.chainId !== chainId.toString())
            throw new Error(`state.json — цепочки ${state.chainId}, а сервис запущен для ${chainId}`);
        return state;
    }

    save(state: SequencerState): void {
        writeAtomically(this.file, serialize(state));
    }

    blockDir(number: number): string {
        return path.join(this.dir, 'blocks', String(number));
    }

    candidateDir(number: number, attempt: number): string {
        return path.join(this.dir, 'work', `${number}-${attempt}`);
    }
}
