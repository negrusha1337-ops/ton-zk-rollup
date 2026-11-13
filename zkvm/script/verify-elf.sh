#!/bin/bash
# Чистая пересборка обеих гостевых программ и сверка с fixtures/zkvm_batches/program.json.
#
#   ./verify-elf.sh
#
# Зачем. Хеш исходников в program.json — запись в файле: он ловит забытый шаг, но не
# доказывает, что ELF (а значит, и ключ программы) действительно собран из нынешних
# исходников. ELF мог остаться от прежней сборки: cargo решает, пересобирать ли, по времени
# изменения файлов, а sp1-build при некоторых переменных окружения не собирает вовсе. Этот
# скрипт убирает прежние ELF, собирает оба заново и сравнивает sha256 с записанными.
#
# ОБЯЗАТЕЛЬНЫЙ шаг перед построением пруфов (PROVING.md). Занимает одну-две минуты и грузит
# процессор: не запускать параллельно с другой тяжёлой работой.
set -euo pipefail

cd "$(dirname "$0")/.."
ELF_DIR="target/elf-compilation"
RELEASE="$ELF_DIR/riscv64im-succinct-zkvm-elf/release"
PROGRAM_JSON="../fixtures/zkvm_batches/program.json"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
export PATH="$HOME/.sp1/bin:$CARGO_HOME_DIR/bin:$PATH"

for variable in SP1_SKIP_PROGRAM_BUILD RUSTC_WORKSPACE_WRAPPER; do
    if [ -n "${!variable:-}" ]; then
        echo "Переменная $variable задана: с ней гостевые программы могут не собраться. Уберите её." >&2
        exit 1
    fi
done
if [ -e "$ELF_DIR.keep" ]; then
    echo "Остался $ELF_DIR.keep от прерванного запуска: разберитесь с ним вручную." >&2
    exit 1
fi

# Всё, без чего сверка не имеет смысла, проверяется ДО того, как прежние ELF убраны в сторону.
command -v strings >/dev/null || { echo "Нет утилиты strings (Xcode Command Line Tools): пути в ELF проверить нечем." >&2; exit 1; }
command -v shasum >/dev/null || { echo "Нет утилиты shasum." >&2; exit 1; }
[ -f "$PROGRAM_JSON" ] || { echo "Нет $PROGRAM_JSON: сначала rollup-script --vkeys." >&2; exit 1; }

recorded() { sed -n "s/.*\"$1\": \"\\([0-9a-f]*\\)\".*/\\1/p" "$PROGRAM_JSON"; }

# Пока сверка не дошла до конца, при ЛЮБОМ выходе (сбой сборки, отсутствующий файл, Ctrl-C,
# закрытый терминал, сигнал) прежние ELF возвращаются на место: проект не остаётся без них,
# и следующий запуск не упирается в оставленный каталог .keep.
DONE=0
restore() {
    [ "$DONE" -eq 1 ] && return 0
    echo "Сверка не завершена: возвращаю прежние ELF." >&2
    rm -rf "$ELF_DIR"
    [ -e "$ELF_DIR.keep" ] && mv "$ELF_DIR.keep" "$ELF_DIR"
    return 0
}
trap restore EXIT
trap 'exit 130' INT TERM HUP
[ -e "$ELF_DIR" ] && mv "$ELF_DIR" "$ELF_DIR.keep"

# Те же аргументы, что в build.rs: --locked и подмена пути cargo-home.
for program in program exit-program; do
    (cd "$program" && nice -n 15 cargo prove build --locked --rustflags="--remap-path-prefix=$CARGO_HOME_DIR=/cargo-home")
done
for elf in rollup-program rollup-exit-program; do
    [ -f "$RELEASE/$elf" ] || { echo "После сборки нет $RELEASE/$elf." >&2; exit 1; }
done

STATUS=0
for pair in "rollup-program:programElfSha256" "rollup-exit-program:exitProgramElfSha256"; do
    elf="${pair%%:*}"; field="${pair##*:}"
    built="$(shasum -a 256 "$RELEASE/$elf" | cut -d' ' -f1)"
    expected="$(recorded "$field")"
    if [ "$built" = "$expected" ]; then
        echo "$elf: совпал ($built)"
    else
        echo "$elf: НЕ СОВПАЛ — собран $built, в program.json $expected" >&2
        STATUS=1
    fi
done
# Домашний каталог не должен попадать в ELF: иначе ключ программы зависит от имени пользователя.
# Счётчик, а не `grep -q`: под `pipefail` ранний выход grep обрывал бы strings сигналом, и
# конвейер считался бы неуспешным — проверка не сработала бы никогда.
ELF_STRINGS="$(strings "$RELEASE/rollup-program" "$RELEASE/rollup-exit-program")"
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
    # Прежние ELF оставляем рядом: их можно сравнить с новыми.
    rm -rf "$ELF_DIR.previous"
    [ -e "$ELF_DIR.keep" ] && mv "$ELF_DIR.keep" "$ELF_DIR.previous"
    echo "ELF не соответствуют program.json: пересоберите zkvm/script и запустите --vkeys. Прежние пруфы негодны." >&2
    echo "Прежние ELF сохранены в $ELF_DIR.previous." >&2
else
    rm -rf "$ELF_DIR.keep"
fi
exit "$STATUS"
