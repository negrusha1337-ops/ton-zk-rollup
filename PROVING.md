# PROVING — программы zkVM, их ключи и пруфы SP1

## Состояние на 13.11.2026

**Пруфы SP1 нынешних программ построены 13.11.2026**: три батча и два аварийных выхода
(`fixtures/zkvm_batches/proof-batch{1,2,3}.json`, `fixtures/zkvm_exit/proof-{alice,bob}.json`;
импортированные с ключом и подсказками — `fixtures/sp1_rollup_*`). Строились после четырёх
кругов независимой проверки ([REVIEW.md](REVIEW.md)) и по команде пользователя.

- Каждый пруф проверен SDK при построении и независимо — спариванием под закреплённым
  ключом схемы при импорте; привязан к ключу программы, хешу ELF и сценарию
  (`tests/ProgramBinding.spec.ts`).
- Настоящий rollup-контракт принимает их в Sandbox (`tests/RollupZkvmProof.spec.ts`,
  `tests/RollupEscapeProof.spec.ts`): батчи — 948 036, 951 339 и 948 339 gas (запас до лимита
  4,9–5,2%), аварийный выход — 954 941 gas (запас 4,5%) [изм, `bench/rollup-zkvm-proof.json`,
  `bench/rollup-escape.json`]. «Лучшая подделка» — настоящий пруф под ложное утверждение с
  честными подсказками — отклоняется кодом 7300 и для батча, и для выхода.
- Время и память на ноутбуке (Apple M4, 16 ГБ): 8–9 минут на пруф, пиковый след 29–32,5 ГБ,
  свободное место на диске падало с 36 до 17–20 ГБ [изм, `bench/zkvm-prove-run.json`].
- **В testnet нынешняя версия прошла 13.11.2026**: все пять пруфов приняты контрактом в сети
  с тем же расходом газа, что в Sandbox ([TESTNET.md](TESTNET.md)).

Что ещё сделано и проверено для нынешних программ:

- Логика: `zkvm/lib` (переход состояния, игрушечный реестр балансов, не EVM) — 27 тестов;
  `zkvm/exit-lib` (аварийный выход) — 10 тестов; `zkvm/native` (сценарий) — 5 тестов.
- Сценарий — три батча. Батч 3 нужен затем, что только он продолжает ненулевые прежние
  корни (дерево выводов и хеш очереди L1): в батчах 1 и 2 они нулевые, и программа,
  коммитящая вместо них ноль, сошлась бы с контрактом.
- Исполнение в zkVM без пруфа (`--execute`): публичные значения совпали с нативным запуском.
  Батч 1 — 8 929 циклов, батч 2 — 661 015, батч 3 — 287 055, выход счёта — 47 925 и 47 542
  [изм, `bench/zkvm-execute.json`]. В батче 2 внутри zkVM исполняются и ветки отказа:
  тринадцать отклоняемых транзакций, в том числе шесть подписей, которые отвергает
  арифметика кривой через прекомпиляцию secp256k1 (high-s, бит восстановления 2 и 3, r вне
  кривой, бесконечно удалённая точка). Паники нет.
- Чистая пересборка обоих ELF (`zkvm/script/verify-elf.sh`) побайтно совпала с `program.json`;
  путей из домашнего каталога в ELF нет.
- Ключи программ посчитаны и записаны в `fixtures/zkvm_batches/program.json` вместе с хешем
  исходников; ключ rollup-контракта выведен из них без пруфа (`fixtures/zkvm_batches/key.json`),
  и настоящий контракт после загрузки сообщает те же хеши (`tests/RollupKeys.spec.ts`).

Что было проверено раньше, на ПРЕЖНИХ версиях программ и контракта (история, не нынешнее
состояние): Groth16-пруфы двух батчей и двух выходов строились на ноутбуке, без GPU и без
Docker, по 9–14 минут; контракт принимал их в Sandbox и в testnet
([TESTNET.md](TESTNET.md), `bench/zkvm-local-run.json`). В этих версиях позже нашли две
критичные дыры — см. REVIEW.md.

## Что не проверено

- Шаги для Linux-сервера ниже составлены по документации SP1; на Linux они не прогонялись.
- Программа — игрушечный реестр. Как вырастут время и память для EVM-блока, не измерено.
- Что сборка программ даёт тот же ELF на другой машине (см. «Привязка…» ниже).

## Что нужно знать про сам пруф

- **Версия схемы.** SDK 6.10.0 строит пруфы под схему **v6.1.0**. Ключ верификатора у неё
  другой, чем у v6.0.0 (`VERIFIER_HASH` начинается с `0x4388a21c`), публичных входов пять:
  `[ключ программы, дайджест публичных значений, exitCode, vkRoot, нонс]`.
