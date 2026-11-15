import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { LOCK_WRITE_GRACE_MS, lockHooks, lockStateDir, StateDirBusy } from '../sequencer/lock';

// Процесс сервиса сборщика: блокировка каталога состояния (sequencer/lock.ts) и гашение
// дочерних по сигналу (sequencer/children.ts). Круг 19, пункты 3 и 5.

const ROOT = path.join(__dirname, '..');
/** pid завершившегося процесса: хозяин «мёртвой» блокировки. */
const deadPid = () => spawnSync('true').pid!;
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

describe('блокировка каталога состояния', () => {
    let dir: string;
    let file: string;
    const lockText = (owner: object) => JSON.stringify(owner) + '\n';
    const tokenIn = () => JSON.parse(readFileSync(file, 'utf8')).token as string;

    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'sequencer-lock-'));
        file = path.join(dir, 'sequencer.lock');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('19-3: два экземпляра снимают одну мёртвую блокировку — второй не удаляет живую блокировку первого', () => {
        writeFileSync(file, lockText({ pid: deadPid(), host: os.hostname(), token: 'dead' }));
        const read = lockHooks.read;
        let first: (() => void) | null = null;
        let injected = false;
        // Второй прочёл мёртвую блокировку; пока он решает, первый снимает её и берёт свою.
        lockHooks.read = (target) => {
            const text = read(target);
            if (!injected) {
                injected = true;
                first = lockStateDir(dir);
            }
            return text;
        };
        try {
            expect(() => lockStateDir(dir)).toThrow(StateDirBusy);
        } finally {
            lockHooks.read = read;
        }
        expect(first).not.toBeNull();
        const token = tokenIn();
        expect(token).not.toBe('dead');
        expect(() => lockStateDir(dir)).toThrow(`каталог состояния ${dir} занят другим экземпляром сервиса в этом же процессе (${file})`);
        first!();
        expect(existsSync(file)).toBe(false);
        expect(readdirSync(dir)).toEqual([]);
    });

    it('19-3: тот же pid с чужим токеном (pid 1 в контейнере) — занят; другая машина — занят', () => {
        writeFileSync(file, lockText({ pid: process.pid, host: os.hostname(), token: 'other' }));
        expect(() => lockStateDir(dir)).toThrow(
            `каталог состояния ${dir} занят сервисом с pid ${process.pid} (${file}): второй экземпляр не запускается; ` +
                'pid совпал с нашим, токен — чужой: если прежний экземпляр точно остановлен, удалите файл',
        );
        writeFileSync(file, lockText({ pid: deadPid(), host: 'другая-машина', token: 'other' }));
        expect(() => lockStateDir(dir)).toThrow(/^каталог состояния .* занят сервисом с pid \d+ на машине «другая-машина»/);
        expect(tokenIn()).toBe('other');
    });

    it('19-3: пустой файл блокировки — занят, пока молод; старше срока — мёртв и снимается', () => {
        writeFileSync(file, '');
        expect(() => lockStateDir(dir)).toThrow(
            `каталог состояния ${dir} занят: файл блокировки ${file} без содержимого моложе ${LOCK_WRITE_GRACE_MS / 1000} с (его пишут)`,
        );
        const past = (Date.now() - LOCK_WRITE_GRACE_MS - 1000) / 1000;
        utimesSync(file, past, past);
        const release = lockStateDir(dir);
        expect(tokenIn()).toMatch(/^[0-9a-f]{32}$/);
        release();
        expect(existsSync(file)).toBe(false);
    });

    it('19-3: свою блокировку снимают только со сверкой токена — чужую не трогают', () => {
        const release = lockStateDir(dir);
        // Файл подменили (его сочли мёртвым и взяли): снятие обязано его оставить.
        writeFileSync(file, lockText({ pid: deadPid(), host: os.hostname(), token: 'someone' }));
        release();
        expect(tokenIn()).toBe('someone');
        expect(readdirSync(dir)).toEqual(['sequencer.lock']);
    });
});

describe('дочерние процессы по сигналу', () => {
    let dir: string;
    beforeEach(() => (dir = mkdtempSync(path.join(os.tmpdir(), 'sequencer-children-'))));
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /**
     * Процесс-сервис с одним дочерним на учёте получает SIGTERM. Дочерний на SIGTERM пишет
     * отметку и выходит через 300 мс либо SIGTERM не слушает.
     */
    const run = async (child: 'graceful' | 'deaf', graceMs: number) => {
        const marker = path.join(dir, 'marker');
        const childCode =
            child === 'graceful'
                ? `process.on('SIGTERM', () => setTimeout(() => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok'); process.exit(0); }, 300));`
                : `process.on('SIGTERM', () => {});`;
        const script = path.join(dir, 'service.js');
        writeFileSync(
            script,
            `require(${JSON.stringify(require.resolve('ts-node'))}).register({ transpileOnly: true });
const { track, signalGrace } = require(${JSON.stringify(path.join(ROOT, 'sequencer', 'children'))});
const { spawn } = require('child_process');
signalGrace.ms = ${graceMs};
const child = track(spawn(process.execPath, ['-e', ${JSON.stringify(childCode + ' setInterval(() => {}, 1000); console.log("готов");')}], { stdio: ['ignore', 'pipe', 'ignore'] }));
child.stdout.once('data', () => console.log(child.pid));
setInterval(() => {}, 1000);
`,
        );
        const service = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
        const childPid = await new Promise<number>((resolve, reject) => {
            service.stdout.once('data', (data) => resolve(Number(String(data).trim())));
            service.once('exit', (code) => reject(new Error(`сервис вышел раньше времени: ${code}`)));
        });
        const started = Date.now();
        const exited = new Promise<number | null>((resolve) => service.once('exit', (code) => resolve(code)));
        service.kill('SIGTERM');
        const code = await exited;
        const took = Date.now() - started;
        for (let wait = 0; alive(childPid) && wait < 40; wait++) await new Promise((resolve) => setTimeout(resolve, 50));
        return { code, took, childAlive: alive(childPid), marker: existsSync(marker) };
    };

    it('19-5: SIGTERM сервису — дочерний (reth) успевает завершиться сам, не SIGKILL сразу', async () => {
        const result = await run('graceful', 10_000);
        expect(result).toMatchObject({ code: 1, childAlive: false, marker: true });
        expect(result.took).toBeLessThan(5_000);
    }, 30_000);

    it('19-5: дочерний не слушает SIGTERM — SIGKILL после срока ожидания', async () => {
        const result = await run('deaf', 700);
        expect(result).toMatchObject({ code: 1, childAlive: false, marker: false });
        expect(result.took).toBeGreaterThanOrEqual(600);
    }, 30_000);
});
