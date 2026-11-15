import { randomBytes } from 'crypto';
import {
    closeSync,
    fsyncSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';

// Блокировка каталога состояния: второй экземпляр сервиса на том же каталоге не запускается.
//
// Файл `sequencer.lock` с pid, именем машины и токеном владельца. Правила (круг 19):
// - файл появляется сразу целиком: пишется во временный файл и ставится на место `link` — тот,
//   как O_EXCL, отказывает, если файл уже есть; недописанной своей блокировки не бывает;
// - «моя ли блокировка» решает ТОЛЬКО токен: pid в контейнере у всех экземпляров — 1;
// - чужой токен и живой pid на этой машине — занят; другая машина — занят (жив ли хозяин, не
//   проверить); файл без разбираемого содержимого моложе LOCK_WRITE_GRACE_MS — занят (кто-то
//   пишет), старше — мёртв;
// - мёртвую блокировку снимают переименованием в уникальное имя, а не удалением: если между
//   чтением и снятием её успел снять и взять другой экземпляр, под уникальным именем окажется ЕГО
//   живая блокировка — это видно по токену, и она возвращается на место (`link`), а не удаляется;
// - свою блокировку снимают так же: переименование, сверка токена, чужая — назад.
// Остаток: если между ошибочным снятием и возвратом третий экземпляр успел создать файл,
// возврат не удаётся и об этом говорит ошибка; для этого нужны три запуска в одни миллисекунды.

/** Каталог состояния занят другим экземпляром сервиса. */
export class StateDirBusy extends Error {}

/** Сколько файл блокировки без содержимого считается «пишется», а не мёртвым, мс. */
export const LOCK_WRITE_GRACE_MS = 10_000;

type Owner = { pid: number; host: string; token: string };

/** Блокировки, которые держит этот процесс: токен → файл и его содержимое. */
const heldLocks = new Map<string, { file: string; text: string }>();
let exitHookInstalled = false;

/** Только для тестов: подменить чтение файла блокировки (вклиниться между чтением и снятием). */
export const lockHooks: { read: (file: string) => string } = { read: (file) => readFileSync(file, 'utf8') };

const unique = (file: string, what: string) => `${file}.${what}-${process.pid}-${randomBytes(6).toString('hex')}`;

const processAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM — процесс есть, но чужой: он жив.
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

function syncDir(dir: string): void {
    const fd = openSync(dir, 'r');
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

function parseOwner(text: string): Owner | null {
    try {
        const owner = JSON.parse(text) as Partial<Owner>;
        if (typeof owner.token !== 'string' || owner.token.length === 0) return null;
        if (!Number.isInteger(owner.pid) || (owner.pid as number) <= 0) return null;
        // Без имени машины — файл прежнего вида (до круга 19): писали только на этой машине.
        return { pid: owner.pid as number, host: owner.host === undefined ? os.hostname() : String(owner.host), token: owner.token };
    } catch {
        return null;
    }
}

/** Создать файл блокировки целиком или узнать, что он уже есть (false). */
function create(file: string, owner: Owner): boolean {
    const temporary = unique(file, 'new');
    const fd = openSync(temporary, 'wx', 0o600);
    try {
        writeFileSync(fd, JSON.stringify(owner) + '\n');
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    try {
        linkSync(temporary, file);
        syncDir(path.dirname(file));
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
    } finally {
        rmSync(temporary, { force: true });
    }
}

/**
 * Забрать файл блокировки, если в нём всё ещё `expected` (текст, по которому решали): переименовать
 * в уникальное имя и сверить. Не тот — вернуть на место. true — снят именно он.
 */
function takeIf(file: string, expected: string): boolean {
    const moved = unique(file, 'dead');
    try {
        renameSync(file, moved);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; // уже снял другой
        throw error;
    }
    const text = readFileSync(moved, 'utf8');
    if (text === expected) {
        rmSync(moved, { force: true });
        return true;
    }
    try {
        linkSync(moved, file);
    } catch (error) {
        throw new StateDirBusy(
            `блокировка ${file} другого экземпляра снята по ошибке и не возвращается (${(error as Error).message}): ` +
                `остановите все экземпляры сервиса и запустите один; файл экземпляра сохранён в ${moved}`,
        );
    }
    rmSync(moved, { force: true });
    return false;
}

/** Почему файл блокировки нельзя снять (занят), или null — хозяин мёртв. */
function busyReason(dir: string, file: string, text: string): string | null {
    const owner = parseOwner(text);
    if (!owner) {
        let age = Infinity;
        try {
            age = Date.now() - statSync(file).mtimeMs;
        } catch {
            return null;
        }
        return age < LOCK_WRITE_GRACE_MS
            ? `каталог состояния ${dir} занят: файл блокировки ${file} без содержимого моложе ${LOCK_WRITE_GRACE_MS / 1000} с (его пишут)`
            : null;
    }
    if (heldLocks.has(owner.token))
        return `каталог состояния ${dir} занят другим экземпляром сервиса в этом же процессе (${file})`;
    if (owner.host !== os.hostname())
        return (
            `каталог состояния ${dir} занят сервисом с pid ${owner.pid} на машине «${owner.host}» (${file}): жив ли он, отсюда не проверить; ` +
            'если он точно остановлен — удалите файл блокировки'
        );
    if (processAlive(owner.pid))
        return (
            `каталог состояния ${dir} занят сервисом с pid ${owner.pid} (${file}): второй экземпляр не запускается` +
            (owner.pid === process.pid ? '; pid совпал с нашим, токен — чужой: если прежний экземпляр точно остановлен, удалите файл' : '')
        );
    return null;
}

/** Снять свою блокировку: только если в файле наш токен. */
function release(token: string): void {
    const held = heldLocks.get(token);
    if (!held) return;
    heldLocks.delete(token);
    const { file, text } = held;
    try {
        takeIf(file, text);
    } catch (error) {
        if (!(error instanceof StateDirBusy)) throw error;
        // Возврат чужой блокировки не удался — сказать, но не ронять выход процесса.
        process.emitWarning(error.message);
    }
}

/**
 * Взять блокировку каталога состояния. Занят — StateDirBusy с причиной. Возвращает функцию
 * снятия; при выходе процесса снимаются все свои (со сверкой токена).
 */
export function lockStateDir(dir: string): () => void {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sequencer.lock');
    const owner: Owner = { pid: process.pid, host: os.hostname(), token: randomBytes(16).toString('hex') };
    const mine = JSON.stringify(owner) + '\n';
    for (let attempt = 0; attempt < 5; attempt++) {
        if (create(file, owner)) {
            heldLocks.set(owner.token, { file, text: mine });
            if (!exitHookInstalled) {
                exitHookInstalled = true;
                process.on('exit', () => {
                    for (const token of [...heldLocks.keys()]) {
                        try {
                            release(token);
                        } catch {
                            // При выходе процесса снять можно не всё; мёртвую блокировку снимет следующий запуск.
                        }
                    }
                });
            }
            return () => release(owner.token);
        }
        let text: string;
        try {
            text = lockHooks.read(file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // сняли между попытками
            throw error;
        }
        const busy = busyReason(dir, file, text);
        if (busy) throw new StateDirBusy(busy);
        takeIf(file, text);
    }
    throw new StateDirBusy(`блокировку каталога состояния ${dir} не удалось взять (${file})`);
}