- **Нонс.** Пятый вход — 128-битный нонс, который задаёт доказывающий (`with_proof_nonce` в
  SDK). `zkvm/script` фиксирует ноль явно. Rollup-контракт другого нонса не принимает: ноль
  свёрнут в ключ вместе с остальными постоянными входами, поля для нонса в сообщениях нет.
  Причина: вторую оконную таблицу ключа (для нонса) ни один наш пруф не задействовал бы, а
  значит, её правильность нечем было бы проверить.
- **Что доказывает программа батчей.** Транзакции взяты из данных, опубликованных в TON;
  исполнены только подписанные владельцем счёта и идущие по его nonce, остальные пропущены;
  очередь L1 обработана по порядку; дерево выводов продолжено от корня, который хранит
  контракт. Полный список — в [ARCHITECTURE.md](ARCHITECTURE.md).
- **Ключ программы** входит в ключ контракта как константа (свёрнут в IC0). Пруф другой
  программы — или прежней версии этой — тем же ключом не проверится.

## Привязка пруфов и ключа контракта к исходникам

Ключ программы SP1 определяется её ELF, а ELF — исходниками. Раньше эту связь не проверяло
ничто: после правки программы прежние пруфы и прежний ключ продолжали сходиться друг с
другом, а `program.json` правился руками. Теперь связь держится цепочкой:

```
исходники zkvm/{lib,exit-lib,program,exit-program}, Cargo.toml, Cargo.lock
   │  sha256 — считают независимо zkvm/script/src/sources.rs и zk/program-binding.mjs
   ▼
fixtures/zkvm_batches/program.json     ← пишет только `rollup-script --vkeys`
   │  ключи обеих программ, хеши их ELF, хеш исходников
   ▼
fixtures/zkvm_batches/key.json         ← `node zk/gen-rollup-key.mjs`, без пруфа:
   │  закреплённый верификатор SP1 (zk/sp1-pins.json) + ключи программ → ключ контракта
   ▼
контракт: get-методы keyHash и exitKeyHash обязаны вернуть хеши из key.json
   ▲
фикстуры пруфов fixtures/sp1_rollup_*  ← импортёр отвергает пруф с чужим ключом программы
                                          или из других исходников
```

Что на каком шаге проверяется:

- Сборка `zkvm/script` отказывает, если окружение отключает сборку гостевых программ
  (`SP1_SKIP_PROGRAM_BUILD`) или исходники изменились, пока она шла: иначе в бинарник попал бы
  хеш нынешних исходников и ELF прежней программы.
- `rollup-script` в любом режиме отказывается работать, если собран из других исходников
  программ или другого сценария (`zkvm/native`), чем лежат на диске; в режиме `--prove` — ещё
  и если ключ программы, хеш ELF или хеш исходников не совпали с `program.json`.
- **`zkvm/script/verify-elf.sh`** убирает прежние ELF, собирает оба заново и сверяет sha256 с
  `program.json`. Это единственная проверка того, что ELF действительно собран из нынешних
  исходников (остальные сверяют записи в файлах), и она **обязательна перед пруфами**.
- `zk/import-sp1-fixture.mjs` принимает пруф, только если его ключ программы и хеш ELF — из
  `program.json`, публичные значения — те, что сценарий выдаёт под этим именем фикстуры,
  нонс нулевой, а верификатор SP1 совпал с закреплённым. Сам пруф проверяется спариванием.
- `node zk/gen-rollup-key.mjs --check` пересчитывает всё содержимое `key.json` из
  закреплённого ключа схемы и `program.json`.
- `tests/ProgramBinding.spec.ts` сверяет хеш исходников в дереве с `program.json`, запускает
  проверку `key.json`, а фикстуры пруфов (когда они есть) сверяет с ключом программы, хешем
  ELF, сценарием и ключом контракта. Сквозные тесты с пруфами SP1 запускаются, только если
  всё сошлось. Тест в `zkvm/native` сверяет закоммиченные `batches.json` и `claims.json` с
  выводом нынешнего сценария.

Годность пруфа определяется ключом программы и хешем ELF, а не хешем исходников. Хеш
исходников меняется и от правки тестов в `zkvm/lib`; ELF при этом остаётся прежним, и пруфы
остаются годными — достаточно пересобрать скрипт, запустить `--vkeys` и `verify-elf.sh`.

Чего цепочка НЕ гарантирует:

