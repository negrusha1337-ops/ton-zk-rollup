import { ChildProcess } from 'child_process';

// Дочерние процессы сборщика (узел reth, хост программы, rsp, прувер) — на учёте. При выходе
// процесса и по сигналам они гасятся: фоновыми после сервиса или теста они не остаются.
//
// По сигналу (SIGINT, SIGTERM, SIGHUP) дочерним — SIGTERM и время завершиться самим
// (signalGrace.ms): reth на SIGTERM сбрасывает базу на диск, а SIGKILL сразу оставил бы её
// недописанной. Не уложились — SIGKILL. На обычном выходе процесса ждать нельзя (обработчик
// 'exit' синхронный): там — SIGKILL оставшимся.
//
// Круг 20, пункт 9: обработчик стоит на КАЖДЫЙ сигнал, не на первый. Второй Ctrl-C во время
// ожидания — SIGKILL всем дочерним и выход сразу (блокировку каталога снимает обработчик 'exit'
// в lock.ts). С первого сигнала сервис в остановке: новые инструменты не запускаются (и
// повторы после сбоя — тоже), запуск отвечает ShuttingDown.

const live = new Set<ChildProcess>();
let handlersInstalled = false;
let stopping: string | null = null;

/** Сколько ждать дочерних после SIGTERM, прежде чем SIGKILL, мс. Тесты могут уменьшить. */
export const signalGrace = { ms: 15_000 };

/** Сервис останавливается по сигналу: новый инструмент не запускается. */
export class ShuttingDown extends Error {}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/** Идёт ли остановка по сигналу (и по какому). */
export const shuttingDown = (): string | null => stopping;

/** Отказ запускать `what`, если идёт остановка. */
export function assertNotShuttingDown(what: string): void {
    if (stopping) throw new ShuttingDown(`${what} не запускается: сервис останавливается по сигналу ${stopping}`);
}

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

const killAll = () => live.forEach((child) => running(child) && child.kill('SIGKILL'));

function onSignal(signal: NodeJS.Signals): void {
    if (stopping) {
        // Второй сигнал: ждать больше нечего — SIGKILL всем и выход (lock.ts снимет блокировку).
        killAll();
        process.exit(1);
    }
    stopping = signal;
    terminateChildren().finally(() => process.exit(1));
}

function installHandlers() {
    if (handlersInstalled) return;
    handlersInstalled = true;
    process.on('exit', killAll);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, onSignal);
}

/** Поставить процесс на учёт до его завершения. Во время остановки — сразу SIGKILL и ShuttingDown. */
export function track(child: ChildProcess): ChildProcess {
    installHandlers();
    if (stopping) {
        child.kill('SIGKILL');
        throw new ShuttingDown(`процесс ${child.spawnfile} не запускается: сервис останавливается по сигналу ${stopping}`);
    }
    live.add(child);
    child.once('exit', () => live.delete(child));
    child.once('error', () => live.delete(child));
    return child;
}

/** Обработчики сигналов — заранее (сервис ставит их при старте, до первого дочернего). */
export const installSignalHandlers = installHandlers;

/** Сколько дочерних процессов сейчас живо (для тестов: после шага их не остаётся). */
export const liveChildren = (): number => live.size;
