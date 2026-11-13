#!/bin/bash
# Запуск прувера под сторожем диска — для машин, где памяти впритык.
#
#   ./prove-guarded.sh --batch 1 --prove
#
# Обёртка Groth16 занимает больше памяти, чем есть на ноутбуке, и система уходит в
# подкачку, которая растёт на том же диске. Если свободного места остаётся меньше
# порога, сторож убивает прувер: неудачная попытка лучше зависшей машины.
#
# MIN_FREE_GB — порог в гигабайтах (по умолчанию 4).
# MIN_START_FREE_GB — сколько должно быть свободно перед стартом (по умолчанию 16): после
# предыдущего пруфа система возвращает место из-под подкачки не сразу, и запуск «впритык»
# сторож убил бы на первой же проверке. Ждём до START_WAIT_MINUTES минут (по умолчанию 20).
set -u

MIN_FREE_GB="${MIN_FREE_GB:-4}"
MIN_START_FREE_GB="${MIN_START_FREE_GB:-16}"
START_WAIT_MINUTES="${START_WAIT_MINUTES:-20}"
BINARY="$(dirname "$0")/target/release/rollup-script"
VOLUME="/System/Volumes/Data"
[ -d "$VOLUME" ] || VOLUME="/"

if [ ! -x "$BINARY" ]; then
    echo "Нет $BINARY — сначала cargo build --release" >&2
    exit 1
fi

free_gb() { df -g "$VOLUME" | awk 'NR == 2 { print $4 }'; }

WAITED=0
while [ "$(free_gb)" -lt "$MIN_START_FREE_GB" ]; do
    if [ "$WAITED" -ge $((START_WAIT_MINUTES * 60)) ]; then
        echo "[сторож] свободно $(free_gb) ГБ, для старта нужно ${MIN_START_FREE_GB} ГБ — не дождался, не запускаю" >&2
        exit 98
    fi
    sleep 15
    WAITED=$((WAITED + 15))
done
[ "$WAITED" -gt 0 ] && echo "[сторож] ждал свободное место ${WAITED} с"

echo "[сторож] старт $(date +%T), свободно $(free_gb) ГБ, порог ${MIN_FREE_GB} ГБ"
/usr/bin/time -l "$BINARY" "$@" &
PROVER=$!

LOWEST=$(free_gb)
while kill -0 "$PROVER" 2>/dev/null; do
    NOW=$(free_gb)
    [ "$NOW" -lt "$LOWEST" ] && LOWEST=$NOW
    if [ "$NOW" -lt "$MIN_FREE_GB" ]; then
        echo "[сторож] свободно ${NOW} ГБ — меньше порога, останавливаю прувер" >&2
        pkill -KILL -P "$PROVER" 2>/dev/null
        kill -KILL "$PROVER" 2>/dev/null
        wait "$PROVER" 2>/dev/null
        exit 99
    fi
    sleep 5
done

wait "$PROVER"
STATUS=$?
echo "[сторож] конец $(date +%T), код $STATUS, минимум свободного места ${LOWEST} ГБ"
exit "$STATUS"