- **Защиты от намеренной правки файлов.** Хеши и ключи в `program.json` и `key.json` — записи;
  цепочка ловит забытый шаг, а не подделку. Истину показывает `verify-elf.sh`.
- **Что ключ программы получается из этих исходников на другой машине.** На машине, где
  считались ключи, чистая пересборка даёт те же ELF побайтно (`verify-elf.sh`, 13.11.2026).
  Сборка идёт строго по `Cargo.lock` и с подменой пути каталога cargo (`--remap-path-prefix`),
  так что от имени пользователя и расположения проекта ELF не зависит. Но без Docker-образа
  SP1 он зависит от версии компилятора гостя и cargo — они записаны в `program.json`; на
  другой машине сборка не проверялась.
- **Что закреплённый ключ Groth16-схемы честен.** Он сверен с репозиторием
  `succinctlabs/sp1-contracts` (подробности — поле `checked` в `zk/sp1-pins.json`); церемония
  и соответствие файла `groth16_vk.bin` константам верификатора не проверялись.

## Порядок действий после изменения программ

```bash
# 1. Пересобрать хост-скрипт (он же собирает оба ELF). Нужны protoc и Go из .tools/.
T="$PWD/.tools"
export PATH="$T/go/bin:$HOME/.sp1/bin:$HOME/.cargo/bin:$PATH" PROTOC="$T/protoc/bin/protoc" GOPATH="$T/gopath" GOCACHE="$T/gocache" GOFLAGS=-modcacherw
(cd zkvm && cargo test -p rollup-stf -p rollup-exit -p rollup-native && cargo run -p rollup-native)
(cd zkvm/script && cargo build --release --features native-gnark)

# 2. Ключи программ, сверка ELF чистой пересборкой, исполнение без пруфа. По одному шагу:
#    расчёт ключей на полминуты занимает все ядра, пересборка ELF — минуту-две.
(cd zkvm/script && ./target/release/rollup-script --vkeys && ./verify-elf.sh \
  && for job in "--batch 1" "--batch 2" "--batch 3" "--exit alice" "--exit bob"; do RAYON_NUM_THREADS=4 ./target/release/rollup-script $job --execute; done)

# 3. Ключ контракта из исходников и его сверка; тесты без пруфов (два воркера: на 16 ГБ
#    полный параллельный прогон вместе с другой работой вешает машину).
node zk/gen-rollup-key.mjs && node zk/gen-rollup-key.mjs --check
npx jest --maxWorkers=2
```

Дальше — независимая проверка изменений (REVIEW.md) и **только по команде пользователя**:

```bash
# 4. Пруфы: по одному, под сторожем диска, при закрытых программах (см. «Ресурсы»).
#    Перед ними ещё раз verify-elf.sh, если что-либо пересобиралось.
cd zkvm/script
./verify-elf.sh
for job in "--batch 1" "--batch 2" "--batch 3" "--exit alice" "--exit bob"; do ./prove-polite.sh $job --prove || break; done
cd ../..

# 5. Импорт и подсказки для контракта; сквозные тесты.
D="$HOME/.sp1/circuits/groth16/v6.1.0"
node zk/import-sp1-fixture.mjs "$D/Groth16Verifier.sol" "$D/SP1VerifierGroth16.sol" fixtures/zkvm_batches/proof-batch1.json sp1_rollup_batch1
node zk/import-sp1-fixture.mjs "$D/Groth16Verifier.sol" "$D/SP1VerifierGroth16.sol" fixtures/zkvm_batches/proof-batch2.json sp1_rollup_batch2
node zk/import-sp1-fixture.mjs "$D/Groth16Verifier.sol" "$D/SP1VerifierGroth16.sol" fixtures/zkvm_batches/proof-batch3.json sp1_rollup_batch3
node zk/import-sp1-fixture.mjs "$D/Groth16Verifier.sol" "$D/SP1VerifierGroth16.sol" fixtures/zkvm_exit/proof-alice.json sp1_rollup_exit_alice
node zk/import-sp1-fixture.mjs "$D/Groth16Verifier.sol" "$D/SP1VerifierGroth16.sol" fixtures/zkvm_exit/proof-bob.json sp1_rollup_exit_bob
for f in sp1_rollup_batch1 sp1_rollup_batch2 sp1_rollup_batch3 sp1_rollup_exit_alice sp1_rollup_exit_bob; do node zk/gen-bn254-groth16-fixture.mjs $f; done
npx jest tests/ProgramBinding.spec.ts tests/RollupZkvmProof.spec.ts tests/RollupEscapeProof.spec.ts
```

