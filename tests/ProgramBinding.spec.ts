import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { currentSourcesSha256, fixtureProblems, loadProgramKeys, SP1_FIXTURES } from '../wrappers/sp1Proofs';
import { loadRollupKey } from '../wrappers/rollupDeployment';

// Цепочка «исходники программ → ключ программы → ключ контракта → пруфы».
//
// Находка второго круга проверки (REVIEW.md): ничто не связывало ключ, зашитый в
// контракт, с исходниками программы. После правки программы прежние пруфы и прежний ключ
// продолжали «работать», и ни один тест этого не замечал — а program.json правился руками.
// Теперь каждое звено проверяется:
//   • хеш исходников (zkvm/script/src/sources.rs и zk/program-binding.mjs считают его
//     независимо) записан в program.json вместе с ключами программ (пишет zkvm/script --vkeys);
//   • key.json — ключ контракта — выведен из закреплённого верификатора SP1 и этих ключей;
//   • фикстуры пруфов, если они есть, построены для этих же ключей и исходников.
// Чего здесь НЕТ: проверки, что ключ программы действительно получается из этих
// исходников. Для неё нужно пересобрать ELF (cargo prove build) — см. PROVING.md.
describe('Привязка ключей к исходникам программ zkVM', () => {
    const programs = loadProgramKeys();
    const key = loadRollupKey();

    it('program.json описывает нынешние исходники программ', () => {
        // Упало — значит, zkvm/lib, zkvm/exit-lib или гостевые программы изменились, а ключи
        // остались прежними: пересобрать zkvm/script, запустить --vkeys, затем
        // node zk/gen-rollup-key.mjs. Прежние пруфы после этого негодны.
        expect(programs.sourcesSha256).toBe(currentSourcesSha256());
        for (const field of ['programVKey', 'exitProgramVKey'] as const) {
            expect(programs[field]).toMatch(/^0x00[0-9a-f]{62}$/);
        }
        expect(programs.programVKey).not.toBe(programs.exitProgramVKey);
        expect(programs.programElfSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(programs.exitProgramElfSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('ключ контракта выведен из этих же ключей программ и закреплённого верификатора SP1', () => {
        expect(key.file.sourcesSha256).toBe(programs.sourcesSha256);
        expect(key.file.programVKey).toBe(programs.programVKey);
        expect(key.file.exitProgramVKey).toBe(programs.exitProgramVKey);
        const pins = JSON.parse(readFileSync(path.join(__dirname, '..', 'zk', 'sp1-pins.json'), 'utf8'));
        const pin = pins.versions[key.file.circuitVersion];
        expect(pin).toBeDefined();
        const file = key.file as unknown as Record<string, string>;
        expect(file.verifierHash).toBe(pin.verifierHash);
        expect(file.vkRoot).toBe(pin.vkRoot);
        expect(file.verifierConstantsSha256).toBe(pin.constantsSha256);
        // Одна оконная таблица: единственный переменный вход — дайджест публичных значений.
        expect(key.upload.table1Parts).toHaveLength(0);
        expect(key.upload.table0Parts.length).toBeGreaterThan(0);
    });

    it('содержимое key.json пересчитывается из закреплённого ключа схемы и ключей программ', () => {
        // Предыдущий тест сверяет поля-описания. Этот — сами части ключа, хеши и IC0 выхода:
        // файл с честными описаниями и подменёнными частями иначе прошёл бы все проверки,
        // пока нет пруфов SP1 (находка третьего круга проверки).
        const check = spawnSync('node', [path.join(__dirname, '..', 'zk', 'gen-rollup-key.mjs'), '--check'], {
            encoding: 'utf8',
        });
        expect(check.stderr).toBe('');
        expect(check.status).toBe(0);
    });

    const present = SP1_FIXTURES.filter(({ directory }) =>
        existsSync(path.join(__dirname, '..', 'fixtures', directory, 'proof.json')),
    );
    if (present.length === 0) {
        it.todo('пруфы SP1 для нынешних программ не построены: строятся только по команде пользователя');
    }
    for (const fixture of present) {
        it(`пруф ${fixture.directory} построен для нынешней программы и нынешнего ключа`, () => {
            expect(fixtureProblems(fixture)).toEqual([]);
        });
    }
    if (present.length > 0 && present.length < SP1_FIXTURES.length) {
        it('пруфы SP1 есть для всего сценария', () => {
            expect(present.map(({ directory }) => directory)).toEqual(SP1_FIXTURES.map(({ directory }) => directory));
        });
    }
});
