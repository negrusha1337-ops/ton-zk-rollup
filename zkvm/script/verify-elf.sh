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

recorded() { sed -n "s/.*\"$1\": \"\\([0-9a-f]*\\)\".*/\\1/p" "$PROGRAM_JSON"; }
restore() { rm -rf "$ELF_DIR"; [ -e "$ELF_DIR.keep" ] && mv "$ELF_DIR.keep" "$ELF_DIR"; }

[ -e "$ELF_DIR" ] && mv "$ELF_DIR" "$ELF_DIR.keep"
# Сбой сборки или прерывание (Ctrl-C): вернуть прежние ELF, чтобы не оставить проект без них.
trap 'echo "Сборка не удалась или прервана: возвращаю прежние ELF." >&2; restore; exit 1' ERR INT TERM

# Те же аргументы, что в build.rs: --locked и подмена пути cargo-home.
for program in program exit-program; do
    (cd "$program" && nice -n 15 cargo prove build --locked --rustflags="--remap-path-prefix=$CARGO_HOME_DIR=/cargo-home")
done
trap - ERR INT TERM

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
HOME_PATHS="$(strings "$RELEASE/rollup-program" "$RELEASE/rollup-exit-program" | grep -c "$HOME" || true)"
if [ "$HOME_PATHS" -ne 0 ]; then
    echo "В ELF остались пути из домашнего каталога ($HOME), строк: $HOME_PATHS — ключ программы не воспроизвести на другой машине." >&2
    STATUS=1
else
    echo "путей из домашнего каталога в ELF нет"
fi
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
