import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { assertProtocolV1Script, PROOF_FIXTURES_PROTOCOL_VERSION, PROTOCOL_VERSION } from '../wrappers/protocolVersion';

// Сторож смены протокола (REVIEW.md, 14-2 и 14-8).
//
// На время смены часть наборов тестов была выключена одним флагом версии пруфов и перестала
// типизироваться, а скрипты прогона прежнего протокола «отказывались стартовать», пока тот же
// флаг не поднят. Обе вещи плохо стареют: выключенный набор молча прячет защиты без тестов, а
// подъём флага (его делает тот, кто перестроил пруфы) сам разблокировал бы скрипты, написанные
// под сообщения прежнего протокола. Здесь закреплено, что вправе оставаться непроверенным и почему.
const ROOT = path.join(__dirname, '..');
const SELF = 'tests/ProtocolGate.spec.ts';

/** Файлы без проверки типов: только скрипты протокола v1 — и каждый с причиной. */
const UNCHECKED: Record<string, string> = {
    'scripts/runRollupTestnet.ts':
        'прогон игрушечного реестра протокола v1 (пруфы fixtures/sp1_rollup_*, выход по пруфу); в v2 этого пути нет',
    'scripts/runEvmBatchTestnet.ts': 'приём батча EVM по пруфу протокола v1 (fixtures/sp1_evm_batch2); в v2 цепочки anvil нет',
    'scripts/runEvmExitTestnet.ts':
        'выход счёта EVM со словом состояния, заданным при развёртывании; в v2 его записывает только батч — ждёт пруфов v2',
    'scripts/runRethCycleTestnet.ts': 'полный цикл на пруфах блоков Reth протокола v1 — ждёт пруфов v2 и переноса на обёртки v2',
};

/** Файлы с отложенными тестами (todo): только те, что ждут пруфов, — и каждый с причиной. */
const PENDING: Record<string, string> = {
    'tests/RollupEvmRethProof.spec.ts': 'ждёт пруфов SP1 протокола v2 для блоков цепочки Reth (строятся только по команде пользователя)',
    'tests/ProgramBinding.spec.ts': 'todo только если фикстур пруфов игрушечного реестра нет вовсе; сейчас они есть, и тесты идут',
};

const sourcesIn = (directory: string): string[] =>
    readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) return sourcesIn(relative);
        return entry.name.endsWith('.ts') ? [relative] : [];
    });
const files = ['tests', 'wrappers', 'scripts'].flatMap(sourcesIn).filter((file) => file !== SELF);
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
const matching = (pattern: RegExp) => files.filter((file) => pattern.test(read(file))).sort();

describe('Смена протокола: что вправе оставаться без проверки', () => {
    it('проверка типов отключена только у перечисленных скриптов протокола v1', () => {
        expect(matching(/@ts-nocheck|@ts-ignore|@ts-expect-error/)).toEqual(Object.keys(UNCHECKED).sort());
        for (const reason of Object.values(UNCHECKED)) expect(reason.length).toBeGreaterThan(20);
        // Ни одного теста без проверки типов.
        expect(Object.keys(UNCHECKED).filter((file) => !file.startsWith('scripts/'))).toEqual([]);
    });

    it('отложенные тесты (todo) — только у наборов, ждущих пруфов; пропущенных и выделенных тестов нет', () => {
        expect(matching(/\b(?:it|test|describe)\.todo\(/)).toEqual(Object.keys(PENDING).sort());
        for (const reason of Object.values(PENDING)) expect(reason.length).toBeGreaterThan(20);
        expect(matching(/\b(?:it|test|describe)\.(?:skip|only)\(|\bx(?:it|describe|test)\(|\bfit\(|\bfdescribe\(/)).toEqual([]);
    });

    it('каждый скрипт протокола v1 первым делом отказывается стартовать', () => {
        for (const file of Object.keys(UNCHECKED)) {
            const name = path.basename(file, '.ts');
            // Первая инструкция run — отказ: до него скрипт ничего не читает и не отправляет.
            const pattern = new RegExp(
                `export async function run\\([^)]*\\)\\s*\\{\\s*assertProtocolV1Script\\('${name}'\\);`,
            );
            expect({ file, refusesFirst: pattern.test(read(file)) }).toEqual({ file, refusesFirst: true });
        }
        // И наоборот: скрипт, который зовёт отказ, обязан быть в списке (иначе он типизируется
        // и работает — тогда отказ ему не нужен).
        expect(matching(/assertProtocolV1Script\(/).filter((file) => file.startsWith('scripts/'))).toEqual(
            Object.keys(UNCHECKED).sort(),
        );
    });

    it('отказ скриптов v1 безусловный: от версии пруфов в fixtures/ он не зависит', () => {
        expect(PROTOCOL_VERSION).toBe(2);
        expect(() => assertProtocolV1Script('runRollupTestnet')).toThrow(/написан для протокола v1/);
        // Сколько бы ни значил флаг версии пруфов, скрипт v1 с контрактом v2 не стартует.
        for (const version of [2, 3, 0]) {
            expect(() => assertProtocolV1Script('runRollupTestnet', version)).toThrow(/написан для протокола v1/);
        }
        expect(() => assertProtocolV1Script('runRollupTestnet', 1)).not.toThrow();
        // Сама функция флаг версии пруфов не читает: поднять его можно, не разблокировав скрипты.
        const source = read('wrappers/protocolVersion.ts');
        const body = source.slice(source.indexOf('export function assertProtocolV1Script'));
        expect(body).not.toMatch(/PROOF_FIXTURES_PROTOCOL_VERSION|proofFixturesBlocker/);
        expect([1, 2]).toContain(PROOF_FIXTURES_PROTOCOL_VERSION);
    });
});
