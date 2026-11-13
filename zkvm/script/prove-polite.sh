#!/bin/bash
# «Вежливый» запуск прувера на машине, где работает человек и другие задачи.
#
#   ./prove-polite.sh --batch 1 --prove
#
# Обёртка над prove-guarded.sh (сторож диска). Дополнительно:
#   • перед стартом ждёт затишья: нагрузка ниже CALM_LOAD и нет чужой тяжёлой работы;
#   • запускает прувер с низким приоритетом (nice), чтобы остальное оставалось отзывчивым;
#   • во время доказательства следит за чужой нагрузкой: если посторонние процессы держат
#     больше OTHER_CPU_LIMIT процентов CPU дольше минуты, прувер ставится на паузу (SIGSTOP)
#     и продолжает (SIGCONT), когда чужая работа закончилась. Уступить важнее, чем успеть:
#     обёртка Groth16 занимает больше памяти, чем есть на ноутбуке с 16 ГБ, и вместе с другой
#     тяжёлой работой уводит машину в подкачку. На паузе прувер не занимает процессор, а его
#     память система вытесняет на диск. Если пауза затянулась дольше MAX_PAUSE_MINUTES,
#     прувер останавливается совсем — неудачная попытка лучше зависшей машины.
#
# Коды выхода: 0 — пруф построен; 97 — остановлен из-за затянувшейся чужой нагрузки; 96 — не
# дождался затишья; остальные — от prove-guarded.sh (98, 99) и самого прувера.
set -u

CALM_LOAD="${CALM_LOAD:-4}"                 # нагрузка (1 мин), ниже которой можно стартовать
OTHER_CPU_LIMIT="${OTHER_CPU_LIMIT:-250}"   # суммарный CPU посторонних процессов, %
CALM_WAIT_MINUTES="${CALM_WAIT_MINUTES:-120}"
MAX_PAUSE_MINUTES="${MAX_PAUSE_MINUTES:-45}" # дольше — прувер останавливается совсем
export MIN_FREE_GB="${MIN_FREE_GB:-8}"      # порог сторожа диска (prove-guarded.sh)
HERE="$(cd "$(dirname "$0")" && pwd)"

# Суммарный CPU процессов, кроме прувера и мелочи (< 5%): то, что мешало бы пруверу и чему мешал бы он.
other_cpu() {
    ps -axo pcpu=,comm= | awk '$2 !~ /rollup-script|prove-guarded|prove-polite|kernel_task|WindowServer/ && $1 >= 5 { s += $1 } END { printf "%d", s }'
}
load_now() { sysctl -n vm.loadavg | awk '{ print $2 }'; }
is_calm() { awk -v l="$(load_now)" -v c="$CALM_LOAD" 'BEGIN { exit !(l < c) }' && [ "$(other_cpu)" -lt "$OTHER_CPU_LIMIT" ]; }

WAITED=0
until is_calm; do
    if [ "$WAITED" -ge $((CALM_WAIT_MINUTES * 60)) ]; then
        echo "[вежливо] не дождался затишья за ${CALM_WAIT_MINUTES} мин (нагрузка $(load_now), чужой CPU $(other_cpu)%) — не запускаю" >&2
        exit 96
    fi
    sleep 30
    WAITED=$((WAITED + 30))
done
echo "[вежливо] старт $(date +%T): нагрузка $(load_now), чужой CPU $(other_cpu)%, ждал ${WAITED} с"

nice -n 15 "$HERE/prove-guarded.sh" "$@" &
GUARD=$!

PROVER_PATTERN="target/release/rollup-script"
BUSY=0
QUIET=0
PAUSED=0
PAUSED_SECONDS=0
PAUSES=0
while kill -0 "$GUARD" 2>/dev/null; do
    sleep 20
    if [ "$(other_cpu)" -ge "$OTHER_CPU_LIMIT" ]; then
        BUSY=$((BUSY + 1)); QUIET=0
    else
        QUIET=$((QUIET + 1)); BUSY=0
    fi
    if [ "$PAUSED" -eq 0 ] && [ "$BUSY" -ge 3 ]; then
        echo "[вежливо] чужая нагрузка $(other_cpu)% держится дольше минуты — пауза $(date +%T)"
        pkill -STOP -f "$PROVER_PATTERN" 2>/dev/null
        PAUSED=1; PAUSES=$((PAUSES + 1))
    elif [ "$PAUSED" -eq 1 ] && [ "$QUIET" -ge 3 ]; then
        echo "[вежливо] чужая работа закончилась — продолжаю $(date +%T)"
        pkill -CONT -f "$PROVER_PATTERN" 2>/dev/null
        PAUSED=0
    fi
    if [ "$PAUSED" -eq 1 ]; then
        PAUSED_SECONDS=$((PAUSED_SECONDS + 20))
        if [ "$PAUSED_SECONDS" -ge $((MAX_PAUSE_MINUTES * 60)) ]; then
            echo "[вежливо] на паузе уже ${MAX_PAUSE_MINUTES} мин — останавливаю прувер $(date +%T)" >&2
            pkill -KILL -f "$PROVER_PATTERN" 2>/dev/null
            kill -KILL "$GUARD" 2>/dev/null
            wait "$GUARD" 2>/dev/null
            exit 97
        fi
    fi
done
[ "$PAUSES" -gt 0 ] && echo "[вежливо] пауз: $PAUSES, всего на паузе ${PAUSED_SECONDS} с"
wait "$GUARD"
STATUS=$?
echo "[вежливо] конец $(date +%T), код $STATUS"
exit "$STATUS"
