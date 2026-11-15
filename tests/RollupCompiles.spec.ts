import { compile } from '@ton/blueprint';

// Контрольный набор: контракты rollup'а собираются. Нужен скрипту мутаций
// (zk/rollup-mutation-check.py): вместе с тестом, который обязан убить мутацию, он запускает
// этот — и так отличает «мутация убита» от «мутант не собрался» (в несобравшемся наборе падают
// все тесты разом, и это выглядело бы как убитая мутация).
describe('Сборка контрактов rollup', () => {
    it('контракт, двойник и нуллификатор собираются', async () => {
        for (const name of ['Rollup', 'RollupMock', 'RollupNullifier']) {
            const code = await compile(name);
            expect(code.bits.length + code.refs.length).toBeGreaterThan(0);
        }
    });
});
