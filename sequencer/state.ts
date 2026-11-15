import { randomBytes } from 'crypto';
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'fs';
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
    /**
     * Отрезок этого блока обрезан перед принудительной от счёта с депозитом в том же отрезке
     * (chooseSegment): следующий блок так не режется. Нет поля — не обрезан.
     */
    cut?: boolean;
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
    /** Отрезок обрезан правилом депозита (chooseSegment); вершина запомнит это. */
    cut?: boolean;
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

/** fsync открытого на чтение пути (файла или каталога). */
function syncPath(target: string): void {
    const fd = openSync(target, 'r');
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/**
 * Запись через временный файл и переименование: прерванная запись не портит прежний файл.
 * Файл сбрасывается на диск до переименования, каталог — после: иначе после сбоя питания на
 * месте файла могло бы оказаться пустое содержимое или прежнее имя.
 */
export function writeAtomically(file: string, contents: string | Buffer): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    const fd = openSync(temporary, 'w');
    try {
        writeFileSync(fd, contents);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(temporary, file);
    syncPath(path.dirname(file));
}

/** Каталог состояния занят другим экземпляром сервиса. */
export class StateDirBusy extends Error {}

/** Блокировки каталогов состояния, которые держит этот процесс: токен → файл. */
const heldLocks = new Map<string, string>();
let exitHookInstalled = false;

const processAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM — процесс есть, но чужой: он жив.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

/**
 * Блокировка каталога состояния: файл `sequencer.lock`, созданный с O_EXCL, в нём pid и токен
 * владельца. Занят живым процессом (или другим открытым экземпляром в этом же процессе) —
 * отказ StateDirBusy; хозяин мёртв — блокировка снимается и берётся заново. Возвращает функцию
 * снятия; при выходе процесса снимаются все.
 */
export function lockStateDir(dir: string): () => void {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sequencer.lock');
    const token = randomBytes(16).toString('hex');
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const fd = openSync(file, 'wx', 0o600);
            try {
                writeFileSync(fd, JSON.stringify({ pid: process.pid, token }) + '\n');
                fsyncSync(fd);
            } finally {
                closeSync(fd);
            }
            heldLocks.set(token, file);
            if (!exitHookInstalled) {
                exitHookInstalled = true;
                process.on('exit', () => heldLocks.forEach((held) => rmSync(held, { force: true })));
            }
            return () => {
                if (!heldLocks.delete(token)) return;
                rmSync(file, { force: true });
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        let owner: { pid?: number; token?: string } = {};
        try {
            owner = JSON.parse(readFileSync(file, 'utf8'));
        } catch {
            // Файл без содержимого: хозяин упал между созданием и записью — блокировка мёртвая.
        }
        const pid = Number(owner.pid);
        if (Number.isInteger(pid) && pid > 0) {
            if (pid === process.pid && owner.token && heldLocks.has(owner.token))
                throw new StateDirBusy(
                    `каталог состояния ${dir} занят другим экземпляром сервиса в этом же процессе (${file})`,
                );
            if (pid !== process.pid && processAlive(pid))
                throw new StateDirBusy(
                    `каталог состояния ${dir} занят сервисом с pid ${pid} (${file}): второй экземпляр не запускается`,
                );
        }
        rmSync(file, { force: true });
    }
    throw new StateDirBusy(`блокировку каталога состояния ${dir} не удалось взять (${file})`);
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

    /** Новый каталог кандидата: у каждой сборки свой (у пересобранного устаревшего — тоже). */
    candidateDir(number: number, attempt: number): string {
        const base = path.join(this.dir, 'work', `${number}-${attempt}`);
        for (let index = 1; ; index++) {
            const dir = index === 1 ? base : `${base}.${index}`;
            if (existsSync(dir)) continue;
            mkdirSync(dir, { recursive: true });
            return dir;
        }
    }
}
