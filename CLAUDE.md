# CLAUDE.md — контекст проекта

Отвечай, пиши комментарии и документацию **на русском**.

## Что это

Первый ZK-rollup с EVM на TON. Конечная цель: EVM-блоки исполняются в Reth, доказываются zkVM
(SP1 или RISC Zero), доказательство сворачивается в Groth16 на BLS12-381 и проверяется
rollup-контрактом на TON L1 (state root, депозиты, выводы по Merkle-доказательству, escape hatch).

Репозиторий сейчас содержит только **этап 0 — спайк осуществимости**: работает ли проверка
Groth16 (BLS12-381) в TVM и сколько она стоит. Ответ: работает, дёшево. Детали — `REPORT.md`.

## Состояние

- Этап 0 завершён: верификатор BLS12-381, тесты, бенчмарк газа, черновик архитектуры (`REPORT.md`).
- Идёт поиск пути «пруф zkVM → TON» — всё в `ROUTES.md`. Главная находка: BN254-Groth16
  можно проверять в TVM программным спариванием (`contracts/bn254/`), без перевода на
  BLS12-381. С подсказками (`contracts/bn254/hinted.tolk`) настоящие пруфы SP1 v6
  (`fixtures/sp1_v6_fibonacci/`) и RISC Zero (`fixtures/risc0_v3_test_receipt/`) проверяются
  контрактом `contracts/bn254_groth16_verifier.tolk` в одной транзакции: 944–949 тыс. gas,
  запас до лимита 5%. Разбор корректности агентом-рецензентом критичного не нашёл; аудита нет. Прогон в testnet выполнен 12.11.2026: пруф SP1 принят,
  расход 943 702 gas — ровно как в Sandbox (`bench/testnet-run-sp1_v6_fibonacci.json`).
- Стандартный путь (обёртка в схеме) уже есть прототипом у IOG для Cardano.
- Rollup-контракт, минимальная версия: `contracts/rollup.tolk` (логика в `contracts/rollup/`,
  нуллификатор `contracts/rollup_nullifier.tolk`). `submit_batch` с настоящей проверкой —
  946 898 gas. Не реализованы jetton'ы, аварийный выход, управление; DA не решено.
- `contracts/rollup_mock.tolk` — двойник с заглушкой проверки пруфа, ТОЛЬКО для тестов логики.
- Программа перехода состояния для zkVM: `zkvm/` (Rust; `lib` — логика, `program` — гость SP1,
  `native` — запуск без zkVM). Игрушечный реестр, не EVM. Публичные значения сверены с
  контрактом (`tests/ZkvmProgram.spec.ts`). `zkvm/script` (хост с `sp1-sdk`, вне workspace)
  исполняет программу в zkVM и строит Groth16-пруф — см. `PROVING.md`.
- **Настоящие пруфы SP1 нашей программы** (схема v6.1.0) для двух батчей:
  `fixtures/sp1_rollup_batch{1,2}/`. Rollup-контракт принимает их в Sandbox
  (`tests/RollupZkvmProof.spec.ts`): 951 091 и 949 425 gas, запас 4,9–5,1%. Полный путь
  (депозит → два батча → вывод) пройден в testnet 12.11.2026, газ совпал с Sandbox до единицы
  (`bench/testnet-run-rollup.json`; скрипты `scripts/runRollupTestnet.ts`, `zk/testnet-rollup-report.mjs`).
- `contracts/bn254/` — исследовательский код без аудита. Проверки точек есть только в
  `hinted.tolk`; `groth16.tolk` (наивный вариант и вариант со свидетелем) их не делает.

## Команды

```bash
npx blueprint test          # все тесты (Circom не нужен, фикстуры в репозитории)
npm run zk:build            # пересобрать схемы, setup и доказательства (нужен Circom)
npm run zk:verifiers        # перегенерировать Tolk-верификаторы из fixtures/
npm run zk:network-config   # обновить снимок цен газа mainnet
npm run zk:cost-report      # таблица «газ → TON» из измерений
cd zkvm && cargo test -p rollup-stf && cargo run -p rollup-native   # программа zkVM нативно
cd zkvm/program && cargo prove build   # сборка под zkVM (нужен SP1: ~/.sp1/bin в PATH)
cd zkvm/script && PROTOC="$PWD/../../.tools/protoc/bin/protoc" cargo run --release -- --batch 1 --execute
```

После `zk:build` обязательно `zk:verifiers`, затем тесты: ключи и доказательства должны быть
из одной сборки.

## Структура

- `circuits/` — схемы Circom. `build/` не коммитится.
- `zk/` — скрипты сборки (`circuits.mjs` — реестр схем).
- `fixtures/<схема>/` — ключ верификации, доказательство, публичные сигналы. Коммитятся.
- `contracts/generated/` — вывод `export-ton-verifier`. **Руками не править.**
- `contracts/hashed_inputs_verifier.tolk` — вариант с одним публичным входом (SHA-256).
- `contracts/rollup/` — хранилище, сообщения и логика rollup-контракта (см. `ARCHITECTURE.md`);
  `wrappers/rollupMath.ts` и `zk/gen-rollup-batches.mjs` повторяют его арифметику вне цепочки —
  все три обязаны совпадать.
