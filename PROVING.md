# PROVING — настоящий пруф SP1 для батча

Состояние на 12.11.2026: программа перехода состояния исполнена в SP1, для двух батчей
построены Groth16-пруфы, и настоящий rollup-контракт принимает их в Sandbox и в testnet. Пруфы
построены на ноутбуке, без GPU и без Docker.

## Что проверено

Замеры — `bench/zkvm-local-run.json` (Apple M4, 10 ядер, 16 ГБ; SP1 SDK 6.10.0, схема v6.1.0)
и `bench/rollup-zkvm-proof.json` (Sandbox).

- `zkvm/lib` — логика перехода состояния (игрушечный реестр балансов, не EVM), 4 модульных теста.
- Исполнение в zkVM: батч 1 — 8 650 циклов, батч 2 — 212 317 циклов (две подписанные
  транзакции; прекомпиляции SHA-256, Keccak и secp256k1); публичные значения совпали с
  нативным запуском. Подписанный перевод стоит около 39 тыс. циклов (`bench/zkvm-data-cost.json`).
- Groth16-пруфы обоих батчей: `fixtures/zkvm_batches/proof-batch{1,2}.json`. Каждый строился
  9–14 минут в зависимости от загрузки машины (из них обёртка gnark — 2,5 минуты,
  15 972 262 ограничения), проверен SDK и независимо эталонной библиотекой при импорте.
  Нынешние пруфы построены для программы с привязкой к данным, опубликованным в TON
  ([DA.md](DA.md)); ключ программы — в `fixtures/zkvm_batches/program.json`.
- Импортированные пруфы с ключом верификатора v6.1.0 и подсказками:
  `fixtures/sp1_rollup_batch{1,2}/`.
- Пруфы аварийного выхода двух счетов сценария (отдельная программа `zkvm/exit-program`,
  около 48 тыс. циклов): `fixtures/zkvm_exit/proof-{alice,bob}.json`, импортированные —
  `fixtures/sp1_rollup_exit_{alice,bob}/`. Контракт принимает их после заморозки:
  951 470 gas (`tests/RollupEscapeProof.spec.ts`, `bench/rollup-escape.json`).
- Rollup-контракт (`contracts/rollup.tolk`, настоящая проверка) принимает оба пруфа:
  `submit_batch` — 948 263 gas (батч 1) и 948 501 gas (батч 2, с депозитом и данными), запас
  до лимита транзакции 5,1–5,2%. Полный путь «депозит → батч 1 → данные → батч 2 → вывод»
  проходит (`tests/RollupZkvmProof.spec.ts`); чужой корень, чужой nonce, пруф не своего батча,
  пруф для rollup'а с другим идентификатором и батч без опубликованных данных отклоняются.
- Всё это пройдено в testnet 13.11.2026 настоящими транзакциями: батчи, публикация данных,
  заморозка и выход обоих счетов по пруфам; расход газа совпал с Sandbox до единицы
  ([TESTNET.md](TESTNET.md), `bench/testnet-run-rollup.json`).

## Что не проверено

- Шаги для Linux-сервера ниже составлены по документации SP1; на Linux я их не прогонял.
- Программа — игрушечный реестр. Как вырастут время и память для EVM-блока, не измерено.

## Что выяснено про сам пруф

- **Версия схемы.** SDK 6.10.0 строит пруфы под схему **v6.1.0**. Ключ верификатора у неё
  другой, чем у v6.0.0 (`VERIFIER_HASH` начинается с `0x4388a21c`), публичных входов
  по-прежнему пять. Контракт не менялся — в него загружается другой ключ.
- **Nonce.** Пятый публичный вход — 128-битный нонс, который задаёт доказывающий
  (`with_proof_nonce` в SDK). У локального прувера он по умолчанию нулевой; `zkvm/script`
  фиксирует ноль явно. Нулевой нонс в TON не стоит ничего.
