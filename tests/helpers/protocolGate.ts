import { proofFixturesBlocker } from '../../wrappers/protocolVersion';

/**
 * `describe` для наборов, которым нужны пруфы и ключи из fixtures/. Пока те построены под
 * прежний протокол (wrappers/protocolVersion.ts), набор не запускается и не подгоняется, а
 * помечает себя одним todo — так он остаётся на виду в отчёте jest, пока пруфы не перестроят.
 * Сами файлы таких наборов до тех пор не типизируются (`@ts-nocheck`): они написаны под
 * обёртки прежнего протокола.
 */
export function describeWithProofFixtures(name: string, suite: () => void): void {
    const blocker = proofFixturesBlocker();
    if (blocker === null) {
        describe(name, suite);
        return;
    }
    describe(name, () => {
        it.todo(`ждёт пруфов протокола v2: ${blocker}`);
    });
}
