#!/usr/bin/env bash
# Выкладывает на арендованный сервер ровно то, что нужно для замера пруфа блока EVM. Запуск на
# маке из любого каталога:
#
#   zkvm-evm/host/remote/push.sh <ssh-хост>      # хост — запись в ~/.ssh/config
#   zkvm-evm/host/remote/push.sh --dry-run       # только собрать и проверить набор, без ssh
#
# Что едет (в ~/ton-zk-rollup на сервере, с теми же путями, что в репозитории):
#   исходники zkvm-evm (lib, host, program, vendor, манифесты, Cargo.lock, rust-toolchain.toml)
#   и zkvm/lib с zkvm/Cargo.toml (зависимость тестов, без неё cargo не загрузит рабочее
#   пространство) — из git, без target; fixtures/evm_batches/program.json; вход и отчёт блока 3
#   (fixtures/evm_batches/reth/block-3.{bin,json}); zk/sp1-pins.json; готовый ELF программы
#   (remote-input/rollup-evm-program.elf) и MANIFEST.sha256 всех файлов.
# Репозиторий не клонируется, токены и ключи не передаются; всё перечисленное — публичные данные
# (программа и вход блока, который и так публикуется в TON).
#
# Набор берётся из git: в этих путях не должно быть незакоммиченных правок. Перед отправкой
# проверяется, что ELF — тот, что в program.json, и что хеш исходников набора равен
# sourcesSha256 из program.json (иначе хост на сервере откажется работать).
set -euo pipefail

TARGET="${1:-}"
REPOSITORY="$(cd "$(dirname "$0")/../../.." && pwd -P)"
ELF="zkvm-evm/program/target/elf-compilation/riscv64im-succinct-zkvm-elf/release/rollup-evm-program"
REMOTE_DIR="ton-zk-rollup"
PATHS=(
    zkvm-evm/Cargo.toml zkvm-evm/Cargo.lock zkvm-evm/rust-toolchain.toml zkvm-evm/.gitignore
    zkvm-evm/lib zkvm-evm/host zkvm-evm/program zkvm-evm/vendor
    zkvm/Cargo.toml zkvm/lib
    fixtures/evm_batches/program.json fixtures/evm_batches/reth/block-3.bin fixtures/evm_batches/reth/block-3.json
    zk/sp1-pins.json
)

die() { echo "[push] ОШИБКА: $*" >&2; exit 1; }
say() { echo "[push] $*"; }

case "$TARGET" in
    --dry-run) ;;
    ''|-*) die "использование: push.sh <ssh-хост> | --dry-run" ;;
    *) [[ "$TARGET" =~ ^[A-Za-z0-9._@-]+$ ]] || die "имя ssh-хоста «$TARGET»: только буквы, цифры, . _ @ -" ;;
esac
cd "$REPOSITORY"

[ -z "$(git status --porcelain -- "${PATHS[@]}")" ] || die "в отправляемых путях есть незакоммиченные правки: git status -- ${PATHS[*]}"
field() { python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' fixtures/evm_batches/program.json "$1"; }
[ -f "$ELF" ] || die "нет $ELF: соберите хост (PROVING.md), он собирает и программу"
[ "$(shasum -a 256 "$ELF" | awk '{ print $1 }')" = "$(field programElfSha256)" ] || die "ELF не совпал с program.json: zkvm-evm/host/verify-elf.sh"
say "ELF совпал с program.json: $(field programElfSha256)"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/zk-remote-push.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
# Без ссылок в пути (/var → /private/var): evm-binding.mjs печатает хеш, только если путь
# запуска равен его собственному.
STAGE="$(cd "$STAGE" && pwd -P)"
git ls-files -z -- "${PATHS[@]}" | COPYFILE_DISABLE=1 tar --null -T - -cf - | tar -xf - -C "$STAGE"
mkdir -p "$STAGE/remote-input"
cp "$ELF" "$STAGE/remote-input/rollup-evm-program.elf"

# Хеш исходников набора — тем же алгоритмом, что у хоста (zk/evm-binding.mjs считает от своего
# каталога: копия скрипта во временном наборе и удаляется сразу после).
mkdir -p "$STAGE/zk" && cp zk/evm-binding.mjs "$STAGE/zk/"
STAGED_SOURCES="$(node "$STAGE/zk/evm-binding.mjs")" || die "zk/evm-binding.mjs не отработал"
rm "$STAGE/zk/evm-binding.mjs"
[ "$STAGED_SOURCES" = "$(field sourcesSha256)" ] || die "хеш исходников набора $STAGED_SOURCES не равен sourcesSha256 из program.json"
say "хеш исходников набора совпал с program.json: $STAGED_SOURCES"

(cd "$STAGE" && find . -type f ! -path ./remote-input/MANIFEST.sha256 | LC_ALL=C sort | xargs shasum -a 256 > remote-input/MANIFEST.sha256)
say "набор: $(wc -l < "$STAGE/remote-input/MANIFEST.sha256" | tr -d ' ') файлов, $(du -sh "$STAGE" | cut -f1)"

if [ "$TARGET" = "--dry-run" ]; then
    # Набор обязан загружаться cargo сам по себе: без офлайн-кэша этого мака на сервере он
    # проверится сборкой, здесь — только разбор рабочего пространства по Cargo.lock.
    cargo metadata --offline --locked --format-version 1 --manifest-path "$STAGE/zkvm-evm/Cargo.toml" > /dev/null
    say "dry-run: рабочее пространство набора разбирается по Cargo.lock; на сервер ничего не отправлено"
    exit 0
fi

# На сервере: прежний набор убирается целиком (лишний файл исходников сменил бы их хеш), кэш
# сборки (zkvm-evm/target), результаты (remote-out) и задания сервиса-секвенсора (remote-jobs,
# prove-job.sh) остаются.
say "отправляю на $TARGET:~/$REMOTE_DIR"
COPYFILE_DISABLE=1 tar -C "$STAGE" --no-xattrs --no-mac-metadata -czf - . | ssh -- "$TARGET" "set -e
mkdir -p ~/$REMOTE_DIR && cd ~/$REMOTE_DIR
find . -mindepth 1 -maxdepth 1 ! -name zkvm-evm ! -name remote-out ! -name remote-jobs -exec rm -rf {} +
if [ -d zkvm-evm ]; then find zkvm-evm -mindepth 1 -maxdepth 1 ! -name target -exec rm -rf {} +; fi
tar -xzf - --no-same-owner --warning=no-unknown-keyword
sha256sum --quiet -c remote-input/MANIFEST.sha256 && echo '[push] на сервере файлы совпали с MANIFEST.sha256'"
say "готово. Дальше на сервере: bash ~/$REMOTE_DIR/zkvm-evm/host/remote/setup.sh"