Импортёр проверяет пруф эталонной библиотекой; генератор подсказок строит ещё и «лучшую
подделку» — тот же пруф под ложное утверждение, — на которой тесты проверяют, что контракт
отказывает именно замыкающим равенством.

## Ресурсы

Замеры — `bench/zkvm-local-run.json` (Apple M4, 10 ядер, 16 ГБ; прежние версии программ, но
схема и обёртка те же).

Обёртка в Groth16 на машине с 16 ГБ памяти идёт на подкачке: пиковый след процесса 27 ГБ,
свободное место на диске падало с 21 до 5 ГБ. Это работает, но на пределе: при посторонней
нагрузке сторож дважды убивал прувер.

- Диск: артефакты схемы — 6,2 ГБ архив, 7,9 ГБ после распаковки; плюс подкачка. На ноутбуке
  нужно 20+ ГБ свободного места перед запуском.
- Память: комфортно — от 32 ГБ; на 16 ГБ — только с закрытыми программами и под сторожем.
- Время: 9–14 минут на пруф, из них обёртка gnark — около 2,5 минут (15 972 262 ограничения).
- GPU не нужен.

`prove-guarded.sh` ждёт, пока освободится место для старта, и убивает прувер, если свободного
места меньше `MIN_FREE_GB` (по умолчанию 4).

`prove-polite.sh` — обёртка над ним для машины, на которой работает человек и другие задачи:
ждёт затишья перед стартом, запускает прувер с низким приоритетом, а если посторонние
процессы больше минуты держат заметную долю процессора — ставит прувер на паузу и продолжает,
когда чужая работа закончилась. Все пять нынешних пруфов построены через неё.

Артефакты схемы SDK скачивает сам при первом `--prove` (архив и распаковка рядом, ~14 ГБ
на пике). Чтобы не держать архив на диске, их можно распаковать из потока:

```bash
P="$HOME/.sp1/circuits/groth16"; mkdir -p "$P/tmp" && curl -sSL --fail https://sp1-circuits.s3-us-east-2.amazonaws.com/v6.1.0-groth16.tar.gz | tar -xzf - -C "$P/tmp" && touch "$P/tmp/.complete" && mv "$P/tmp" "$P/v6.1.0"
```

После распаковки стоит убедиться, что скачано то, что закреплено: `node zk/gen-rollup-key.mjs`
остановится, если `Groth16Verifier.sol` или `SP1VerifierGroth16.sol` разошлись с `zk/sp1-pins.json`.

## На Linux-сервере (не проверено)

```bash
sudo apt-get update && sudo apt-get install -y build-essential pkg-config libssl-dev protobuf-compiler git curl docker.io
curl https://sh.rustup.rs -sSf | sh -s -- -y && . "$HOME/.cargo/env"
curl -L https://sp1up.succinct.xyz | bash && "$HOME/.sp1/bin/sp1up"
git clone <этот репозиторий> && cd ton-zk-rollup/zkvm/script
export PATH="$HOME/.sp1/bin:$PATH"
cargo run --release -- --vkeys
cargo run --release -- --batch 1 --prove
```

Без `native-gnark` обёртку считает Docker-образ `ghcr.io/succinctlabs/sp1-gnark:v6.1.0`.
На другой машине ключи программ могут получиться другими (сборка не воспроизводима побайтно):
тогда `--vkeys` перезапишет `program.json`, и ключ контракта придётся выводить заново.

## Спайк EVM (14.11.2026, без пруфов)

