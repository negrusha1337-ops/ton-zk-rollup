#!/usr/bin/env bash
# Замер пруфа блока EVM на сервере с NVIDIA. Запускать НА СЕРВЕРЕ после setup.sh:
#
#   bash ~/ton-zk-rollup/zkvm-evm/host/remote/measure.sh [auto|onestep|twostep|both] [номер блока]
#
#   onestep — пруф Groth16 целиком на GPU (SP1_PROVER=cuda, --prove): сжатие, shrink/wrap и
#             gnark делает sp1-gpu-server;
#   twostep — сжатый пруф на GPU (--prove-compressed), обёртка Groth16 на процессоре
#             (--wrap-groth16): для карт, которым не хватит видеопамяти на обёртку;
#   auto    — (по умолчанию) onestep, а если он не удался — twostep;
#   both    — оба пути подряд (сравнить обёртку на GPU и на процессоре).
#
# Перед пруфом — сверка ELF: sha256 файла и ключ, который SDK выводит из него, обязаны совпасть
# с fixtures/evm_batches/program.json (это делает сам хост, --elf), и исполнение блока в zkVM
# без пруфа: публичные значения — те, что в block-<N>.json с мака.
#
# Каждый этап — отдельный запуск хоста под /usr/bin/time -v, рядом раз в секунду пишется
# видеопамять (nvidia-smi), занятая ОЗУ и свободное место. Сторож: место < MIN_FREE_GB или этап
# дольше MAX_STAGE_MINUTES — этап останавливается целиком (группа процессов).
# Итог — remote-out/proof.json (пруф для импортёра) и remote-out/measure.json; журналы этапов —
# remote-out/stages/<этап>/.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
OUT="$ROOT/remote-out"
MODE="${1:-auto}"
BLOCK="${2:-3}"
MIN_FREE_GB="${MIN_FREE_GB:-15}"
MAX_STAGE_MINUTES="${MAX_STAGE_MINUTES:-120}"
HOST="$ROOT/zkvm-evm/target/release/rollup-evm-host"
ELF="$ROOT/remote-input/rollup-evm-program.elf"
INPUT="$ROOT/fixtures/evm_batches/reth/block-$BLOCK.bin"
REPORT="$ROOT/fixtures/evm_batches/reth/block-$BLOCK.json"
cd "$ROOT" || exit 1

say() { echo "[замер] $*"; }
die() { echo "[замер] ОШИБКА: $*" >&2; exit 1; }

case "$MODE" in auto|onestep|twostep|both) ;; *) die "режим «$MODE»: auto, onestep, twostep или both" ;; esac
case "$BLOCK" in ''|*[!0-9]*) die "номер блока «$BLOCK» — не число" ;; esac
[ -f "$OUT/env.sh" ] && [ -x "$HOST" ] || die "сначала setup.sh (нет remote-out/env.sh или хоста)"
[ -f "$INPUT" ] && [ -f "$REPORT" ] || die "нет входа блока $BLOCK: $INPUT и $REPORT (push.sh везёт блок 3)"
# shellcheck source=/dev/null
. "$OUT/env.sh"
sha256sum --quiet -c remote-input/MANIFEST.sha256 || die "файлы набора не совпали с MANIFEST.sha256"
if pgrep -f 'release/rollup-evm-host|sp1-gpu-server' >/dev/null; then
    die "уже работает хост или sp1-gpu-server — второй замер не запускаю"
fi

# ELF: sha256 с program.json — здесь, ключ — в самом хосте (--elf) на каждом этапе.
EXPECTED_ELF="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["programElfSha256"])' fixtures/evm_batches/program.json)"
[ "$(sha256sum "$ELF" | awk '{ print $1 }')" = "$EXPECTED_ELF" ] || die "ELF $ELF не совпал с program.json"
say "ELF совпал с program.json: $EXPECTED_ELF"

RUN="$(date -u +%Y%m%dT%H%M%SZ)"
rm -rf "$OUT/stages" "$OUT/proof.json" "$OUT/proof-twostep.json" "$OUT/compressed.bin" "$OUT/measure.json"
mkdir -p "$OUT/stages"

free_gb() { df -BG --output=avail "$ROOT" | tail -1 | tr -dc 0-9; }

