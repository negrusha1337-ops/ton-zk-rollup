import type { Config } from 'jest';

// globalSetup из шаблона create-ton убран: он импортировал buildAllTact,
// которого нет в @ton/blueprint 0.47, а Tact в проекте не используется.
const config: Config = {
    preset: 'ts-jest',
    cache: false,
    // Наборы идут параллельно, а часть тестов компилирует большие контракты и считает
    // миллионы gas: стандартных 5 с под нагрузкой не хватает.
    testTimeout: 120_000,
    testEnvironment: '@ton/sandbox/jest-environment',
    // .claude/worktrees — рабочие копии агентов: их тесты относятся к другим веткам.
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '/circuits/build/', '/.tools/', '/.claude/'],
    reporters: ['default', ['@ton/sandbox/jest-reporter', {}]],
};

export default config;
