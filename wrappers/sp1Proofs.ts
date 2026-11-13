import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { Cell } from '@ton/core';

// Пруфы SP1 наших программ и их привязка к исходникам.
//
// Пруф годен, только если построен для НЫНЕШНИХ программ. После любой правки zkvm/lib,
// zkvm/exit-lib или гостевых программ прежние пруфы доказывают утверждение прежней
// программы; контракт с нынешним ключом их не примет, а с прежним — принял бы то, чего
// нынешний код уже не допускает. Поэтому сквозные тесты с пруфами SP1 запускаются только
// когда вся цепочка сходится:
//   исходники → sourcesSha256 → program.json → ключи программ → фикстуры пруфов → key.json.
// Иначе они помечаются как ожидающие пруфов: пруфы строятся только по команде пользователя.
// Той же проверкой пользуется скрипт прогона в testnet: с негодными пруфами он не стартует.

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const readJson = (...parts: string[]) => JSON.parse(readFileSync(path.join(FIXTURES, ...parts), 'utf8'));

export type ProgramKeys = {
    sourcesSha256: string;
    programVKey: string;
    exitProgramVKey: string;
    programElfSha256: string;
    exitProgramElfSha256: string;
};

export const loadProgramKeys = (): ProgramKeys => readJson('zkvm_batches', 'program.json');

/** Хеш исходников программ по дереву на диске (zk/program-binding.mjs). */
export const currentSourcesSha256 = (): string =>
    execFileSync('node', [path.join(ROOT, 'zk', 'program-binding.mjs')], { encoding: 'utf8' }).trim();

/** Фикстуры пруфов SP1: каталог, вид программы и поле её ключа в program.json. */
const BATCH = { kind: 'batch', vkeyField: 'programVKey', elfField: 'programElfSha256', keyHashField: 'keyHash' } as const;
const EXIT = {
    kind: 'exit',
    vkeyField: 'exitProgramVKey',
    elfField: 'exitProgramElfSha256',
    keyHashField: 'exitKeyHash',
} as const;
export const SP1_FIXTURES = [
    { directory: 'sp1_rollup_batch1', ...BATCH, scenario: { batch: 1 } },
    { directory: 'sp1_rollup_batch2', ...BATCH, scenario: { batch: 2 } },
    // Батч 3 — единственный с ненулевыми прежними корнями (дерево выводов и очередь): только
    // его пруф показывает на контракте, что программа действительно их коммитит.
    { directory: 'sp1_rollup_batch3', ...BATCH, scenario: { batch: 3 } },
    { directory: 'sp1_rollup_exit_alice', ...EXIT, scenario: { exit: 'alice' } },
    { directory: 'sp1_rollup_exit_bob', ...EXIT, scenario: { exit: 'bob' } },
] as const;

/** Публичный вход, который сценарий (zkvm/native) выдаёт для этой фикстуры. */
function scenarioPublicInput(scenario: (typeof SP1_FIXTURES)[number]['scenario']): bigint | null {
    if ('batch' in scenario) {
        const batch = readJson('zkvm_batches', 'batches.json').batches[scenario.batch - 1];
        return batch ? BigInt(batch.publicInput) : null;
    }
    const claim = (readJson('zkvm_exit', 'claims.json').claims as { name: string; publicInput: string }[]).find(
        (candidate) => candidate.name === scenario.exit,
    );
    return claim ? BigInt(claim.publicInput) : null;
}

/** Что не сходится у одной фикстуры пруфа; пустой список — пруф для нынешней программы. */
export function fixtureProblems(fixture: (typeof SP1_FIXTURES)[number]): string[] {
    const file = (name: string) => path.join(FIXTURES, fixture.directory, name);
    if (!['proof.json', 'public.json', 'source.json', 'onchain.json'].every((name) => existsSync(file(name)))) {
        return [`${fixture.directory}: пруфа нет`];
    }
    const problems: string[] = [];
    const programs = loadProgramKeys();
    const key = readJson('zkvm_batches', 'key.json');
    const inputs = (readJson(fixture.directory, 'public.json') as string[]).map(BigInt);
    const source = readJson(fixture.directory, 'source.json');
    const onchain = readJson(fixture.directory, 'onchain.json');
    const note = (text: string) => problems.push(`${fixture.directory}: ${text}`);
    if (inputs[0] !== BigInt(programs[fixture.vkeyField])) note('ключ программы не тот, что в program.json');
    if (inputs[2] !== 0n) note('exitCode не ноль');
    if (inputs[3] !== BigInt(key.vkRoot)) note('vkRoot не тот, что у закреплённого верификатора');
    if (inputs[4] !== 0n) note('нонс не ноль');
    if (source.kind !== fixture.kind) note('вид программы не тот');
    // Привязка к программе — по её ключу (первый вход, проверен спариванием при импорте) и по
    // хешу ELF. Хеш исходников в фикстуре — справочная запись: он меняется и от правки тестов,
    // при которой ELF остаётся прежним и пруф остаётся годным.
    if (typeof source.elfSha256 !== 'string' || source.elfSha256 !== programs[fixture.elfField]) {
        note('построен для другого ELF, чем записан в program.json');
    }
    // Пруф — именно для того, что сценарий выдаёт под этим именем (не для другого батча и не
    // для прежнего сценария).
    if (inputs[1] !== scenarioPublicInput(fixture.scenario)) note('публичный вход не тот, что выдаёт сценарий');
    if (JSON.stringify(source.variableInputs) !== '[1]') note('переменных входов должно быть ровно один (дайджест)');
    const vkHash = '0x' + Cell.fromBase64(onchain.hinted.vkDataBoc).hash().toString('hex');
    if (vkHash !== key[fixture.keyHashField]) note('ключ контракта не тот, что выведен из исходников (key.json)');
    return problems;
}

/** Годны ли пруфы SP1 для сквозных тестов и почему нет. */
export function sp1ProofsStatus(): { current: boolean; reason: string } {
    const programs = loadProgramKeys();
    if (programs.sourcesSha256 !== currentSourcesSha256()) {
        return { current: false, reason: 'program.json описывает прежние исходники программ' };
    }
    const problems = SP1_FIXTURES.flatMap(fixtureProblems);
    return { current: problems.length === 0, reason: problems.join('; ') };
}
