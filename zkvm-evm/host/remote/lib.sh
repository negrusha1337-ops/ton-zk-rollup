#!/usr/bin/env bash
# Общее у measure.sh и prove-job.sh (подключается через `.`, сам не запускается). НА СЕРВЕРЕ, в
# каталоге, который выложил push.sh. Ожидает ROOT — корень набора.
#
#   HOST, ELF, PROGRAM_JSON — пути хоста, ELF с мака и program.json;
#   sha256_of <файл>        — sha256 файла (пусто, если файла нет);
#   expected_elf_sha256     — programElfSha256 из program.json;
#   load_cpu_env            — CPU_ENV: переменные шардов для этапов на процессоре
#                             (zkvm-evm/host/prover-shards.env — тот же файл, что у PROVING.md и
#                             сервиса-секвенсора); GPU-этапы идут с настройками SP1 по умолчанию.

# Пути — для подключающих скриптов.
# shellcheck disable=SC2034
HOST="$ROOT/zkvm-evm/target/release/rollup-evm-host"
# shellcheck disable=SC2034
ELF="$ROOT/remote-input/rollup-evm-program.elf"
PROGRAM_JSON="$ROOT/fixtures/evm_batches/program.json"

sha256_of() {
    [ -f "$1" ] || return 0
    sha256sum "$1" | awk '{ print $1 }'
}

expected_elf_sha256() {
    python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["programElfSha256"])' "$PROGRAM_JSON"
}

load_cpu_env() {
    CPU_ENV=()
    local shards="$ROOT/zkvm-evm/host/prover-shards.env" line
    [ -f "$shards" ] || { echo "нет $shards (push.sh везёт его вместе с zkvm-evm/host)" >&2; return 1; }
    while IFS= read -r line; do
        case "$line" in
            ''|'#'*) ;;
            [A-Z_]*=*) CPU_ENV+=("$line") ;;
            *) echo "непонятная строка в $shards: $line" >&2; return 1 ;;
        esac
    done < "$shards"
}
