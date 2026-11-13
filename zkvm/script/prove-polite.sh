#!/bin/bash
# «Вежливый» запуск прувера на машине, где работает человек и другие задачи.
#
#   ./prove-polite.sh --batch 1 --prove
#
# Обёртка над prove-guarded.sh (сторож диска). Дополнительно:
#   • не даёт запустить два прувера сразу (каждый занимает около 30 ГБ памяти);
#   • перед стартом ждёт затишья: нагрузка ниже CALM_LOAD и нет чужой тяжёлой работы;
#   • запускает прувер с низким приоритетом (nice), чтобы остальное оставалось отзывчивым;
#   • во время доказательства следит за чужой нагрузкой: если посторонние процессы держат
#     больше OTHER_CPU_LIMIT процентов CPU дольше минуты, прувер ставится на паузу (SIGSTOP)
#     и продолжает (SIGCONT), когда чужая работа закончилась. Уступить важнее, чем успеть:
#     обёртка Groth16 занимает больше памяти, чем есть на ноутбуке с 16 ГБ, и вместе с другой
#     тяжёлой работой уводит машину в подкачку. На паузе прувер не занимает процессор, а его
#     память система вытесняет на диск. Если одна пауза затянулась дольше MAX_PAUSE_MINUTES
#     или весь запуск — дольше MAX_TOTAL_MINUTES, прувер останавливается совсем: неудачная
#     попытка лучше зависшей машины.
#
# Сигналы шлются только процессам СВОЕГО дерева (потомкам запущенного здесь сторожа), а не
# всем, у кого в командной строке встречается имя прувера. При любом завершении обёртки —
# в том числе по Ctrl-C, закрытию терминала или сигналу — прувер снимается с паузы и
# останавливается: остановленный процесс с 30 ГБ в подкачке не должен остаться висеть.
#
# Коды выхода: 0 — пруф построен; 97 — остановлен из-за затянувшейся чужой нагрузки; 96 — не
# дождался затишья; 95 — прувер уже запущен другой обёрткой; 94 — превышено общее время;
# остальные — от prove-guarded.sh (98, 99) и самого прувера.
set -u

CALM_LOAD="${CALM_LOAD:-4}"                  # нагрузка (1 мин), ниже которой можно стартовать
OTHER_CPU_LIMIT="${OTHER_CPU_LIMIT:-250}"    # суммарный CPU посторонних процессов, %
CALM_WAIT_MINUTES="${CALM_WAIT_MINUTES:-120}"
MAX_PAUSE_MINUTES="${MAX_PAUSE_MINUTES:-45}" # одна пауза дольше — прувер останавливается совсем
MAX_TOTAL_MINUTES="${MAX_TOTAL_MINUTES:-120}" # весь запуск дольше — тоже
export MIN_FREE_GB="${MIN_FREE_GB:-8}"       # порог сторожа диска (prove-guarded.sh)
HERE="$(cd "$(dirname "$0")" && pwd)"
LOCK="$HERE/target/.prove-polite.lock"
GUARD=""
FINISHED=0