- **Что доказывает программа.** Транзакции взяты из данных, опубликованных в TON; каждая
  подписана владельцем счёта и идёт по его nonce; пруф и подписи привязаны к идентификатору
  rollup'а. Полный список — в [ARCHITECTURE.md](ARCHITECTURE.md).
- **Ключ программы** входит в ключ контракта как константа (свёрнут в IC0 вместе с кодом
  выхода и корнем ключей). Пруф другой программы тем же ключом не проверится.

## Ресурсы

Обёртка в Groth16 на машине с 16 ГБ памяти идёт на подкачке: пиковый след процесса 27 ГБ,
свободное место на диске падало с 21 до 5 ГБ. Это работает, но на пределе.

- Диск: артефакты схемы — 6,2 ГБ архив, 7,9 ГБ после распаковки; плюс подкачка. На ноутбуке
  нужно 20+ ГБ свободного места перед запуском.
- Память: комфортно — от 32 ГБ; на 16 ГБ — только с закрытыми программами и под сторожем.
- GPU не нужен.

## Сборка и запуск на macOS

Нужны `protoc` и Go (для нативного gnark); оба лежат в `.tools/` и в git не попадают.

```bash
T="$PWD/.tools"
export PATH="$T/go/bin:$HOME/.sp1/bin:$PATH" PROTOC="$T/protoc/bin/protoc" GOPATH="$T/gopath" GOCACHE="$T/gocache"
cd zkvm/script
cargo build --release --features native-gnark
./target/release/rollup-script --batch 1 --execute      # исполнить в zkVM
./target/release/rollup-script --batch 1 --compressed   # STARK-пруф, только диагностика
./prove-guarded.sh --batch 1 --prove                    # Groth16 под сторожем диска
./prove-guarded.sh --exit alice --prove                 # пруф аварийного выхода счёта сценария
```

Артефакты схемы SDK скачивает сам при первом `--prove` (архив и распаковка рядом, ~14 ГБ
на пике). Чтобы не держать архив на диске, их можно распаковать из потока:

```bash
P="$HOME/.sp1/circuits/groth16"; mkdir -p "$P/tmp" && curl -sSL --fail https://sp1-circuits.s3-us-east-2.amazonaws.com/v6.1.0-groth16.tar.gz | tar -xzf - -C "$P/tmp" && touch "$P/tmp/.complete" && mv "$P/tmp" "$P/v6.1.0"
```

`prove-guarded.sh` убивает прувер, если свободного места меньше `MIN_FREE_GB` (по умолчанию 4).

## На Linux-сервере (не проверено)

```bash
sudo apt-get update && sudo apt-get install -y build-essential pkg-config libssl-dev protobuf-compiler git curl docker.io
curl https://sh.rustup.rs -sSf | sh -s -- -y && . "$HOME/.cargo/env"
curl -L https://sp1up.succinct.xyz | bash && "$HOME/.sp1/bin/sp1up"
git clone <этот репозиторий> && cd ton-zk-rollup/zkvm/script
export PATH="$HOME/.sp1/bin:$PATH"
cargo run --release -- --batch 1 --prove
```

Без `native-gnark` обёртку считает Docker-образ `ghcr.io/succinctlabs/sp1-gnark:v6.1.0`.

## От пруфа к контракту

1. Импорт: `node zk/import-sp1-fixture.mjs <Groth16Verifier.sol> <SP1VerifierGroth16.sol> fixtures/zkvm_batches/proof-batch1.json sp1_rollup_batch1`.
   Оба `.sol` — версии v6.1.0 из `succinctlabs/sp1-contracts` (они же лежат в распакованных
   артефактах схемы). Скрипт сверяет селектор версии и проверяет пруф эталонной библиотекой.
2. Ключ и подсказки: `node zk/gen-bn254-groth16-fixture.mjs sp1_rollup_batch1`.
3. Тест: `npx jest tests/RollupZkvmProof.spec.ts`.
