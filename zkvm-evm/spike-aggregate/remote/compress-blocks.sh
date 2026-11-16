#!/usr/bin/env bash
# НА СЕРВЕРЕ: сжатые пруфы блоков цепочки Reth уже существующим хостом EVM (--prove-compressed),
# общая очередь на две карты (как ~/allblocks/two.sh). Замер: время каждого блока, пик RSS
# (/usr/bin/time -v), видеопамять обеих карт раз в секунду (nvidia-smi).
#
#   bash compress-blocks.sh <блоки через пробел>      # например: 1 2 3 4 5 6 7 8
#
# Вход блока N: ~/allblocks/in/block-N.bin, для блока 3 — fixtures/evm_batches/reth/block-3.bin.
# Итог: ~/spike-aggregate/out/compressed/{block-N.bin,log-N.txt,time-N.txt}, summary.tsv, gpu.csv.
set -euo pipefail
. ~/ton-zk-rollup/remote-out/env.sh
ROOT=~/ton-zk-rollup
OUT=~/spike-aggregate/out/compressed
mkdir -p "$OUT"
cd "$ROOT"
QUEUE="$OUT/queue.txt"
printf "%s\n" "$@" > "$QUEUE"
: > "$OUT/queue.lock"
input_of() {
    if [ -f ~/allblocks/in/block-"$1".bin ]; then echo ~/allblocks/in/block-"$1".bin
    else echo "$ROOT/fixtures/evm_batches/reth/block-$1.bin"; fi
}
nvidia-smi --query-gpu=timestamp,index,memory.used,utilization.gpu --format=csv,noheader -l 1 >> "$OUT/gpu.csv" &
SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null || true' EXIT
worker() {
    local gpu=$1 n s code
    while true; do
        n=$(flock "$OUT/queue.lock" sh -c "head -1 '$QUEUE'; sed -i 1d '$QUEUE'")
        [ -z "$n" ] && break
        # Сбой старта сервера GPU («Could not connect to sp1-gpu-server socket» сразу после
        # удаления сокета убитого сервера) — повтор, не более двух раз; в итог идёт последняя попытка.
        for attempt in 1 2 3; do
            s=$(date +%s)
            code=0
            SP1_CUDA_DEVICE=$gpu SP1_PROVER=cuda /usr/bin/time -v -o "$OUT/time-$n.txt" \
                zkvm-evm/target/release/rollup-evm-host --elf remote-input/rollup-evm-program.elf \
                --batch-input "$(input_of "$n")" --prove-compressed --proof-out "$OUT/block-$n.bin" \
                > "$OUT/log-$n.txt" 2>&1 || code=$?
            if [ "$code" = 0 ] || ! grep -q "Could not connect to .sp1-gpu-server. socket" "$OUT/log-$n.txt"; then break; fi
            cp "$OUT/log-$n.txt" "$OUT/log-$n.failed-$attempt.txt"
            sleep 5
        done
        rss=$(awk -F': ' '/Maximum resident/ { print $2 }' "$OUT/time-$n.txt")
        printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$n" "$gpu" "$code" "$(( $(date +%s) - s ))" "$rss" "$s" >> "$OUT/summary.tsv"
    done
}
start=$(date +%s)
[ -f "$OUT/summary.tsv" ] || printf "block\tgpu\texit\tseconds\tmaxRssKiB\tstartUnix\n" > "$OUT/summary.tsv"
# Ждать только рабочих: голый `wait` ждал бы и nvidia-smi -l (так первый прогон завис).
worker 0 & W0=$!
worker 1 & W1=$!
wait "$W0" "$W1"
echo "ГОТОВО: $# блоков за $(( $(date +%s) - start )) с (две карты)" | tee "$OUT/done.txt"