# Все потомки процесса (рекурсивно).
descendants() {
    local child
    for child in $(pgrep -P "$1" 2>/dev/null); do
        echo "$child"
        descendants "$child"
    done
}
# Процессы прувера в СВОЁМ дереве: потомки сторожа, чей исполняемый файл — rollup-script.
prover_pids() {
    [ -n "$GUARD" ] || return 0
    local pid
    for pid in $(descendants "$GUARD"); do
        case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
            */rollup-script | rollup-script) echo "$pid" ;;
        esac
    done
}
signal_prover() {
    local pid
    for pid in $(prover_pids); do kill "-$1" "$pid" 2>/dev/null; done
}
stop_everything() {
    [ -n "$GUARD" ] || return 0
    signal_prover CONT
    local tree
    tree="$(descendants "$GUARD")"
    signal_prover KILL
    kill -KILL "$GUARD" $tree 2>/dev/null
    wait "$GUARD" 2>/dev/null
}
cleanup() {
    # При любом выходе: если прувер ещё жив — снять с паузы и остановить; снять блокировку.
    [ "$FINISHED" -eq 1 ] || stop_everything
    [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$LOCK"
}
trap cleanup EXIT
trap 'echo "[вежливо] прерван сигналом — останавливаю прувер" >&2; exit 130' INT TERM HUP

# Взаимное исключение: каталог создаётся атомарно. Блокировку мёртвого процесса забираем.
mkdir -p "$HERE/target"
if ! mkdir "$LOCK" 2>/dev/null; then
    OWNER="$(cat "$LOCK/pid" 2>/dev/null)"
    if [ -n "$OWNER" ] && kill -0 "$OWNER" 2>/dev/null; then
        echo "[вежливо] прувер уже запущен другой обёрткой (процесс $OWNER) — два сразу нельзя" >&2
        exit 95
    fi
    rm -rf "$LOCK"
    mkdir "$LOCK" || exit 95
fi
echo "$$" > "$LOCK/pid"

# Суммарный CPU посторонних процессов, кроме мелочи (< 5%): то, что мешало бы пруверу и чему
# мешал бы он. Свои процессы исключаются по номерам, а не по имени.
other_cpu() {
    local own=" $$ $GUARD $( [ -n "$GUARD" ] && descendants "$GUARD" | tr '\n' ' ') "
    ps -axo pid=,pcpu=,comm= | awk -v own="$own" '
        index(own, " " $1 " ") == 0 && $0 !~ /kernel_task|WindowServer/ && $2 >= 5 { s += $2 }
        END { printf "%d", s }'
}
load_now() { sysctl -n vm.loadavg | awk '{ print $2 }'; }
is_calm() { awk -v l="$(load_now)" -v c="$CALM_LOAD" 'BEGIN { exit !(l < c) }' && [ "$(other_cpu)" -lt "$OTHER_CPU_LIMIT" ]; }

# Прерываемая пауза: обычный `sleep` bash дожидается до конца и только потом исполняет
# обработчик сигнала, а `wait` прерывается сразу — прувер останавливается без задержки.
nap() { sleep "$1" & wait $!; }

WAITED=0
until is_calm; do
    if [ "$WAITED" -ge $((CALM_WAIT_MINUTES * 60)) ]; then
        echo "[вежливо] не дождался затишья за ${CALM_WAIT_MINUTES} мин (нагрузка $(load_now), чужой CPU $(other_cpu)%) — не запускаю" >&2
        FINISHED=1
        exit 96
    fi
    nap 30
    WAITED=$((WAITED + 30))
done
echo "[вежливо] старт $(date +%T): нагрузка $(load_now), чужой CPU $(other_cpu)%, ждал ${WAITED} с"

nice -n 15 "$HERE/prove-guarded.sh" "$@" &
GUARD=$!

BUSY=0
QUIET=0
PAUSED=0
PAUSED_SECONDS=0   # длительность текущей паузы
PAUSED_TOTAL=0
PAUSES=0
ELAPSED=0
while kill -0 "$GUARD" 2>/dev/null; do
    nap 20
    ELAPSED=$((ELAPSED + 20))
    if [ "$(other_cpu)" -ge "$OTHER_CPU_LIMIT" ]; then
        BUSY=$((BUSY + 1)); QUIET=0
    else
        QUIET=$((QUIET + 1)); BUSY=0
    fi
    if [ "$PAUSED" -eq 0 ] && [ "$BUSY" -ge 3 ]; then
        echo "[вежливо] чужая нагрузка $(other_cpu)% держится дольше минуты — пауза $(date +%T)"
        signal_prover STOP
        PAUSED=1; PAUSED_SECONDS=0; PAUSES=$((PAUSES + 1))
    elif [ "$PAUSED" -eq 1 ] && [ "$QUIET" -ge 3 ]; then
        echo "[вежливо] чужая работа закончилась — продолжаю $(date +%T)"
        signal_prover CONT
        PAUSED=0
    fi
    if [ "$PAUSED" -eq 1 ]; then
        PAUSED_SECONDS=$((PAUSED_SECONDS + 20)); PAUSED_TOTAL=$((PAUSED_TOTAL + 20))
        if [ "$PAUSED_SECONDS" -ge $((MAX_PAUSE_MINUTES * 60)) ]; then
            echo "[вежливо] на паузе уже ${MAX_PAUSE_MINUTES} мин — останавливаю прувер $(date +%T)" >&2
            exit 97
        fi
    fi
    if [ "$ELAPSED" -ge $((MAX_TOTAL_MINUTES * 60)) ]; then
        echo "[вежливо] запуск длится дольше ${MAX_TOTAL_MINUTES} мин — останавливаю прувер $(date +%T)" >&2
        exit 94
    fi
done
[ "$PAUSES" -gt 0 ] && echo "[вежливо] пауз: $PAUSES, всего на паузе ${PAUSED_TOTAL} с"
wait "$GUARD"
STATUS=$?
FINISHED=1
echo "[вежливо] конец $(date +%T), код $STATUS"
exit "$STATUS"
