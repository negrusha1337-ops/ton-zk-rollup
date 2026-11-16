#!/usr/bin/env bash
# НА СЕРВЕРЕ: сборка хоста спайка с GPU (те же переменные, что у хоста EVM: remote-out/env.sh).
# Гость-агрегатор здесь НЕ собирается: его ELF везут с мака (elf/spike-aggregate-program.elf).
set -euo pipefail
. ~/ton-zk-rollup/remote-out/env.sh
cd ~/spike-aggregate
start=$(date +%s)
cargo build --release -p spike-aggregate-host --features "native-gnark cuda"
echo "хост спайка собран за $(( $(date +%s) - start )) с" | tee out/host-build.txt
