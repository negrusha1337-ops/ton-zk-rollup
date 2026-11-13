import { readFileSync } from 'fs';
import path from 'path';

// Сторож: тестовый двойник (contracts/rollup_mock.tolk) отличается от настоящего контракта
// (contracts/rollup.tolk) только заглушкой проверки пруфа.
//
// Почти вся логика rollup'а проверяется на двойнике: настоящий пруф можно построить только
// для заранее известных значений. Эти тесты что-то говорят о настоящем контракте лишь до тех
// пор, пока два файла точки входа совпадают во всём, кроме двух строк с проверкой пруфа.
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

    it('точка входа и get-методы совпадают построчно, кроме двух строк проверки пруфа', () => {
        expect(real.length).toBe(mock.length);
        const differing = real
            .map((line, index) => ({ real: line, mock: mock[index] }))
            .filter((pair) => pair.real !== pair.mock);
        expect(differing).toEqual([
            {
                real: 'val ok = verifyBn254Proof(msg.proof, batch.digest, 0, batch.vkData, msg.hints);',
                mock: 'val ok = (msg.proof.load().ax == 1) && (batch.digest != 0);',
            },
            {
                real: 'val ok = verifyBn254Proof(msg.proof, digest, 0, exitVkData(storage.keys.load()), msg.hints);',
                mock: 'val ok = (msg.proof.load().ax == 1) && (digest != 0);',
            },
        ]);
    });

    it('оба файла импортируют одну и ту же логику', () => {
        const imports = (source: string) => source.split('\n').filter((line) => line.startsWith('import '));
        expect(imports(read('rollup_mock.tolk'))).toEqual(imports(read('rollup.tolk')));
    });
});
