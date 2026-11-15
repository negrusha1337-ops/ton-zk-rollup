import { ChildProcess } from 'child_process';

// Дочерние процессы сборщика (узел reth, хост программы, rsp) — на учёте. При выходе процесса и
// по сигналам они гасятся: фоновыми после сервиса или теста они не остаются.
//
// По сигналу (SIGINT, SIGTERM, SIGHUP) дочерним — SIGTERM и время завершиться самим
// (signalGrace.ms): reth на SIGTERM сбрасывает базу на диск, а SIGKILL сразу оставил бы её
// недописанной. Не уложились — SIGKILL. На обычном выходе процесса ждать нельзя (обработчик
// 'exit' синхронный): там — SIGKILL оставшимся.

const live = new Set<ChildProcess>();
let handlersInstalled = false;

/** Сколько ждать дочерних после SIGTERM, прежде чем SIGKILL, мс. Тесты могут уменьшить. */
export const signalGrace = { ms: 15_000 };

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** SIGTERM всем живым, ожидание до `graceMs`, SIGKILL оставшимся. */
export async function terminateChildren(graceMs = signalGrace.ms): Promise<void> {
    const children = [...live].filter(running);
    const exited = children.map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())));
    children.forEach((child) => child.kill('SIGTERM'));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(exited), new Promise((resolve) => (timer = setTimeout(resolve, graceMs)))]);
    clearTimeout(timer);
    children.filter(running).forEach((child) => child.kill('SIGKILL'));
}

function installHandlers() {
    if (handlersInstalled) return;
    handlersInstalled = true;
    process.on('exit', () => live.forEach((child) => running(child) && child.kill('SIGKILL')));
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
        process.once(signal, () => {
            terminateChildren().finally(() => process.exit(1));
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