- `contracts/bn254/` — программное спаривание BN254; `constants.tolk` генерируется
  `node zk/gen-bn254-constants.mjs`, эталонные векторы — `node zk/gen-bn254-vectors.mjs`,
  константы ключа, свидетель и подсказки — `node zk/gen-bn254-groth16-fixture.mjs [имя фикстуры]`;
  импорт пруфов из файлов zkVM — `node zk/import-sp1-fixture.mjs`, `node zk/import-risc0-fixture.mjs`
  (ссылки на исходные файлы — в `source.json` фикстур); набор разных пруфов — `node zk/gen-bn254-cases.mjs`.
- `bench/gas-results/` — пишется тестами; `bench/network-config.json` — снимок конфига сети.

## Что нужно помнить

- **Blueprint зафиксирован на 0.46.0.** Версия 0.47 убрала Tolk, а сам Blueprint объявлен
  устаревшим в пользу Acton. Не обновлять `@ton/blueprint` без миграции на Acton.
- **256-битное значение не помещается в публичный вход**: поле BLS12-381 ~255 бит. Корни
  хешируются в один вход `sha256(...) mod 2^253`.
- **Четыре `uint256` не помещаются в одну ячейку** (1024 > 1023 бит).
- **Проверку нельзя запускать из external-сообщения** до `accept_message`: кредит 10 000 gas.
- Sandbox 0.45 эмулирует global version 15, сеть на 17. Для верификатора BN254 и
  для rollup-контракта (батчи, депозит, вывод) расход в testnet совпал с Sandbox до единицы.
- В `contracts/bn254/` нельзя использовать `MULADDDIVMOD`: частное не помещается в 257 бит
  на нередуцированных входах (исключение 4). Только `MULMOD`; инвариант границ — в `fp2.tolk`.
- Большие функции Tolk помечать `@inline_ref`: без пометки компилятор зависает на встраивании,
  а `@noinline` даёт вызов через словарь кода за ~190 gas против 56 у `@inline_ref`.
- В `hinted.tolk` нельзя менять порядок хеширования транскрипта: на нём держится корректность.
- `HINT_CHECKPOINT_EVERY`, `HINT_WINDOW_BITS` и `HINT_BIGQ_CELLS` в `hinted.tolk` должны
  совпадать с `CHECKPOINT_EVERY`, `WINDOW_BITS` и `BIG_Q_COEFFICIENTS / 4` в `zk/bn254-hints.mjs`.
- Ключ с оконными таблицами (тысячи ячеек) загружается в контракт частями по ≤ 23 КБ и
  затем фиксируется; раскладка дерева в `windowTable`/`assembleTable` (`zk/bn254-hints.mjs`)
  и в контракте обязана совпадать, иначе разойдётся хеш ключа в транскрипте.
- Скрипты `scripts/*.ts` отказываются работать с mainnet; мнемоника — только в `.env`
  пользователя, в репозиторий не попадает.
- Газ мерить на полноразмерном публичном входе (253 бита): на маленьком он занижен на ~0,2 млн.
- Trusted setup в `zk/build.mjs` — одноучастниковый, только для тестов.
- Цифры газа не выдумывать: только из Sandbox (`bench/gas-results/`) или из конфига сети.
- Никаких приватных ключей и мнемоник в репозитории. Только Sandbox и testnet.
- SDK SP1 6.10.0 строит пруфы под схему v6.1.0, а фикстура `sp1_v6_fibonacci` — v6.0.0: ключи
  верификатора разные. Нонс SP1 (пятый вход) задаёт доказывающий; `zkvm/script` фиксирует 0.
- `zkvm/script` собирается только с `protoc` (переменная `PROTOC`, бинарник в `.tools/protoc`).
- Groth16 на ноутбуке с 16 ГБ: пиковый след 27 ГБ, всё держится на подкачке. Запускать только
  через `zkvm/script/prove-guarded.sh` (сторож диска), при 20+ ГБ свободного места и закрытых
  программах; сборка — `--features native-gnark` с Go из `.tools/go`.
- Ключ программы (`programVKey`) зависит от точного ELF и входит в IC0 ключа контракта: после
  изменения `zkvm/lib` или `zkvm/program` пруфы, ключ и `fixtures/zkvm_batches/program.json`
  нужно пересоздать вместе.
- Монеты, приложенные к сообщениям сверх газа, остаются на контракте, а вывести их нечем:
  суммы для testnet — только из `wrappers/rollupValues.ts` (тест шлёт те же суммы в Sandbox).
- Circom ставится локально: `cargo install --git https://github.com/iden3/circom.git --tag v2.2.3 --root .tools circom`
  (или переменная `CIRCOM_BIN`).
