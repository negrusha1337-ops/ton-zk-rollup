import { beginCell, Cell } from '@ton/core';

// Сообщение ForceExitEvm: упаковка заголовка блока EVM, доказательства счёта и подписи в ячейки
// так, как их читает contracts/rollup/evm_exit.tolk.
//
// Байтовая строка (заголовок, узел дерева) — «змейка» ячеек: данные из целых байтов и ссылка на
// продолжение. Контракт читает строку единицами (байт признака RLP, длина, содержимое до 32
// байт), и каждая единица обязана лежать в одной ячейке. Поэтому строка режется не где попало,
// а по границам элементов RLP: элемент целиком (признак и содержимое) — неделимый кусок.

const CELL_BYTES = 127;
/** Больше ячеек у одной строки контракт не примет: EVM_MAX_PARTS в contracts/rollup/evm_exit.tolk. */
export const EVM_MAX_CELLS = 12;

/** Длина заголовка и содержимого элемента RLP, начинающегося в `data[offset]`. */
function rlpItem(data: Buffer, offset: number): { list: boolean; header: number; payload: number } {
    const b = data[offset];
    if (b < 0x80) return { list: false, header: 0, payload: 1 };
    if (b <= 0xb7) return { list: false, header: 1, payload: b - 0x80 };
    if (b <= 0xbf) return { list: false, header: 1 + (b - 0xb7), payload: Number(BigInt('0x' + data.subarray(offset + 1, offset + 1 + b - 0xb7).toString('hex'))) };
    if (b <= 0xf7) return { list: true, header: 1, payload: b - 0xc0 };
    return { list: true, header: 1 + (b - 0xf7), payload: Number(BigInt('0x' + data.subarray(offset + 1, offset + 1 + b - 0xf7).toString('hex'))) };
}

/** Элементы списка RLP как диапазоны байтов (каждый — элемент целиком). */
function listItems(data: Buffer, offset: number): { start: number; end: number }[] {
    const head = rlpItem(data, offset);
    if (!head.list) throw new Error('ожидался список RLP');
    const items: { start: number; end: number }[] = [];
    let position = offset + head.header;
    const end = position + head.payload;
    while (position < end) {
        const item = rlpItem(data, position);
        items.push({ start: position, end: position + item.header + item.payload });
        position += item.header + item.payload;
    }
    if (position !== end) throw new Error('список RLP не сходится по длине');
    return items;
}

/** Список RLP обязан занимать строку целиком: хвост после него контракт прочёл бы как часть узла. */
function assertWholeList(data: Buffer) {
    const head = rlpItem(data, 0);
    if (!head.list) throw new Error('ожидался список RLP');
    if (head.header + head.payload !== data.length) throw new Error('после списка RLP остались байты');
}

/** Число элементов узла дерева: 17 — ветка, 2 — расширение или лист. */
export const evmNodeItemCount = (node: Buffer) => listItems(node, 0).length;

/** Неделимые куски узла дерева: заголовок списка, элементы; значение листа раскрыто внутрь. */
export function evmNodeAtoms(node: Buffer): Buffer[] {
    assertWholeList(node);
    const head = rlpItem(node, 0);
    const atoms = [node.subarray(0, head.header)];
    for (const { start, end } of listItems(node, 0)) {
        if (end - start <= 34) {
            atoms.push(node.subarray(start, end));
            continue;
        }
        // Значение листа: строка, внутри которой список счёта [nonce, баланс, корень, хеш кода].
        const value = rlpItem(node, start);
        const inner = start + value.header;
        const innerHead = rlpItem(node, inner);
        atoms.push(node.subarray(start, inner + innerHead.header));
        for (const item of listItems(node, inner)) atoms.push(node.subarray(item.start, item.end));
    }
    return atoms;
}

/** Неделимые куски заголовка блока: читаются только первые четыре поля, остальное — как придётся. */
function headerAtoms(header: Buffer): Buffer[] {
    assertWholeList(header);
    const head = rlpItem(header, 0);
    const items = listItems(header, 0).slice(0, 4);
    const atoms = [header.subarray(0, head.header), ...items.map(({ start, end }) => header.subarray(start, end))];
    for (let position = items[3].end; position < header.length; position += CELL_BYTES) {
        atoms.push(header.subarray(position, Math.min(position + CELL_BYTES, header.length)));
    }
    return atoms;
}

