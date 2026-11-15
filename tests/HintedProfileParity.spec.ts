import { readFileSync } from 'fs';
import path from 'path';

// Сторож: копия проверки Groth16 с отметками профилирования (contracts/bn254/hinted_profiled.tolk,
// её импортирует только стенд contracts/bn254_bench.tolk) отличается от рабочего файла
// (contracts/bn254/hinted.tolk) только самими отметками.
//
// Отметки убраны из рабочего пути: они стоили газа в самой тесной транзакции rollup'а. Все
// проверки стенда (эталонные векторы, отрицательные случаи, профиль) идут на копии и что-то
// говорят о рабочем файле лишь до тех пор, пока файлы совпадают. Правка в одном без другого —
// и стенд проверяет не тот код, что исполняет контракт. Этот тест такое ловит.
describe('Копия проверки Groth16 для профилирования отличается только отметками газа', () => {
    const read = (name: string) => readFileSync(path.join(__dirname, '..', 'contracts', name), 'utf8').split('\n');
    const working = read('bn254/hinted.tolk');
    const profiled = read('bn254/hinted_profiled.tolk');
    const BEGIN = '// >>> профиль';
    const END = '// <<< профиль';
    const MARK_LINES = ['markGas();', 'hintGasMarks = [];'];

    /** Копия без строк профилирования: блоки между метками и одиночные вызовы отметок. */
    const stripped = () => {
        const lines: string[] = [];
        let inside = false;
        let blocks = 0;
        let marks = 0;
        for (const line of profiled) {
            if (line === BEGIN) {
                expect(inside).toBe(false);
                inside = true;
                blocks++;
            } else if (line === END) {
                expect(inside).toBe(true);
                inside = false;
            } else if (inside) {
                continue;
            } else if (MARK_LINES.includes(line.trim())) {
                marks++;
            } else {
                lines.push(line);
            }
        }
        expect(inside).toBe(false);
        return { lines, blocks, marks };
    };

    it('без строк профилирования копия совпадает с рабочим файлом построчно', () => {
        const { lines, blocks, marks } = stripped();
        // Шапка копии и объявление отметок; пять отметок по стадиям и обнуление списка.
        expect(blocks).toBe(2);
        expect(marks).toBe(6);
        expect(lines).toEqual(working);
    });

    it('в рабочем файле отметок нет, в блоках копии нет ничего, кроме комментариев и объявления отметок', () => {
        expect(working.filter((line) => /markGas|hintGasMarks/.test(line))).toEqual([]);
        const inside: string[] = [];
        let open = false;
        for (const line of profiled) {
            if (line === BEGIN) open = true;
            else if (line === END) open = false;
            else if (open) inside.push(line.trim());
        }
        const code = inside.filter((line) => line !== '' && !line.startsWith('//'));
        expect(code).toEqual([
            'global hintGasMarks: array<int>',
            '@inline',
            'fun markGas() {',
            'hintGasMarks.push(getGasConsumedAtTheMoment());',
            '}',
        ]);
    });

    it('стенд импортирует копию с отметками, рабочие контракты — файл без них', () => {
        const imports = (name: string) => read(name).filter((line) => line.startsWith('import '));
        expect(imports('bn254_bench.tolk')).toContain('import "bn254/hinted_profiled"');
        expect(imports('bn254_bench.tolk')).not.toContain('import "bn254/hinted"');
        for (const name of ['bn254/verifier_api.tolk', 'rollup/logic.tolk']) {
            const lines = imports(name).join('\n');
            expect(lines).toMatch(/import "(\.\.\/bn254\/)?hinted"/);
            expect(lines).not.toContain('hinted_profiled');
        }
    });
});
