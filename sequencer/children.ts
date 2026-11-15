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
//
// Круг 21, пункт 3: дочерним не передаются секреты сервиса (мнемоника кошелька, ключ API) —
// окружение каждого запуска собирает `childEnv`. Пункт 4: сторож прувера запускает свои процессы
// (прувер, gnark), и SIGTERM одному сторожу оставлял их сиротами. Такой дочерний запускается
// своей группой процессов (`detached: true`, `track(child, { group: true })`), и сигнал идёт всей
// группе (`signalChild`); после выхода главы группы оставшимся в ней — SIGKILL.
//
// Круг 22, пункт 3: обработчики `exit` (дочернего и процесса) не бросают — сбой kill (EPERM и др.)
// уходит в журнал (`childrenLog`): исключение там роняло бы сервис посреди шага.

const live = new Set<ChildProcess>();
/** Дочерние, запущенные своей группой процессов: сигнал — всей группе. */
const groups = new WeakSet<ChildProcess>();

/** Переменные окружения сервиса, которые дочерним не передаются (круг 21, пункт 3). */
export const SECRET_ENV = ['WALLET_MNEMONIC', 'SEQUENCER_MNEMONIC', 'TONCENTER_API_KEY'] as const;

/** Окружение дочернего процесса: окружение сервиса и `extra`, без секретов (SECRET_ENV). */
export function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    for (const name of SECRET_ENV) delete env[name];
    return env;
}

/** Сигнал дочернему, а запущенному группой — всей его группе (круг 21, пункт 4). */
export function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    if (groups.has(child) && child.pid !== undefined) {
        try {
            process.kill(-child.pid, signal);
            return;
        } catch (error) {
            // Группы уже нет (ESRCH) — сигнал самому процессу ниже.
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
    }
    child.kill(signal);
}

/**
 * Куда пишутся сбои, которые бросать некуда (круг 22, 3): обработчики `exit` дочернего и процесса.
 * Сервис направляет в свой журнал; по умолчанию — stderr. Тесты подменяют.
 */
export const childrenLog = { write: (line: string): void => void process.stderr.write(`${line}\n`) };

/** Сбой в обработчике `exit` — в журнал, не исключением: брошенное там роняет процесс. */
function reportExitFailure(what: string, error: unknown): void {
    const code = (error as NodeJS.ErrnoException).code;
    try {
        childrenLog.write(`дочерние процессы: ${what} не удался (${code ?? (error as Error).message}) — проверьте, не остались ли процессы`);
    } catch {
        // Журнал недоступен: обработчик exit всё равно не бросает.
    }
}

/** SIGKILL тем, кто остался в группе после выхода её главы. Группы нет — ничего; иной сбой — в журнал. */
function killGroupLeftovers(child: ChildProcess): void {
    if (child.pid === undefined) return;
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            reportExitFailure(`SIGKILL оставшимся в группе ${child.pid} (pgrep -g ${child.pid})`, error);
    }
}
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
    children.forEach((child) => signalChild(child, 'SIGTERM'));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(exited), new Promise((resolve) => (timer = setTimeout(resolve, graceMs)))]);
    clearTimeout(timer);
    children.filter(running).forEach((child) => signalChild(child, 'SIGKILL'));
}

/** SIGKILL всем живым (обработчик exit процесса); сбой сигнала одному — в журнал, остальные гасятся. */
export const killAll = () =>
    live.forEach((child) => {
        if (!running(child)) return;
        try {
            signalChild(child, 'SIGKILL');
        } catch (error) {
            reportExitFailure(`SIGKILL процессу ${child.pid} (${child.spawnfile})`, error);
        }
    });

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

/**
 * Поставить процесс на учёт до его завершения. Во время остановки — сразу SIGKILL и ShuttingDown.
 * `group` — процесс запущен с `detached: true` (своя группа): сигналы — всей группе, а после его
 * выхода оставшимся в группе — SIGKILL.
 */
export function track(child: ChildProcess, options: { group?: boolean } = {}): ChildProcess {
    installHandlers();
    if (options.group) {
        groups.add(child);
        child.once('exit', () => killGroupLeftovers(child));
    }
    if (stopping) {
        signalChild(child, 'SIGKILL');
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
