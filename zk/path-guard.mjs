// Сверка «каталог вывода — не внутри fixtures/» по настоящим путям (круг 21, 5г). Сравнение строк
// после path.resolve обходится симлинком (каталог вне fixtures/, указывающий внутрь) и регистром
// (на APFS без учёта регистра FIXTURES/ и fixtures/ — один каталог). Поэтому оба пути сводятся к
// настоящим: realpath ближайшего существующего предка (самого каталога может ещё не быть) в варианте
// `native` — он раскрывает симлинки и на APFS отдаёт имена в регистре, записанном на диске.
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const exists = (file) => {
    try {
        lstatSync(file);
        return true;
    } catch {
        return false;
    }
};

/** Настоящий путь: realpath ближайшего существующего предка и остаток пути. */
export function realPathOf(target) {
    let existing = path.resolve(target);
    const rest = [];
    while (!exists(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        rest.unshift(path.basename(existing));
        existing = parent;
    }
    // Висячий симлинк realpath не разберёт — это отказ (бросает), а не «вне каталога».
    return path.join(realpathSync.native(existing), ...rest);
}

/** `target` совпадает с `dir` или лежит внутри него — по настоящим путям. */
export function isInside(target, dir) {
    const inner = realPathOf(target);
    const outer = realPathOf(dir);
    return inner === outer || inner.startsWith(outer + path.sep);
}
