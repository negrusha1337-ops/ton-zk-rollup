# ZK-rollup с EVM на TON — этап 0

Спайк осуществимости: проверка Groth16 на BLS12-381 в TVM и её стоимость.

- [REPORT.md](REPORT.md) — результаты, таблица газа, вывод, риски.
- [ROUTES.md](ROUTES.md) — пути доставки пруфа zkVM в TON, включая программное спаривание BN254.
- [TESTNET.md](TESTNET.md) — как проверить верификатор BN254 в тестовой сети.
- [ARCHITECTURE.md](ARCHITECTURE.md) — черновик интерфейса rollup-контракта.
- [CLAUDE.md](CLAUDE.md) — краткий контекст для следующих сессий.

## Быстрый старт

```bash
npm ci
npx blueprint test
```

Circom для тестов не нужен: ключи и доказательства лежат в `fixtures/`.

## Пересборка ZK-артефактов

Нужны Rust (для сборки Circom) и Node.js 22+.

```bash
cargo install --git https://github.com/iden3/circom.git --tag v2.2.3 --root .tools circom
npm run zk:build
npm run zk:verifiers
npx blueprint test
```

Trusted setup здесь одноучастниковый и годится только для тестов.
