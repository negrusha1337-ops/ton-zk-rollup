import { readFileSync } from 'fs';
import path from 'path';

// Сторож: тестовый двойник (contracts/rollup_mock.tolk) отличается от настоящего контракта
// (contracts/rollup.tolk) только заглушкой проверки пруфа.
//
// Почти вся логика rollup'а проверяется на двойнике: настоящий пруф можно построить только
// для заранее известных значений. Эти тесты что-то говорят о настоящем контракте лишь до тех
// пор, пока два файла точки входа совпадают во всём, кроме строки с проверкой пруфа.
// Если кто-то поправит ветку сообщения в одном файле и забудет другой, тесты на двойнике
// продолжат проходить — а настоящий контракт будет вести себя иначе. Этот тест такое ловит.
describe('Двойник отличается от настоящего контракта только заглушкой пруфа', () => {
    const read = (name: string) => readFileSync(path.join(__dirname, '..', 'contracts', name), 'utf8');
    /** Строки кода от точки входа до конца файла, без комментариев и пустых строк. */
    const codeLines = (source: string) =>
        source
            .slice(source.indexOf('fun onInternalMessage'))
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '' && !line.startsWith('//'));
    const real = codeLines(read('rollup.tolk'));
    const mock = codeLines(read('rollup_mock.tolk'));

    it('точка входа и get-методы совпадают построчно, кроме строки проверки пруфа', () => {
        // В протоколе v2 пруф проверяется в одном месте — в батче: выхода по пруфу больше нет.
        expect(real.length).toBe(mock.length);
        const differing = real
            .map((line, index) => ({ real: line, mock: mock[index] }))
            .filter((pair) => pair.real !== pair.mock);
        expect(differing).toEqual([
            {
                real: 'val ok = verifyBn254Proof(msg.proof, batch.digest, 0, batch.vkData, msg.hints);',
                mock: 'val ok = (msg.proof.load().ax == 1) && (batch.digest != 0);',
            },
        ]);
    });

    it('настоящий контракт проверяет пруф ровно один раз, двойник — ни разу', () => {
        const calls = (lines: string[]) => lines.filter((line) => line.includes('verifyBn254Proof(')).length;
        expect(calls(real)).toBe(1);
        expect(calls(mock)).toBe(0);
        // Ветки сообщений прежнего протокола не вернулись ни в один из файлов.
        for (const line of [...real, ...mock]) {
            expect(line).not.toMatch(/\bForceExit\b|SetExitKey|exitVkData|prepareForceExit/);
        }
    });

    it('оба файла импортируют одну и ту же логику', () => {
        const imports = (source: string) => source.split('\n').filter((line) => line.startsWith('import '));
        expect(imports(read('rollup_mock.tolk'))).toEqual(imports(read('rollup.tolk')));
    });
});
