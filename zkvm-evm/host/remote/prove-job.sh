#!/usr/bin/env bash
# Задание пруфа батча для сервиса-секвенсора (sequencer/remoteProver.ts, RemoteProver). Запускает
# его RemoteProver по ssh НА СЕРВЕРЕ, в наборе, который выложил push.sh и подготовил setup.sh:
#
#   prove-job.sh check                              готов ли сервер: строки «ключ=значение»
#   prove-job.sh prepare <ключ>                     каталог задания remote-jobs/<ключ>/
#   prove-job.sh start <ключ> <sha256 входа> [auto|onestep|twostep] [retry]
#                                                   вход batch.bin.part (scp) → batch.bin, пруф в фоне
#   prove-job.sh status <ключ>                      state=… attempt=… code=… tail=…
#   prove-job.sh cancel <ключ>                      погасить пруф задания (вся группа процессов)
#   prove-job.sh run <ключ> <режим>                 внутреннее: сам пруф (его запускает start)
#
# Ключ задания — jobKeyOf сервиса: 64 hex (хеш блока) «-» 64 hex (sha256 публичных значений).
# Пруф идёт отдельной сессией (setsid nohup): обрыв ssh его не гасит, а status того же ключа
# продолжает ожидание. start идемпотентен: идущее или законченное задание он не запускает заново;
# упавшее (failed) или потерянное (lost: процесс исчез, например, перезагрузка) — только с «retry».
# Одно задание на сервере: другое идущее — ответ busy=<ключ> и код 4.
#
# Пути пруфа — как у measure.sh (общее — lib.sh): onestep — Groth16 целиком на GPU
# (SP1_PROVER=cuda, --prove); twostep — сжатый на GPU (--prove-compressed) и обёртка на процессоре
# (--wrap-groth16, переменные шардов); auto (по умолчанию) — onestep, а если он не удался — twostep.
# ELF — с мака (remote-input/rollup-evm-program.elf): sha256 сверяется здесь с program.json, ключ
# программы — самим хостом (--elf). Пруф с сервера на маке проверяется заново (proofImport.ts):
# сервер не доверенный.
#
# Коды: 0 — сделано; 2 — неверный вызов или вход; 3 — задание отменено; 4 — сервер занят другим.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
# shellcheck source=lib.sh
. "$ROOT/zkvm-evm/host/remote/lib.sh"
JOBS="$ROOT/remote-jobs"
MAX_JOB_MINUTES="${MAX_JOB_MINUTES:-180}"
CANCEL_GRACE_SECONDS="${CANCEL_GRACE_SECONDS:-15}"
SELF="$ROOT/zkvm-evm/host/remote/prove-job.sh"