# Раз в секунду: время, видеопамять (МиБ, сумма по картам), загрузка GPU (%), занятая ОЗУ (МиБ),
# свободное место (ГБ). Сторож места — здесь же.
sample() {
    local group="$1" file="$2"
    echo "t,gpuMemMiB,gpuUtil,ramUsedMiB,diskFreeGB" > "$file"
    while kill -0 "$group" 2>/dev/null; do
        local gpu ram disk
        gpu="$(nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null \
            | awk -F', *' '{ memory += $1; if ($2 > util) util = $2 } END { printf "%d,%d", memory, util }')"
        ram="$(awk '/MemTotal/ { total = $2 } /MemAvailable/ { free = $2 } END { printf "%d", (total - free) / 1024 }' /proc/meminfo)"
        disk="$(free_gb)"
        echo "$(date +%s),${gpu:-0,0},$ram,$disk" >> "$file"
        if [ -n "$disk" ] && [ "$disk" -lt "$MIN_FREE_GB" ]; then
            echo "[сторож] свободно $disk ГБ — меньше $MIN_FREE_GB, останавливаю этап" >&2
            kill -KILL -- "-$group" 2>/dev/null
        fi
        sleep 1
    done
}

# stage <имя> <прувер> <аргументы хоста…>: запуск, замер, сводка в stages/<имя>/stage.json.
stage() {
    local name="$1" prover="$2"; shift 2
    local dir="$OUT/stages/$name"
    mkdir -p "$dir"
    say "этап $name (прувер $prover): старт $(date -u +%T), журнал stages/$name/log.txt"
    local started; started="$(date +%s)"
    SP1_PROVER="$prover" RUST_LOG="${RUST_LOG:-info}" setsid timeout --signal=KILL "${MAX_STAGE_MINUTES}m" \
        /usr/bin/time -v -o "$dir/time.txt" "$HOST" "$@" > "$dir/log.txt" 2>&1 &
    local group=$!
    sample "$group" "$dir/samples.csv" &
    local sampler=$!
    wait "$group"; local status=$?
    kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
    # Сервер GPU живёт, пока жив хост; если что-то осталось — освободить карту до следующего этапа.
    pkill -KILL -f sp1-gpu-server 2>/dev/null
    local seconds=$(( $(date +%s) - started ))
    python3 -I - "$dir" "$name" "$prover" "$status" "$seconds" <<'PY'
import csv, json, re, sys
directory, name, prover, status, seconds = sys.argv[1:]
rows = list(csv.DictReader(open(f"{directory}/samples.csv")))
peak = lambda key: max((int(row[key]) for row in rows if row[key].isdigit()), default=None)
low = lambda key: min((int(row[key]) for row in rows if row[key].isdigit()), default=None)
try:
    timing = open(f"{directory}/time.txt").read()
    match = re.search(r"Maximum resident set size \(kbytes\): (\d+)", timing)
    max_rss_mib = int(match.group(1)) // 1024 if match else None
except FileNotFoundError:
    max_rss_mib = None
log = open(f"{directory}/log.txt", errors="replace").read()
json.dump({
    "stage": name,
    "prover": prover,
    "exitCode": int(status),
    "seconds": int(seconds),
    "peakGpuMemMiB": peak("gpuMemMiB"),
    "peakGpuUtil": peak("gpuUtil"),
    "peakRamUsedMiB": peak("ramUsedMiB"),
    "maxRssMiB": max_rss_mib,
    "minDiskFreeGB": low("diskFreeGB"),
    # Строки хоста «[этап] …» и «Ключ программы …»: время внутренних шагов.
    "hostLines": [line for line in log.splitlines() if line.startswith(("[этап]", "Ключ программы", "ELF из файла"))],
    "tail": log.splitlines()[-15:] if int(status) != 0 else [],
}, open(f"{directory}/stage.json", "w"), ensure_ascii=False, indent=2)
PY
    say "этап $name: код $status, $seconds с"
    return "$status"
}

ELF_ARGS=(--elf "$ELF" --batch-input "$INPUT")

