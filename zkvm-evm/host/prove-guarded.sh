#!/bin/bash
# Работа прувера для хоста батча EVM — под сторожем диска, памяти и времени.
#
#   zkvm-evm/host/prove-guarded.sh --block-input … --chain-id … --witness … --compressed
#
# Запускать только по отдельной команде и по одному. На машине с 16 ГБ память прувера уходит в
# подкачку, а она растёт на том же диске: сторож останавливает прувер, если свободного места
# меньше MIN_FREE_GB (по умолчанию 8), если запуск длится дольше MAX_TOTAL_MINUTES (по умолчанию
# 60) или если уже работает другой прувер. Неудачная попытка лучше зависшей машины.
# Коды: 0 — готово; 95 — другой прувер уже работает; 98 — мало места для старта; 99 — место
# кончилось; 94 — вышло время; остальные — от самого хоста.
set -u

MIN_FREE_GB="${MIN_FREE_GB:-8}"
MIN_START_FREE_GB="${MIN_START_FREE_GB:-16}"
MAX_TOTAL_MINUTES="${MAX_TOTAL_MINUTES:-60}"
BINARY="$(cd "$(dirname "$0")/.." && pwd)/target/release/rollup-evm-host"
VOLUME="/System/Volumes/Data"
[ -d "$VOLUME" ] || VOLUME="/"

[ -x "$BINARY" ] || { echo "Нет $BINARY — сначала cargo build --release --locked -p rollup-evm-host" >&2; exit 1; }
if pgrep -f 'release/rollup-script|release/rollup-evm-host' >/dev/null; then
    echo "[сторож] прувер уже работает — второй не запускаю" >&2; exit 95
fi
free_gb() { df -g "$VOLUME" | awk 'NR == 2 { print $4 }'; }
swap_mb() { sysctl -n vm.swapusage | awk '{ gsub("M", "", $6); printf "%d", $6 }'; }
case "$(free_gb)" in ''|*[!0-9]*) echo "[сторож] не удалось узнать свободное место" >&2; exit 98 ;; esac
if [ "$(free_gb)" -lt "$MIN_START_FREE_GB" ]; then
    echo "[сторож] свободно $(free_gb) ГБ, для старта нужно ${MIN_START_FREE_GB} ГБ" >&2; exit 98
fi

PROVER=""
stop() {
    [ -n "$PROVER" ] || return 0
    pkill -KILL -P "$PROVER" 2>/dev/null
    kill -KILL "$PROVER" 2>/dev/null
    wait "$PROVER" 2>/dev/null
}
# Обработчик ставится ДО запуска: сигнал сторожу не должен оставить прувер без присмотра.
trap 'stop; exit 130' INT TERM HUP QUIT

echo "[сторож] старт $(date +%T), свободно $(free_gb) ГБ, подкачка $(swap_mb) МБ, порог ${MIN_FREE_GB} ГБ, предел ${MAX_TOTAL_MINUTES} мин"
SP1_PROVER=cpu /usr/bin/time -l nice -n 15 "$BINARY" "$@" &
PROVER=$!
STARTED=$(date +%s)
LOWEST=$(free_gb); PEAK_SWAP=$(swap_mb)

while kill -0 "$PROVER" 2>/dev/null; do
    NOW=$(free_gb); SWAP=$(swap_mb)
    # Без показаний сторож слеп: лучше остановить прувер, чем оставить его без присмотра.
    case "$NOW$SWAP" in ''|*[!0-9]*) echo "[сторож] не удалось узнать свободное место или подкачку — останавливаю прувер" >&2; stop; exit 99 ;; esac
    [ "$NOW" -lt "$LOWEST" ] && LOWEST=$NOW
    [ "$SWAP" -gt "$PEAK_SWAP" ] && PEAK_SWAP=$SWAP
    if [ "$NOW" -lt "$MIN_FREE_GB" ]; then
        echo "[сторож] свободно ${NOW} ГБ — меньше порога, останавливаю прувер" >&2; stop; exit 99
    fi
    if [ $(( $(date +%s) - STARTED )) -gt $(( MAX_TOTAL_MINUTES * 60 )) ]; then
        echo "[сторож] прошло больше ${MAX_TOTAL_MINUTES} мин — останавливаю прувер" >&2; stop; exit 94
    fi
    sleep 5
done
wait "$PROVER"; STATUS=$?
echo "[сторож] конец $(date +%T), код $STATUS, длилось $(( $(date +%s) - STARTED )) с, минимум свободного места ${LOWEST} ГБ, пик подкачки ${PEAK_SWAP} МБ"
exit $STATUS
