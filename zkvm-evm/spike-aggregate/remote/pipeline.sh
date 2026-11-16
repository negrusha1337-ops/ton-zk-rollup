#!/usr/bin/env bash
# НА СЕРВЕРЕ: «тёплый» конвейер на двух картах. Карта 0 — сжатые пруфы блоков 1–4, карта 1 —
# блоков 5–8, каждая в одном процессе хоста спайка (сервер GPU и ключ программы подняты один
# раз); затем агрегат N = 8 на карте 0 с двумя Groth16 подряд (второй — тёплый).
# Итог — out/pipe/{lane0,lane1,agg}/ и out/pipe/wall.txt (стенное время частей).
set -euo pipefail
. ~/ton-zk-rollup/remote-out/env.sh
HOST=~/spike-aggregate/target/release/spike-aggregate-host
OUT=~/spike-aggregate/out/pipe
COMMON=(--evm-elf ~/ton-zk-rollup/remote-input/rollup-evm-program.elf
    --agg-elf ~/spike-aggregate/elf/spike-aggregate-program.elf
    --program-json ~/ton-zk-rollup/fixtures/evm_batches/program.json)
input_of() {
    if [ -f ~/allblocks/in/block-"$1".bin ]; then echo ~/allblocks/in/block-"$1".bin
    else echo ~/ton-zk-rollup/fixtures/evm_batches/reth/block-"$1".bin; fi
}
mkdir -p "$OUT"/lane0 "$OUT"/lane1 "$OUT"/agg
nvidia-smi --query-gpu=timestamp,index,memory.used,utilization.gpu --format=csv,noheader -l 1 > "$OUT/gpu.csv" &
SAMPLER=$!
trap 'kill $SAMPLER 2>/dev/null || true' EXIT
# Повтор при сбое старта сервера GPU — как в aggregate.sh.
run() {
    local gpu=$1 dir=$2 attempt code
    shift 2
    for attempt in 1 2 3; do
        code=0
        SP1_CUDA_DEVICE=$gpu SP1_PROVER=cuda /usr/bin/time -v -o "$dir/time.txt" "$HOST" "${COMMON[@]}" "$@" \
            --out-dir "$dir" > "$dir/log.txt" 2>&1 || code=$?
        if [ "$code" = 0 ] || ! grep -q "Could not connect to .sp1-gpu-server. socket\|Broken pipe" "$dir/log.txt"; then break; fi
        cp "$dir/log.txt" "$dir/log.failed-$attempt.txt"
        sleep 5
    done
    return "$code"
}
lane() {
    local gpu=$1 args=() n
    shift
    for n in "$@"; do args+=(--block-input "$(input_of "$n")"); done
    run "$gpu" "$OUT/lane$gpu" "${args[@]}" --blocks-only
}
start=$(date +%s)
lane 0 1 2 3 4 & A=$!
lane 1 5 6 7 8 & B=$!
wait $A; wait $B
blocks_done=$(date +%s)
proofs=()
for lane in 0 1; do for k in 1 2 3 4; do proofs+=(--proof "$OUT/lane$lane/block-$k.bin"); done; done
GROTH16_REPEAT=2 run 0 "$OUT/agg" "${proofs[@]}"
end=$(date +%s)
printf "blocksWallSeconds=%s\naggregateWallSeconds=%s\ntotalWallSeconds=%s\n" \
    "$(( blocks_done - start ))" "$(( end - blocks_done ))" "$(( end - start ))" | tee "$OUT/wall.txt"
