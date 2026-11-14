#!/bin/bash
# Сверка ELF гостевой программы батча EVM чистой пересборкой — то же, что
# zkvm/script/verify-elf.sh для нынешних программ. Обязательна перед пруфами.
#
#   zkvm-evm/host/verify-elf.sh
#
# Хеш исходников в program.json — запись в файле: он не доказывает, что ELF, вшитый в хост,
# собран из этих исходников. Здесь прежний ELF убирается в сторону, программа собирается заново
# теми же флагами, что в host/build.rs, и её sha256 сравнивается с program.json. Заодно
# проверяется, что в ELF нет путей этой машины: от них зависел бы ключ программы.
# Нагрузка: полная пересборка гостевой программы, несколько минут.
set -euo pipefail

cd "$(dirname "$0")/.."
REPOSITORY="$(cd .. && pwd -P)"
ELF_DIR="program/target/elf-compilation"
RELEASE="$ELF_DIR/riscv64im-succinct-zkvm-elf/release"
ELF="$RELEASE/rollup-evm-program"
PROGRAM_JSON="../fixtures/evm_batches/program.json"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
export PATH="$HOME/.sp1/bin:$CARGO_HOME_DIR/bin:$PATH"

for variable in SP1_SKIP_PROGRAM_BUILD RUSTC_WORKSPACE_WRAPPER; do
    if [ -n "${!variable:-}" ]; then
        echo "Переменная $variable задана: с ней гостевая программа может не собраться. Уберите её." >&2
        exit 1
    fi
done
if [ -e "$ELF_DIR.keep" ]; then
    echo "Остался $ELF_DIR.keep от прерванного запуска: разберитесь с ним вручную." >&2
    exit 1
fi
command -v strings >/dev/null || { echo "Нет утилиты strings: пути в ELF проверить нечем." >&2; exit 1; }
command -v shasum >/dev/null || { echo "Нет утилиты shasum." >&2; exit 1; }
[ -f "$PROGRAM_JSON" ] || { echo "Нет $PROGRAM_JSON: сначала rollup-evm-host --vkeys." >&2; exit 1; }

EXPECTED="$(sed -n 's/.*"programElfSha256": "\([0-9a-f]*\)".*/\1/p' "$PROGRAM_JSON")"
[ -n "$EXPECTED" ] || { echo "В $PROGRAM_JSON нет programElfSha256." >&2; exit 1; }

DONE=0
restore() {
    [ "$DONE" -eq 1 ] && return 0
    echo "Сверка не завершена: возвращаю прежний ELF." >&2
    rm -rf "$ELF_DIR"
    [ -e "$ELF_DIR.keep" ] && mv "$ELF_DIR.keep" "$ELF_DIR"
    return 0
}
trap restore EXIT
trap 'exit 130' INT TERM HUP
[ -e "$ELF_DIR" ] && mv "$ELF_DIR" "$ELF_DIR.keep"

(cd program && nice -n 15 cargo prove build --locked \
    --rustflags="--remap-path-prefix=$CARGO_HOME_DIR=/cargo-home,--remap-path-prefix=$REPOSITORY=/ton-zk-rollup")
[ -f "$ELF" ] || { echo "После сборки нет $ELF." >&2; exit 1; }

STATUS=0
BUILT="$(shasum -a 256 "$ELF" | cut -d' ' -f1)"
if [ "$BUILT" = "$EXPECTED" ]; then
    echo "rollup-evm-program: совпал ($BUILT)"
else
    echo "rollup-evm-program: НЕ СОВПАЛ — собран $BUILT, в program.json $EXPECTED" >&2
    STATUS=1
fi
# grep -c при нуле совпадений завершается с кодом 1: «|| true» обязателен под pipefail.
ELF_STRINGS="$(strings "$ELF")"
[ -n "$ELF_STRINGS" ] || { echo "strings не выдала ни одной строки: проверка путей не состоялась." >&2; exit 1; }
HOME_PATHS="$(printf '%s\n' "$ELF_STRINGS" | grep -c "$HOME" || true)"
if [ "$HOME_PATHS" -ne 0 ]; then
    echo "В ELF остались пути из домашнего каталога ($HOME), строк: $HOME_PATHS — ключ программы не воспроизвести на другой машине." >&2
    STATUS=1
else
    echo "путей из домашнего каталога в ELF нет"
fi
DONE=1
if [ "$STATUS" -ne 0 ]; then
    rm -rf "$ELF_DIR.previous"
    [ -e "$ELF_DIR.keep" ] && mv "$ELF_DIR.keep" "$ELF_DIR.previous"
    echo "ELF не соответствует program.json: пересоберите хост и запустите --vkeys. Прежние пруфы негодны." >&2
    echo "Прежний ELF сохранён в $ELF_DIR.previous." >&2
else
    rm -rf "$ELF_DIR.keep"
fi
exit "$STATUS"
