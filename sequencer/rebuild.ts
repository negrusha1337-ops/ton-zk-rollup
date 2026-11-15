import { existsSync, readFileSync, renameSync, rmSync } from 'fs';
import path from 'path';
import { ExecutionPayload } from './block/payload';
import { deserialize, Rebuild, StateStore } from './state';

// Каталог блока, который пересобирается (круг 20, пункт 4). Пересборка пишет состояние (блока
// больше нет, вершина — родитель, `state.rebuild` — прежний отрезок) и только потом уводит каталог
// blocks/<N> в blocks/<N>.stale-<хеш>. Сбой между этими шагами оставил бы прежний каталог на
// месте нового, и файлы прежнего блока (proof.json!) смешались бы с файлами нового. Поэтому
// переименование идемпотентно и доводится при старте.

/** Каталог прежнего блока после пересборки. */
export const staleDirOf = (dir: string, hash: string) => `${dir}.stale-${hash.slice(2, 10)}`;

/**
 * Увести каталог прежнего блока `rebuild.replaces`, если он ещё на месте. Каталог нового блока
 * той же высоты (хеш в payload.json другой) не трогается. true — каталог переименован сейчас.
 */
export function moveStaleBlockDir(store: StateStore, rebuild: Rebuild): boolean {
    const dir = store.blockDir(rebuild.number);
    const payloadFile = path.join(dir, 'payload.json');
    if (!existsSync(payloadFile)) return false;
    const payload = deserialize<ExecutionPayload>(readFileSync(payloadFile, 'utf8'));
    if (payload.blockHash !== rebuild.replaces) return false;
    const stale = staleDirOf(dir, rebuild.replaces);
    rmSync(stale, { recursive: true, force: true });
    renameSync(dir, stale);
    return true;
}
