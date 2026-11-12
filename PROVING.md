# PROVING — как получить настоящий пруф SP1 для батча

Состояние на 12.11.2026: программа перехода состояния исполняется в zkVM и доказывается
STARK-пруфом на ноутбуке. Не сделан последний шаг — обёртка в Groth16, без которой пруф
нельзя отправить в TON: ноутбуку для неё не хватает диска и памяти.

## Что проверено локально

Замеры — `bench/zkvm-local-run.json` (Apple M4, 10 ядер, 16 ГБ; SP1 SDK 6.10.0).

- `zkvm/lib` — логика перехода состояния (игрушечный реестр балансов, не EVM), 4 модульных теста.
- `zkvm/program` собирается под zkVM: `cargo prove build`.
- `zkvm/script` (хост с `sp1-sdk`) собирается и работает.
- Исполнение в zkVM: батч 1 — 32 434 цикла, батч 2 — 628 133 цикла; публичные значения
  совпали с нативным запуском и с тем, что требует rollup-контракт.
- Сжатый STARK-пруф батча 1 построен и проверен локально за 75 с (пик памяти процесса 19 ГБ
  при 16 ГБ физической — со сжатием и подкачкой).
- Хеш ключа программы совпал с `fixtures/zkvm_batches/program.json`.

## Что не проверено

- Groth16-пруф нашей программы и его приём контрактом в TON.
- Шаги для сервера ниже составлены по документации SP1 и по опыту сборки на macOS; на Linux
  я их не прогонял.

## Что выяснено про сам пруф

- **Версия схемы.** SDK 6.10.0 строит пруфы под схему **v6.1.0**. В TON до сих пор проверялся
  пруф v6.0.0 (`fixtures/sp1_v6_fibonacci`). Ключ верификатора у v6.1.0 другой
  (`VERIFIER_HASH` начинается с `0x4388a21c`), публичных входов по-прежнему пять, так что
  контракт менять не нужно — только загрузить другой ключ.
- **Nonce.** Пятый публичный вход — 128-битный нонс, который задаёт доказывающий
  (`with_proof_nonce` в SDK). У локального прувера он по умолчанию нулевой; `zkvm/script`
  фиксирует ноль явно. Нулевой нонс в TON ничего не стоит, расход газа остаётся измеренным.

## Требования к машине для Groth16

- Диск: архив артефактов схемы — 6,2 ГБ (скачивается и распаковывается рядом, внутри схема
  на 2,4 ГБ и ключ доказательства); с запасом нужно 30+ ГБ свободного места.
- Память: по документации SP1 обёртка занимает около 14 ГБ; STARK-часть на ноутбуке уже
  дошла до 19 ГБ пикового следа. Разумный минимум — 32 ГБ.
- Обёртку считает gnark: либо Docker (образ `ghcr.io/succinctlabs/sp1-gnark:v6.1.0`, есть
  amd64 и arm64), либо Go и сборка с `--features native-gnark`.
- GPU не нужен: программа маленькая, а обёртка в Groth16 считается на процессоре.

Подойдёт обычный облачный сервер: Linux x86_64, 16–32 ядра, 32–64 ГБ памяти, 50+ ГБ диска.
Сколько займёт Groth16-пруф, не измерено. Альтернатива — сеть пруверов Succinct (аккаунт и оплата).

## Сборка и запуск

Сборке нужен `protoc`. На macOS он лежит в `.tools/protoc` (официальный релиз protobuf):

```bash
export PATH="$HOME/.sp1/bin:$PATH" PROTOC="$PWD/.tools/protoc/bin/protoc"
cd zkvm/script
cargo run --release -- --batch 1 --execute      # исполнить в zkVM
cargo run --release -- --batch 1 --compressed   # STARK-пруф, только диагностика
```

На сервере (Ubuntu, не проверено):

```bash
sudo apt-get update && sudo apt-get install -y build-essential pkg-config libssl-dev protobuf-compiler git curl docker.io
curl https://sh.rustup.rs -sSf | sh -s -- -y && . "$HOME/.cargo/env"
curl -L https://sp1up.succinct.xyz | bash && "$HOME/.sp1/bin/sp1up"
git clone <этот репозиторий> && cd ton-zk-rollup/zkvm/script
export PATH="$HOME/.sp1/bin:$PATH"
cargo run --release -- --batch 1 --prove
cargo run --release -- --batch 2 --prove
```

Результат — `fixtures/zkvm_batches/proof-batch1.json` и `proof-batch2.json` (их нужно
скопировать обратно в репозиторий).

## Что делать с пруфом дальше

1. Скачать `Groth16Verifier.sol` и `SP1VerifierGroth16.sol` версии v6.1.0 из
   `succinctlabs/sp1-contracts` и импортировать пруф:
   `node zk/import-sp1-fixture.mjs <Groth16Verifier.sol> <SP1VerifierGroth16.sol> fixtures/zkvm_batches/proof-batch1.json sp1_rollup_batch1`.
   Скрипт сверяет селектор версии и проверяет пруф эталонной библиотекой.
2. Построить ключ и подсказки: `node zk/gen-bn254-groth16-fixture.mjs sp1_rollup_batch1`.
   Ключ программы, код выхода и корень ключей — константы, они складываются в IC0;
   переменные входы — дайджест публичных значений и nonce.
3. Отправить батч в rollup-контракт (Sandbox, затем testnet) и измерить газ.