die() { echo "error=$*"; exit 2; }
write() { printf '%s\n' "$2" > "$1.tmp" && mv -f "$1.tmp" "$1"; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

job_dir() {
    [[ "${1:-}" =~ ^[0-9a-f]{64}-[0-9a-f]{64}$ ]] || die "ключ задания «${1:-}» — не 64hex-64hex"
    DIR="$JOBS/$1"
}

# Задание, которое сейчас идёт (кроме $1), — его ключ; пусто — нет.
busy_with() {
    local state
    for state in "$JOBS"/*/state; do
        [ -f "$state" ] || continue
        local dir key
        dir="$(dirname "$state")"; key="$(basename "$dir")"
        [ "$key" = "${1:-}" ] && continue
        local value pid
        value="$(cat "$state")"; pid="$(cat "$dir/pid" 2>/dev/null)"
        # Идёт: running с живым процессом; queued — только что запущено (pid ещё не записан,
        # не старше минуты: start, оборванный посреди, не держит сервер вечно).
        if { [ "$value" = running ] || [ "$value" = queued ]; } && alive "$pid"; then echo "$key"; return; fi
        if [ "$value" = queued ] && [ -z "$pid" ] && [ -n "$(find "$state" -mmin -1 2>/dev/null)" ]; then echo "$key"; return; fi
    done
}

# Запуски по одному: проверка «сервер свободен» и запуск — под блокировкой (mkdir атомарен).
# Блокировка старше 10 с — от оборванного start: снимается.
lock_start() {
    local waited=0
    until mkdir "$JOBS/.start-lock" 2>/dev/null; do
        waited=$((waited + 1))
        if [ "$waited" -gt 100 ]; then rmdir "$JOBS/.start-lock" 2>/dev/null; waited=0; fi
        sleep 0.1
    done
    trap 'rmdir "$JOBS/.start-lock" 2>/dev/null' EXIT
}

state_of() {
    local state; state="$(cat "$DIR/state" 2>/dev/null || echo none)"
    if [ "$state" = running ] || [ "$state" = queued ]; then
        # Запущен, но процесса нет (сервер перезагружен, убит извне): задание потеряно.
        local pid; pid="$(cat "$DIR/pid" 2>/dev/null)"
        if [ -n "$pid" ] && ! alive "$pid"; then
            # Пруф мог записать итог и выйти между чтением состояния и проверкой процесса.
            state="$(cat "$DIR/state" 2>/dev/null || echo none)"
            if [ "$state" = running ] || [ "$state" = queued ]; then state=lost; fi
        fi
    fi
    echo "$state"
}

cmd_check() {
    echo "script=$(sha256_of "$SELF")"
    echo "lib=$(sha256_of "$ROOT/zkvm-evm/host/remote/lib.sh")"
    if [ -x "$HOST" ]; then echo "host=present"; else echo "host=missing"; fi
    if [ -f "$ROOT/remote-out/env.sh" ]; then echo "setup=present"; else echo "setup=missing"; fi
    local elf; elf="$(sha256_of "$ELF")"
    echo "elf=${elf:-missing}"
    if command -v nvidia-smi >/dev/null 2>&1; then
        echo "gpu=$(nvidia-smi -L 2>/dev/null | head -1 | tr -d '\r' | tr '=' ':' || true)"
    else
        echo "gpu=missing"
    fi
    echo "busy=$(busy_with '')"
}

cmd_prepare() {
    job_dir "$1"
    mkdir -p "$DIR" || die "каталог $DIR не создан"
    echo "prepared=$1"
}

cmd_start() {
    job_dir "$1"
    local sha="${2:-}" mode="${3:-auto}" retry="${4:-}"
    [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "sha256 входа «$sha» — не 64 hex"
    case "$mode" in auto|onestep|twostep) ;; *) die "режим «$mode»: auto, onestep или twostep" ;; esac
    [ -d "$DIR" ] || die "нет каталога задания: сначала prepare"
    local state; state="$(state_of)"
    case "$state" in
        running|queued) echo "started=already"; return 0 ;;
        done) echo "started=done"; return 0 ;;
        cancelled) echo "state=cancelled"; exit 3 ;;
        failed|lost) [ "$retry" = retry ] || { echo "state=$state"; echo "started=no"; return 0; } ;;
    esac
    lock_start
    local other; other="$(busy_with "$1")"
    if [ -n "$other" ]; then echo "busy=$other"; exit 4; fi
    if [ -f "$DIR/batch.bin.part" ]; then
        [ "$(sha256_of "$DIR/batch.bin.part")" = "$sha" ] || die "sha256 присланного входа не тот, что у сервиса: scp испорчен"
        mv -f "$DIR/batch.bin.part" "$DIR/batch.bin"
    fi
    [ -f "$DIR/batch.bin" ] && [ "$(sha256_of "$DIR/batch.bin")" = "$sha" ] || die "нет входа batch.bin с sha256 $sha"
    local attempt; attempt="$(( $(cat "$DIR/attempt" 2>/dev/null || echo 0) + 1 ))"
    write "$DIR/attempt" "$attempt"
    rm -f "$DIR/code" "$DIR/pid" "$DIR/proof.json" "$DIR/proof.part"
    write "$DIR/state" queued
    # Отдельная сессия: обрыв ssh и SIGHUP её не касаются; pid сессии — группа для cancel.
    setsid nohup bash "$SELF" run "$1" "$mode" > "$DIR/run.log" 2>&1 < /dev/null &
    # Пруф пишет свой pid первым делом; не появился за 10 с — не запустился (нет setsid, nohup…).
    local waited=0
    while [ ! -s "$DIR/pid" ] && [ "$waited" -lt 100 ]; do sleep 0.1; waited=$((waited + 1)); done
    if [ ! -s "$DIR/pid" ]; then
        write "$DIR/code" 127
        write "$DIR/state" failed
        die "пруф не запустился: $(tail -1 "$DIR/run.log" 2>/dev/null)"
    fi
    echo "started=$(cat "$DIR/pid")"
    echo "attempt=$attempt"
}

cmd_status() {
    job_dir "$1"
    echo "state=$(state_of)"
    echo "attempt=$(cat "$DIR/attempt" 2>/dev/null || echo 0)"
    echo "code=$(cat "$DIR/code" 2>/dev/null)"
    local log; log="$(ls -t "$DIR"/*.log 2>/dev/null | head -1)"
    echo "tail=$( [ -n "$log" ] && tail -1 "$log" | tr -d '\r' | cut -c1-300 )"
}

cmd_cancel() {
    job_dir "$1"
    [ -d "$DIR" ] || { echo "cancelled=absent"; return 0; }
    local state; state="$(state_of)"
    [ "$state" = "done" ] && { echo "cancelled=done"; return 0; }
    write "$DIR/state" cancelled
    local pid; pid="$(cat "$DIR/pid" 2>/dev/null)"
    if alive "$pid"; then
        kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
        local waited=0
        while alive "$pid" && [ "$waited" -lt "$CANCEL_GRACE_SECONDS" ]; do sleep 1; waited=$((waited + 1)); done
        kill -KILL -- "-$pid" 2>/dev/null || true
        # Сервер GPU живёт, пока жив хост; если что-то осталось — освободить карту.
        pkill -KILL -f sp1-gpu-server 2>/dev/null || true
    fi
    echo "cancelled=1"
}

# Один этап хоста: под пределом времени, журнал — <этап>.log. Код этапа — код хоста.
stage() {
    local name="$1" prover="$2"; shift 2
    local extra=()
    [ "$prover" = cpu ] && extra=("${CPU_ENV[@]}")
    env ${extra[@]+"${extra[@]}"} SP1_PROVER="$prover" RUST_LOG="${RUST_LOG:-info}" \
        timeout --signal=KILL "${MAX_JOB_MINUTES}m" "$HOST" "$@" > "$DIR/$name.log" 2>&1
    local status=$?
    [ "$prover" = cuda ] && { pkill -KILL -f sp1-gpu-server 2>/dev/null || true; }
    return "$status"
}

finish() {
    # Отменённое не перезаписывается: cancel пишет состояние до сигнала.
    [ "$(cat "$DIR/state" 2>/dev/null)" = cancelled ] && exit 3
    write "$DIR/code" "$1"
    write "$DIR/state" "$2"
    exit 0
}

cmd_run() {
    job_dir "$1"
    local mode="${2:-auto}"
    write "$DIR/pid" "$$"
    [ "$(cat "$DIR/state" 2>/dev/null)" = cancelled ] && exit 3
    write "$DIR/state" running
    # shellcheck source=/dev/null
    [ -f "$ROOT/remote-out/env.sh" ] && . "$ROOT/remote-out/env.sh"
    [ "$(sha256_of "$ELF")" = "$(expected_elf_sha256)" ] || { echo "ELF $ELF не совпал с program.json" > "$DIR/elf.log"; finish 2 failed; }
    load_cpu_env 2> "$DIR/env.log" || finish 2 failed
    local args=(--elf "$ELF" --batch-input "$DIR/batch.bin")
    local code=1
    if [ "$mode" != twostep ]; then
        stage onestep cuda "${args[@]}" --prove --proof-out "$DIR/proof.part"; code=$?
    fi
    if [ "$code" -ne 0 ] && [ "$mode" != onestep ]; then
        stage compressed cuda "${args[@]}" --prove-compressed --proof-out "$DIR/compressed.bin"; code=$?
        if [ "$code" -eq 0 ]; then
            stage wrap cpu "${args[@]}" --wrap-groth16 "$DIR/compressed.bin" --proof-out "$DIR/proof.part"; code=$?
        fi
    fi
    if [ "$code" -eq 0 ] && [ -s "$DIR/proof.part" ]; then
        mv -f "$DIR/proof.part" "$DIR/proof.json"
        rm -f "$DIR/compressed.bin"
        finish 0 "done"
    fi
    finish "$code" failed
}

mkdir -p "$JOBS"
command="${1:-}"; shift || true
case "$command" in
    check) cmd_check ;;
    prepare) cmd_prepare "$@" ;;
    start) cmd_start "$@" ;;
    status) cmd_status "$@" ;;
    cancel) cmd_cancel "$@" ;;
    run) cmd_run "$@" ;;
    *) die "команда «$command»: check, prepare, start, status, cancel" ;;
esac
