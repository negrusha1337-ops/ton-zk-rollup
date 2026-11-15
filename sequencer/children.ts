import { ChildProcess } from 'child_process';

// Дочерние процессы сборщика (узел reth, хост программы, rsp) — на учёте. При выходе процесса и
// по сигналам они гасятся: фоновыми после сервиса или теста они не остаются.

const live = new Set<ChildProcess>();
let handlersInstalled = false;

function installHandlers() {
    if (handlersInstalled) return;
    handlersInstalled = true;
    process.on('exit', () => live.forEach((child) => child.kill('SIGKILL')));
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.once(signal, () => {
            live.forEach((child) => child.kill('SIGTERM'));
            process.exit(1);
        });
    }
}

/** Поставить процесс на учёт до его завершения. */
export function track(child: ChildProcess): ChildProcess {
    installHandlers();
    live.add(child);
    child.once('exit', () => live.delete(child));
    child.once('error', () => live.delete(child));
    return child;
}

/** Сколько дочерних процессов сейчас живо (для тестов: после шага их не остаётся). */
export const liveChildren = (): number => live.size;