# 0. Сверка ELF хостом (sha256 и ключ) и исполнение без пруфа: циклы и публичные значения.
stage execute cpu "${ELF_ARGS[@]}" --execute --report "$OUT/stages/execute-report.json" || die "сверка ELF или исполнение не прошли"
python3 -I -c '
import json, sys
mine, mac = (json.load(open(path)) for path in sys.argv[1:3])
if mine["publicValuesBytes"] != mac["publicValuesBytes"]:
    sys.exit("публичные значения исполнения не те, что в отчёте блока с мака")
print("[замер] публичные значения совпали с отчётом блока; циклов", mine["zkvmCycles"])' "$OUT/stages/execute-report.json" "$REPORT" || die "исполнение разошлось с маком"

onestep() {
    stage groth16-gpu cuda "${ELF_ARGS[@]}" --prove --proof-out "$1" --report "$OUT/stages/groth16-gpu-report.json"
}
twostep() {
    stage compressed-gpu cuda "${ELF_ARGS[@]}" --prove-compressed --proof-out "$OUT/compressed.bin" \
        --report "$OUT/stages/compressed-gpu-report.json" || return 1
    stage wrap-cpu cpu "${ELF_ARGS[@]}" --wrap-groth16 "$OUT/compressed.bin" --proof-out "$1" \
        --report "$OUT/stages/wrap-cpu-report.json"
}

PATH_USED=""
case "$MODE" in
    onestep) onestep "$OUT/proof.json" && PATH_USED=onestep ;;
    twostep) twostep "$OUT/proof.json" && PATH_USED=twostep ;;
    auto)
        if onestep "$OUT/proof.json"; then PATH_USED=onestep
        else
            say "пруф целиком на GPU не построился (stages/groth16-gpu/log.txt) — перехожу к двум шагам"
            twostep "$OUT/proof.json" && PATH_USED=twostep
        fi ;;
    both)
        onestep "$OUT/proof.json" && PATH_USED=onestep
        if twostep "$OUT/proof-twostep.json"; then
            [ -n "$PATH_USED" ] || { mv "$OUT/proof-twostep.json" "$OUT/proof.json"; PATH_USED=twostep; }
        fi ;;
esac

python3 -I - "$OUT" "$RUN" "$MODE" "$PATH_USED" "$BLOCK" <<'PY'
import glob, hashlib, json, os, sys
out, run, mode, used, block = sys.argv[1:]
program = json.load(open("fixtures/evm_batches/program.json"))
report = json.load(open(f"fixtures/evm_batches/reth/block-{block}.json"))
stages = [json.load(open(path)) for path in sorted(glob.glob(f"{out}/stages/*/stage.json"), key=os.path.getmtime)]
proofs = {}
for name in ("proof.json", "proof-twostep.json"):
    path = f"{out}/{name}"
    if not os.path.exists(path):
        continue
    proof = json.load(open(path))
    proofs[name] = {
        "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
        "vkeyMatchesProgramJson": proof["vkey"] == program["programVKey"],
        "elfMatchesProgramJson": proof["elfSha256"] == program["programElfSha256"],
        "publicValuesMatchBlockReport": proof["publicValues"].removeprefix("0x") == report["publicValuesBytes"].removeprefix("0x"),
        "proofBytes": (len(proof["proof"]) - 2) // 2,
    }
setup = json.load(open(f"{out}/setup.json")) if os.path.exists(f"{out}/setup.json") else None
json.dump({
    "run": run,
    "block": int(block),
    "mode": mode,
    "pathUsed": used or None,
    "zkvmCyclesOnMac": report.get("zkvmCycles"),
    "programVKey": program["programVKey"],
    "programElfSha256": program["programElfSha256"],
    "setup": setup,
    "stages": stages,
    "proofs": proofs,
}, open(f"{out}/measure.json", "w"), ensure_ascii=False, indent=2)
print(json.dumps({"pathUsed": used or None, "stages": [(s["stage"], s["exitCode"], s["seconds"], s["peakGpuMemMiB"], s["peakRamUsedMiB"]) for s in stages], "proofs": proofs}, ensure_ascii=False, indent=1))
PY
[ -n "$PATH_USED" ] || die "пруф не построен: смотрите remote-out/stages/*/log.txt; measure.json записан"
# Сжатый пруф нужен только второму шагу; при неудаче обёртки он остаётся для повтора.
rm -f "$OUT/compressed.bin"
say "готово: remote-out/proof.json и remote-out/measure.json. На маке — pull.sh"