/** «Змейка» из кусков: в ячейку кладётся столько кусков подряд, сколько помещается целиком. */
export function evmBytesCell(atoms: Buffer[]): Cell {
    const chunks: Buffer[] = [];
    let current = Buffer.alloc(0);
    for (const atom of atoms) {
        if (atom.length > CELL_BYTES) throw new Error('кусок длиннее ячейки');
        if (current.length + atom.length > CELL_BYTES) {
            chunks.push(current);
            current = Buffer.alloc(0);
        }
        current = Buffer.concat([current, atom]);
    }
    chunks.push(current);
    if (chunks.length > EVM_MAX_CELLS) throw new Error(`строка занимает ${chunks.length} ячеек, контракт примет не больше ${EVM_MAX_CELLS}`);
    return evmSnake(chunks);
}

/** «Змейка» как есть: кусок — ячейка. Раскладку выбирает вызывающий (тесты негодных раскладок). */
export function evmSnake(chunks: Buffer[]): Cell {
    let next: Cell | null = null;
    for (const chunk of [...chunks].reverse()) {
        const builder = beginCell().storeBuffer(chunk);
        if (next) builder.storeRef(next);
        next = builder.endCell();
    }
    return next!;
}

export const evmHeaderCell = (headerRlp: Buffer): Cell => evmBytesCell(headerAtoms(headerRlp));
/** Узел, который помещается в ячейку, резать незачем; длинный (ветка) режется по элементам. */
export const evmNodeCell = (nodeRlp: Buffer): Cell =>
    nodeRlp.length <= CELL_BYTES ? evmSnake([nodeRlp]) : evmBytesCell(evmNodeAtoms(nodeRlp));

/** Шаг доказательства: вид узла, сам узел и ссылка на следующий. */
export type EvmProofStep = { isBranch: boolean; node: Cell };

/**
 * Шаги доказательства из узлов. Вид узла определяется по числу элементов; `hints` задаёт его
 * явно — для тестов, где контракту подсказывают неверно или узел собран не по правилам.
 */
export const evmProofSteps = (nodes: Buffer[], hints?: boolean[]): EvmProofStep[] =>
    nodes.map((node, index) => ({
        isBranch: hints ? hints[index] : evmNodeItemCount(node) === 17,
        node: evmNodeCell(node),
    }));

/** Элементы узла (списка RLP) целиком, с признаками: для разбора доказательства в тестах. */
export const evmNodeItems = (node: Buffer): Buffer[] =>
    listItems(node, 0).map(({ start, end }) => node.subarray(start, end));

/** Цепочка узлов доказательства от корня к листу. */
export function evmProofCell(steps: EvmProofStep[]): Cell {
    if (steps.length === 0) throw new Error('пустое доказательство');
    let next: Cell | null = null;
    for (const step of [...steps].reverse()) {
        next = beginCell().storeBit(step.isBranch).storeRef(step.node).storeMaybeRef(next).endCell();
    }
    return next!;
}

export type EvmSignature = { v: number; r: bigint; s: bigint };

/** Подпись из 65 байт r ‖ s ‖ v (как отдают кошельки Ethereum). */
export function evmSignatureFromHex(hex: string): EvmSignature {
    const bytes = Buffer.from(hex.replace(/^0x/, ''), 'hex');
    if (bytes.length !== 65) throw new Error('подпись — 65 байт');
    return {
        r: BigInt('0x' + bytes.subarray(0, 32).toString('hex')),
        s: BigInt('0x' + bytes.subarray(32, 64).toString('hex')),
        v: bytes[64],
    };
}

export const evmSignatureCell = (signature: EvmSignature): Cell =>
    beginCell().storeUint(signature.v, 8).storeUint(signature.r, 256).storeUint(signature.s, 256).endCell();
