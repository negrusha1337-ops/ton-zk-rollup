#!/usr/bin/env bash
# Проверка на маке пруфа, построенного на сервере. Ничего тяжёлого: импорт, подсказки и один
# набор jest на настоящем контракте в Sandbox.
#
#   zkvm-evm/host/remote/verify-local.sh <каталог из pull.sh> [номер блока, 3] [метка, gpu]
#
#   1. zk/import-sp1-fixture.mjs: ключ программы и хеш ELF пруфа — из program.json, публичные
#      значения — ровно те, что в fixtures/evm_batches/reth/block-<N>.json, нонс ноль, сам пруф —
#      проверка спариванием под закреплённым ключом схемы. Пишет fixtures/sp1_evm_reth<N>_<метка>
#      (не трогая fixtures/sp1_evm_reth<N>; такие каталоги git игнорирует).
#   2. zk/gen-bn254-groth16-fixture.mjs: подсказки для контракта и «лучшая подделка».
#   3. tests/RollupEvmRemoteProof.spec.ts: батчи 1…N−1 по основным пруфам, батч N — по этому;
#      подделка отклоняется кодом 7300.
set -euo pipefail

SOURCE="${1:-}"
BLOCK="${2:-3}"
LABEL="${3:-gpu}"
REPOSITORY="$(cd "$(dirname "$0")/../../.." && pwd -P)"
CIRCUITS="$HOME/.sp1/circuits/groth16/v6.1.0"

die() { echo "[verify] ОШИБКА: $*" >&2; exit 1; }
[ -n "$SOURCE" ] && [ -f "$SOURCE/proof.json" ] || die "использование: verify-local.sh <каталог с proof.json> [блок] [метка]"
case "$BLOCK" in ''|*[!0-9]*) die "номер блока «$BLOCK» — не число" ;; esac
[[ "$LABEL" =~ ^[a-z0-9]+$ ]] || die "метка «$LABEL»: строчные латинские буквы и цифры"
for file in Groth16Verifier.sol SP1VerifierGroth16.sol; do
    [ -f "$CIRCUITS/$file" ] || die "нет $CIRCUITS/$file (артефакты схемы, PROVING.md → «Ресурсы»)"
done
SOURCE="$(cd "$SOURCE" && pwd -P)"
NAME="sp1_evm_reth${BLOCK}_${LABEL}"
cd "$REPOSITORY"

if [ -f "$SOURCE/measure.json" ]; then
    python3 -I -c '
import json, sys
measure = json.load(open(sys.argv[1]))
print("[verify] замер:", measure["run"], "путь", measure["pathUsed"])
for name, proof in measure["proofs"].items():
    print("[verify]  ", name, proof)' "$SOURCE/measure.json"
fi

node zk/import-sp1-fixture.mjs "$CIRCUITS/Groth16Verifier.sol" "$CIRCUITS/SP1VerifierGroth16.sol" "$SOURCE/proof.json" "$NAME"
node zk/gen-bn254-groth16-fixture.mjs "$NAME"
REMOTE_PROOF_FIXTURE="$NAME" nice -n 15 npx jest tests/RollupEvmRemoteProof.spec.ts --runInBand
echo "[verify] пруф из $SOURCE принят настоящим контрактом в Sandbox: fixtures/$NAME"