`zkvm-evm/` — батч rollup'а как блок EVM: Reth исполняет блок внутри SP1 (на библиотеках
[RSP](https://github.com/succinctlabs/rsp), коммит `5afe72eb`), программа коммитит те же
восемь слов. Отдельное рабочее пространство: `zkvm/`, его `Cargo.lock`, ключи и пруфы
нынешних программ не затронуты. **Пруфов этой программы нет, и к контракту её подключать
нельзя**: шестой круг проверки (`REVIEW.md`) нашёл две критичные дыры в использовании RSP
(исправлены; седьмой круг признал исправления полными) и два критичных пробела на стыке с
контрактом (не исправлены). Кроме того, со штатным хостом RSP часть честных блоков
недоказуема (7-1): нужен хост на Reth. Что значат слова для EVM и чего в спайке нет — в шапке
`zkvm-evm/lib/src/lib.rs`; замеры циклов — `bench/evm-rsp-cycles.json`.

Инструменты вне репозитория (в `.tools/`): `anvil` и `cast` из Foundry v1.9.0 (архив релиза
`foundry_v1.9.0_darwin_arm64.tar.gz` с GitHub, sha256 — в файле `.sha256` того же релиза) и
`rsp`, собранный из исходников на том же коммите (`cargo build --release --locked --bin rsp`,
нужен `PROTOC`). Дерево состояния — копия `rsp-mpt` в `zkvm-evm/vendor/` с тремя правками:
`diff -r .tools/rsp/crates/mpt/src zkvm-evm/vendor/rsp-mpt/src`.

```bash
cd zkvm-evm && cargo build --release --locked -p rollup-evm-host   # хост и гостевая программа
zkvm-evm/scenario/anvil-scenario.sh honest             # блоки anvil → фикстуры, zkVM без пруфа
zkvm-evm/scenario/anvil-scenario.sh reverting-bridge   # цепочка, где переводы на мост не проходят
cd zkvm-evm && cargo test --release --locked -p rollup-evm         # тесты (фикстуры в fixtures/evm_batches/)
python3 zkvm-evm/scenario/mutation-check.py            # проверка тестов мутациями → scenario/mutation-report.txt
python3 zkvm-evm/scenario/check-locks.py               # версии крейтов в тестах и в ELF совпадают
```

### Пруф блока EVM для контракта

Цепочка привязки — та же, что у программ `zkvm/`, в отдельных файлах: хеш исходников
(`zkvm-evm/host/src/sources.rs`, повтор — `zk/evm-binding.mjs`) → `fixtures/evm_batches/program.json`
(`rollup-evm-host --vkeys`) → `fixtures/evm_batches/key.json` (`node zk/gen-evm-rollup-key.mjs`) →
`fixtures/sp1_evm_batch2` (импорт пруфа). **Ключ выхода в `key.json` — заглушка**: программы
аварийного выхода для состояния EVM нет, контракт с этим ключом годится только для демонстрации
приёма батча. Батч для контракта — `fixtures/evm_batches/contract/block-2.*`: блок 2 сценария с
нулевым хешем очереди L1, как у только что развёрнутого контракта.

```bash
# Хост с прувером (нужны protoc и Go из .tools/, переменные — как в «Порядке действий» выше).
(cd zkvm-evm && cargo build --release --locked -p rollup-evm-host --features native-gnark)
zkvm-evm/target/release/rollup-evm-host --vkeys
zkvm-evm/host/verify-elf.sh                      # чистая пересборка ELF и сверка с program.json
node zk/gen-evm-rollup-key.mjs && node zk/gen-evm-rollup-key.mjs --check

# Только по команде пользователя. С настройками SP1 по умолчанию прувер не помещается в 16 ГБ:
# шарды уменьшены в шесть раз, по одному рабочему на этап (bench/evm-rsp-cycles.json).
export ELEMENT_THRESHOLD=67108864 HEIGHT_THRESHOLD=1048576 SP1_WORKER_NUM_CORE_WORKERS=1 \
  SP1_WORKER_CORE_BUFFER_SIZE=1 SP1_WORKER_NUM_SPLICING_WORKERS=1 SP1_WORKER_SPLICING_BUFFER_SIZE=1 \
  SP1_WORKER_NUM_SETUP_WORKERS=1 SP1_WORKER_NUM_RECURSION_PROVER_WORKERS=1 \
  SP1_WORKER_NUM_RECURSION_EXECUTOR_WORKERS=1 SP1_WORKER_NUM_PREPARE_REDUCE_WORKERS=1 \
  SP1_WORKER_NUM_DEFERRED_WORKERS=1
zkvm-evm/host/prove-guarded.sh --batch-input fixtures/evm_batches/contract/block-2.bin \
  --prove --proof-out fixtures/evm_batches/proof-block2.json

# Импорт (проверка пруфа спариванием под закреплённым ключом схемы), подсказки, тест.
D="$HOME/.sp1/circuits/groth16/v6.1.0"
node zk/import-sp1-fixture.mjs "$D/Groth16Verifier.sol" "$D/SP1VerifierGroth16.sol" fixtures/evm_batches/proof-block2.json sp1_evm_batch2
node zk/gen-bn254-groth16-fixture.mjs sp1_evm_batch2
npx jest tests/RollupEvmProof.spec.ts
```

После повторного запуска сценария цепочка anvil другая: батч для контракта и пруф под него
становятся негодными (тест пометит себя ожидающим пруфа).

Сценарий каждый раз создаёт новую цепочку, поэтому фикстуры и хеши блоков в них меняются от
запуска к запуску (время блоков); тесты сверяются с `expected.json` того же запуска. Сценарий
отказывает, если исходники новее бинарника хоста. После `mutation-check.py` хост нужно
пересобрать: скрипт возвращает исходники с новым временем изменения.
