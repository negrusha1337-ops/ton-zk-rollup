import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { parse } from 'dotenv';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { SequencerWallet } from './ton';

// Окружение сервиса-секвенсора (круг 23, пункт 1). В `.env` проекта у пользователя два кошелька:
//   SEQUENCER_MNEMONIC, SEQUENCER_WALLET_VERSION (по желанию SEQUENCER_WALLET_ID,
//       SEQUENCER_SUBWALLET_NUMBER) — кошелёк сервиса: владелец и секвенсор контракта;
//   WALLET_MNEMONIC, WALLET_VERSION — кошелёк прогонов (Blueprint, нагрузка).
// Сервис берёт ТОЛЬКО первый. `.env` он читает сам (dotenv `parse`: файл не печатается и в
// process.env целиком не попадает); переменная окружения процесса главнее строки файла. После
// чтения обе пары удаляются из process.env — дочерним и всему, что читает окружение позже, их
// не видно. Кошелёк сервиса с тем же ключом, что у кошелька прогонов, — отказ: общий seqno дал
// бы гонку отправок сервиса и нагрузки.

const ROOT = path.join(__dirname, '..');
/** `.env` проекта (вне git). */
export const PROJECT_ENV_FILE = path.join(ROOT, '.env');

/** Кошелёк сервиса. */
export const SERVICE_WALLET_ENV = ['SEQUENCER_MNEMONIC', 'SEQUENCER_WALLET_VERSION', 'SEQUENCER_WALLET_ID', 'SEQUENCER_SUBWALLET_NUMBER'] as const;
/** Кошелёк прогонов (Blueprint). */
export const RUNS_WALLET_ENV = ['WALLET_MNEMONIC', 'WALLET_VERSION', 'WALLET_ID', 'SUBWALLET_NUMBER'] as const;
const NAMES = [...SERVICE_WALLET_ENV, ...RUNS_WALLET_ENV, 'TONCENTER_API_KEY'] as const;
type Name = (typeof NAMES)[number];

/** Кошелёк сервиса совпал с кошельком прогонов. */
export class SameWalletRefused extends Error {}

/** Окружение сервиса, снятое с процесса: значения живут только в этом объекте. */
export type ServiceEnv = { readonly values: Readonly<Partial<Record<Name, string>>>; readonly file: string | null };

/**
 * Прочитать окружение сервиса: строки `file` (если он есть), поверх — переменные процесса
 * (`env`). Затем обе пары кошельков удаляются из `env`. TONCENTER_API_KEY остаётся в процессе:
 * дочерним его не даёт childEnv (children.ts).
 */
export function takeServiceEnv(options: { file?: string | null; env?: NodeJS.ProcessEnv } = {}): ServiceEnv {
    const env = options.env ?? process.env;
    const file = options.file === undefined ? PROJECT_ENV_FILE : options.file;
    let fromFile: Record<string, string> = {};
    if (file !== null && existsSync(file)) {
        try {
            fromFile = parse(readFileSync(file));
        } catch (error) {
            // Текст ошибки чтения не содержит строк файла: только путь и причина.
            throw new Error(`${file} не читается: ${(error as NodeJS.ErrnoException).code ?? 'ошибка чтения'}`);
        }
    }
    const values: Partial<Record<Name, string>> = {};
    for (const name of NAMES) {
        const value = env[name] ?? fromFile[name];
        if (value !== undefined && value !== '') values[name] = value;
    }
    for (const name of [...SERVICE_WALLET_ENV, ...RUNS_WALLET_ENV]) delete env[name];
    return { values, file: file !== null && existsSync(file) ? file : null };
}

const words = (mnemonic: string) => mnemonic.trim().split(/\s+/).filter(Boolean);

/** Открытый ключ мнемоники TON (без проверки слов: для сравнения ключей достаточно). */
async function publicKeyOf(mnemonic: string): Promise<Buffer> {
    try {
        return (await mnemonicToPrivateKey(words(mnemonic))).publicKey;
    } catch {
        // Текст ошибки библиотеки может нести слова мнемоники — не пересказывается.
        throw new Error('кошелёк прогонов: WALLET_MNEMONIC не разбирается как мнемоника TON');
    }
}

/**
 * Кошелёк сервиса из SEQUENCER_MNEMONIC / SEQUENCER_WALLET_VERSION. Кошелёк прогонов
 * (WALLET_MNEMONIC) с тем же ключом — отказ: тот же ключ даёт тот же адрес кошелька той же
 * версии, а разные версии одного ключа отличить на глаз нельзя — отказ строже, чем «тот же адрес».
 */
export async function serviceWallet(env: ServiceEnv): Promise<SequencerWallet> {
    const { values } = env;
    const wallet = await SequencerWallet.fromEnv(values);
    if (values.WALLET_MNEMONIC !== undefined) {
        const [mine, runs] = [await publicKeyOf(values.SEQUENCER_MNEMONIC!), await publicKeyOf(values.WALLET_MNEMONIC)];
        if (mine.equals(runs))
            throw new SameWalletRefused(
                'кошелёк сервиса совпадает с кошельком прогонов: в SEQUENCER_MNEMONIC и WALLET_MNEMONIC один ключ. ' +
                    'Сервису нужна своя мнемоника (общий seqno — гонка отправок сервиса и нагрузки)',
            );
    }
    return wallet;
}
