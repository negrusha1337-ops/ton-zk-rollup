import { createHash } from 'crypto';

// Ключ задания пруверу (круг 20, пункт 6): хеш блока и sha256 его 352 байт публичных значений.
// У пересобранного блока той же высоты другой хеш, у блока с теми же словами, но другим хешем, —
// другой ключ: пруф одного задания не выдать за пруф другого. Отдельный файл — чтобы прувер и
// импорт пруфа брали ключ из одного места без кольца импортов.

const bare = (hex: string) => hex.toLowerCase().replace(/^0x/, '');

export function jobKeyOf(job: { blockHash: string; publicValuesBytes: string }): string {
    const values = createHash('sha256').update(Buffer.from(bare(job.publicValuesBytes), 'hex')).digest('hex');
    return `${bare(job.blockHash)}-${values}`;
}
