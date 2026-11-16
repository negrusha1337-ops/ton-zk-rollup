#!/usr/bin/env bash
# НА СЕРВЕРЕ: агрегатный пруф N подряд идущих блоков на одной карте.
#
#   bash aggregate.sh <карта> <имя> <блоки по порядку…> [-- флаги хоста]
#
# Сжатые пруфы блоков — из out/compressed (compress-blocks.sh). Итог — out/agg-<имя>/:
# result.json хоста (время этапов, циклы), time.txt (/usr/bin/time -v), gpu.csv, log.txt.
set -euo pipefail
. ~/ton-zk-rollup/remote-out/env.sh
gpu=$1 name=$2
shift 2
proofs=() extra=()
while [ $# -gt 0 ]; do
    if [ "$1" = "--" ]; then shift; extra=("$@"); break; fi
    proofs+=(--proof ~/spike-aggregate/out/compressed/block-"$1".bin)
    shift
done
OUT=~/spike-aggregate/out/agg-$name
mkdir -p "$OUT"
nvidia-smi -i "$gpu" --query-gpu=timestamp,index,memory.used,utilization.gpu --format=csv,noheader -l 1 > "$OUT/gpu.csv" &
SAMPLER=$!
# Занятая ОЗУ всей машины (МиБ) раз в секунду: сервер GPU — отдельный процесс, RSS хоста его не видит.
( while true; do free -m | awk '/^Mem:/ { print $3 }'; sleep 1; done ) > "$OUT/ram.txt" &
RAM=$!
trap 'kill $SAMPLER $RAM 2>/dev/null || true' EXIT
# Сбой старта сервера GPU (сокет ещё не создан либо прежний сервер ещё умирает: «Could not
# connect…», «Broken pipe») — повтор, не более двух раз; в итог идёт последняя попытка.
for attempt in 1 2 3; do
    start=$(date +%s)
    code=0
    SP1_CUDA_DEVICE=$gpu SP1_PROVER=cuda /usr/bin/time -v -o "$OUT/time.txt" \
        ~/spike-aggregate/target/release/spike-aggregate-host \
        --evm-elf ~/ton-zk-rollup/remote-input/rollup-evm-program.elf \
        --agg-elf ~/spike-aggregate/elf/spike-aggregate-program.elf \
        --program-json ~/ton-zk-rollup/fixtures/evm_batches/program.json \
        "${proofs[@]}" --out-dir "$OUT" "${extra[@]}" > "$OUT/log.txt" 2>&1 || code=$?
    if [ "$code" = 0 ] || ! grep -q "Could not connect to .sp1-gpu-server. socket\|Broken pipe" "$OUT/log.txt"; then break; fi
    cp "$OUT/log.txt" "$OUT/log.failed-$attempt.txt"
    sleep 5
done
echo "агрегат $name: код $code за $(( $(date +%s) - start )) с (карта $gpu)" | tee -a ~/spike-aggregate/out/aggregate-summary.txt
exit "$code"
