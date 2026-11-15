#!/usr/bin/env bash
# Подготовка арендованного Linux-сервера с NVIDIA к замеру пруфа блока EVM. Запускать НА
# СЕРВЕРЕ из каталога, куда push.sh выложил набор (по умолчанию ~/ton-zk-rollup):
#
#   bash ~/ton-zk-rollup/zkvm-evm/host/remote/setup.sh
#
# Идемпотентен: каждый шаг сначала смотрит, сделан ли он, и повторный запуск только доделывает.
# Секретов не нужно и не берётся: репозиторий сюда не клонируется, токены не передаются.
# Что делает (README.md рядом):
#   1. сверяет выложенные файлы с MANIFEST.sha256 и ресурсы машины (GPU, CUDA, ОЗУ, диск);
#   2. ставит пакеты (apt), Rust из rust-toolchain.toml, SP1 той же версии, что в Cargo.lock,
#      Go для native-gnark (версия — как на маке);
#   3. заранее кладёт sp1-gpu-server и артефакты схемы Groth16 (SDK скачал бы их сам посреди
#      замера) и записывает их sha256;
#   4. собирает хост с --features "native-gnark cuda". Хост при сборке собирает и гостевую
#      программу — это правило build.rs (SP1_SKIP_PROGRAM_BUILD запрещён), но в пруф идёт НЕ
#      она, а ELF с мака (--elf, сверка с program.json). Совпадёт ли здешняя сборка ELF с
#      маком — записывается как справка.
# Итог — remote-out/setup.json и remote-out/env.sh (окружение для measure.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd -P)"
OUT="$ROOT/remote-out"
GO_VERSION="1.27.4"          # как .tools/go на маке (go version)
CIRCUIT_VERSION="v6.1.0"     # схема SDK 6.10.0 (PROVING.md, zk/sp1-pins.json)
MIN_FREE_GB="${MIN_FREE_GB:-60}"
MIN_RAM_GB="${MIN_RAM_GB:-60}"
mkdir -p "$OUT"
cd "$ROOT"

say() { echo "[setup] $*"; }
die() { echo "[setup] ОШИБКА: $*" >&2; exit 1; }
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || die "нужен Linux x86_64 (sp1-gpu-server выпускается только под него), здесь $(uname -sm)"
if [ -n "${SP1_SKIP_PROGRAM_BUILD:-}" ] || [ -n "${RUSTC_WORKSPACE_WRAPPER:-}" ]; then
    die "задана SP1_SKIP_PROGRAM_BUILD или RUSTC_WORKSPACE_WRAPPER: уберите (правило build.rs)"
fi

# --- 1. набор и машина ---------------------------------------------------------------------
[ -f remote-input/MANIFEST.sha256 ] || die "нет remote-input/MANIFEST.sha256: выложите набор push.sh"
sha256sum --quiet -c remote-input/MANIFEST.sha256 || die "файлы набора не совпали с MANIFEST.sha256"
say "файлы набора совпали с MANIFEST.sha256"

command -v nvidia-smi >/dev/null || die "нет nvidia-smi: это не сервер с NVIDIA или в контейнер не проброшен GPU"
nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader
CUDA_VERSION="$(nvidia-smi | sed -n 's/.*CUDA Version: *\([0-9.]*\).*/\1/p' | head -1)"
[ -n "$CUDA_VERSION" ] || die "nvidia-smi не сообщил версию CUDA"
[ "${CUDA_VERSION%%.*}" -ge 12 ] || die "драйвер поддерживает CUDA $CUDA_VERSION, нужна 12 или новее"
COMPUTE_CAP="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1)"
[ "${COMPUTE_CAP%%.*}" -ge 8 ] || die "compute capability $COMPUTE_CAP, SP1 нужна 8.0 или выше"
GPU_MEM_MIB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)"
RAM_GB="$(awk '/MemTotal/ { printf "%d", $2 / 1048576 }' /proc/meminfo)"
FREE_GB="$(df -BG --output=avail "$ROOT" | tail -1 | tr -dc 0-9)"
say "CUDA $CUDA_VERSION, compute $COMPUTE_CAP, видеопамять $GPU_MEM_MIB МиБ, ОЗУ $RAM_GB ГБ, свободно $FREE_GB ГБ, ядер $(nproc)"
[ "$RAM_GB" -ge "$MIN_RAM_GB" ] || die "ОЗУ $RAM_GB ГБ, нужно не меньше $MIN_RAM_GB (обёртка Groth16 на процессоре)"
[ "$FREE_GB" -ge "$MIN_FREE_GB" ] || die "свободно $FREE_GB ГБ, нужно не меньше $MIN_FREE_GB"
[ "$GPU_MEM_MIB" -ge 40000 ] || say "видеопамяти меньше 40 ГБ: если пруф целиком на GPU не построится, measure.sh перейдёт к двум шагам"

# --- 2. пакеты и инструменты ---------------------------------------------------------------
PACKAGES=(build-essential pkg-config libssl-dev clang cmake protobuf-compiler libprotobuf-dev git curl ca-certificates python3 time xz-utils tar)
MISSING=()
for package in "${PACKAGES[@]}"; do dpkg -s "$package" >/dev/null 2>&1 || MISSING+=("$package"); done
if [ "${#MISSING[@]}" -gt 0 ]; then
    say "ставлю пакеты: ${MISSING[*]}"
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -q
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${MISSING[@]}"
fi
# sp1-prover-types передаёт protoc флаг --experimental_allow_proto3_optional: он есть с 3.12
# (Ubuntu 22.04 — 3.12.4). google/protobuf/empty.proto — из libprotobuf-dev.
protoc --version
[ -f /usr/include/google/protobuf/empty.proto ] || die "нет /usr/include/google/protobuf/empty.proto (libprotobuf-dev)"

TOOLCHAIN="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' zkvm-evm/rust-toolchain.toml)"
[ -n "$TOOLCHAIN" ] || die "в zkvm-evm/rust-toolchain.toml нет channel"
if ! command -v rustup >/dev/null && [ ! -x "$HOME/.cargo/bin/rustup" ]; then
    say "ставлю rustup (без тулчейна по умолчанию)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup toolchain list | grep -q "^$TOOLCHAIN" || rustup toolchain install "$TOOLCHAIN" --profile minimal
say "Rust $TOOLCHAIN готов"

# Версия SP1 — из Cargo.lock рабочего пространства: sp1-sdk и sp1-build обязаны совпасть.
SP1_VERSION="$(awk '/^name = "sp1-sdk"$/ { getline; gsub(/version = |"/, ""); print; exit }' zkvm-evm/Cargo.lock)"
SP1_BUILD_VERSION="$(awk '/^name = "sp1-build"$/ { getline; gsub(/version = |"/, ""); print; exit }' zkvm-evm/Cargo.lock)"
[ -n "$SP1_VERSION" ] && [ "$SP1_VERSION" = "$SP1_BUILD_VERSION" ] || die "версии sp1-sdk ($SP1_VERSION) и sp1-build ($SP1_BUILD_VERSION) в Cargo.lock разные"
export PATH="$HOME/.sp1/bin:$PATH"
if [ ! -x "$HOME/.sp1/bin/sp1up" ]; then
    say "ставлю sp1up"
    curl --proto '=https' --tlsv1.2 -sSfL https://sp1up.succinct.xyz | bash
fi
if [ "$(cat "$HOME/.sp1/.installed-version" 2>/dev/null)" != "v$SP1_VERSION" ]; then
    say "ставлю SP1 v$SP1_VERSION (cargo-prove и тулчейн succinct)"
    "$HOME/.sp1/bin/sp1up" --version "v$SP1_VERSION"
    echo "v$SP1_VERSION" > "$HOME/.sp1/.installed-version"
fi
GUEST_RUSTC="$(rustc +succinct --version)"
say "тулчейн гостя: $GUEST_RUSTC (на маке — $(sed -n 's/.*"guestRustc": "\(.*\)".*/\1/p' fixtures/evm_batches/program.json))"

GO_DIR="$HOME/.local/go$GO_VERSION"
if [ "$("$GO_DIR/bin/go" version 2>/dev/null | awk '{ print $3 }')" != "go$GO_VERSION" ]; then
    ARCHIVE="go$GO_VERSION.linux-amd64.tar.gz"
    say "ставлю Go $GO_VERSION (sha256 — из списка выпусков go.dev)"
    EXPECTED="$(curl -sSf 'https://go.dev/dl/?mode=json&include=all' | python3 -I -c '
import json, sys
name = sys.argv[1]
for release in json.load(sys.stdin):
    for file in release["files"]:
        if file["filename"] == name:
            print(file["sha256"]); sys.exit(0)
sys.exit("нет " + name)' "$ARCHIVE")"
    TMP="$(mktemp -d)"
    curl -sSfL -o "$TMP/$ARCHIVE" "https://go.dev/dl/$ARCHIVE"
    echo "$EXPECTED  $TMP/$ARCHIVE" | sha256sum --quiet -c || die "sha256 архива Go не совпал"
    rm -rf "$GO_DIR" && mkdir -p "$GO_DIR"
    tar -xzf "$TMP/$ARCHIVE" -C "$GO_DIR" --strip-components=1
    rm -rf "$TMP"
fi
export PATH="$GO_DIR/bin:$PATH"
go version

# --- 3. сервер GPU и артефакты схемы -------------------------------------------------------
# SDK (sp1-cuda 6.10.0, src/server.rs) берёт ~/.sp1/bin/sp1-gpu-server и, если его нет или
# `--version` не равна версии SDK, скачивает github.com/succinctlabs/sp1/releases/download/
# v<версия>/sp1_gpu_server_v<версия>_x86_64.tar.gz без проверки хеша. Кладём заранее и пишем хеш.
GPU_SERVER="$HOME/.sp1/bin/sp1-gpu-server"
if [ "$("$GPU_SERVER" --version 2>/dev/null | tr -d '[:space:]')" != "$SP1_VERSION" ]; then
    ASSET="sp1_gpu_server_v${SP1_VERSION}_x86_64.tar.gz"
    say "скачиваю $ASSET"
    TMP="$(mktemp -d)"
    curl -sSfL -o "$TMP/$ASSET" "https://github.com/succinctlabs/sp1/releases/download/v$SP1_VERSION/$ASSET"
    sha256sum "$TMP/$ASSET" | awk -v name="$ASSET" '{ print $1 "  " name }' > "$HOME/.sp1/bin/sp1-gpu-server.archive.sha256"
    tar -xzf "$TMP/$ASSET" -C "$HOME/.sp1/bin"
    rm -rf "$TMP"
fi
[ "$("$GPU_SERVER" --version | tr -d '[:space:]')" = "$SP1_VERSION" ] || die "sp1-gpu-server --version не $SP1_VERSION"
GPU_SERVER_SHA256="$(sha256sum "$GPU_SERVER" | awk '{ print $1 }')"
say "sp1-gpu-server $SP1_VERSION, sha256 $GPU_SERVER_SHA256"

CIRCUITS="$HOME/.sp1/circuits/groth16/$CIRCUIT_VERSION"
if [ ! -f "$CIRCUITS/groth16_vk.bin" ]; then
    say "скачиваю артефакты схемы Groth16 $CIRCUIT_VERSION (~6 ГБ, распаковка из потока)"
    rm -rf "$CIRCUITS.tmp" && mkdir -p "$CIRCUITS.tmp"
    curl -sSfL "https://sp1-circuits.s3-us-east-2.amazonaws.com/$CIRCUIT_VERSION-groth16.tar.gz" | tar -xzf - -C "$CIRCUITS.tmp"
    touch "$CIRCUITS.tmp/.complete"
    mv "$CIRCUITS.tmp" "$CIRCUITS"
fi
# sha256 файла ключа gnark равен verifierHash закреплённого верификатора (zk/sp1-pins.json).
VERIFIER_HASH="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1]))["versions"][sys.argv[2]]["verifierHash"][2:])' zk/sp1-pins.json "$CIRCUIT_VERSION")"
[ "$(sha256sum "$CIRCUITS/groth16_vk.bin" | awk '{ print $1 }')" = "$VERIFIER_HASH" ] || die "groth16_vk.bin не совпал с verifierHash из zk/sp1-pins.json"
say "артефакты схемы $CIRCUIT_VERSION на месте, ключ совпал с закреплённым"

# --- 4. сборка хоста ------------------------------------------------------------------------
cat > "$OUT/env.sh" <<EOF
export PATH="$GO_DIR/bin:\$HOME/.sp1/bin:\$HOME/.cargo/bin:\$PATH"
export PROTOC="$(command -v protoc)"
export GOPATH="\$HOME/.cache/go-path" GOCACHE="\$HOME/.cache/go-build" GOFLAGS=-modcacherw
unset SP1_SKIP_PROGRAM_BUILD RUSTC_WORKSPACE_WRAPPER
EOF
# shellcheck source=/dev/null
. "$OUT/env.sh"
say "собираю хост (native-gnark, cuda); журнал — remote-out/build.log"
BUILD_STARTED="$(date +%s)"
(cd zkvm-evm && cargo build --release --locked -p rollup-evm-host --features "native-gnark cuda") > "$OUT/build.log" 2>&1 \
    || { tail -40 "$OUT/build.log" >&2; die "хост не собрался"; }
BUILD_SECONDS="$(( $(date +%s) - BUILD_STARTED ))"
IDENTITY="$(zkvm-evm/target/release/rollup-evm-host --identity)"
echo "$IDENTITY"
say "хост собран за $BUILD_SECONDS с"

GPU_SERVER_ARCHIVE="$(cat "$HOME/.sp1/bin/sp1-gpu-server.archive.sha256" 2>/dev/null || echo "не скачивался этим скриптом")"
export CUDA_VERSION COMPUTE_CAP GPU_MEM_MIB RAM_GB FREE_GB TOOLCHAIN GUEST_RUSTC SP1_VERSION GO_VERSION \
    GPU_SERVER_SHA256 GPU_SERVER_ARCHIVE BUILD_SECONDS IDENTITY
PROTOC_VERSION="$(protoc --version)" CPUS="$(nproc)" python3 -I - "$OUT/setup.json" <<'PY'
import json, os, sys
env = os.environ
identity = json.loads(env["IDENTITY"])
program = json.load(open("fixtures/evm_batches/program.json"))
built = identity["programElfSha256"].removeprefix("0x")
json.dump({
    "cudaVersion": env["CUDA_VERSION"],
    "computeCap": env["COMPUTE_CAP"],
    "gpuMemoryMiB": int(env["GPU_MEM_MIB"]),
    "ramGB": int(env["RAM_GB"]),
    "cpus": int(env["CPUS"]),
    "freeDiskGBBeforeBuild": int(env["FREE_GB"]),
    "rustToolchain": env["TOOLCHAIN"],
    "guestRustc": env["GUEST_RUSTC"],
    "sp1Version": env["SP1_VERSION"],
    "goVersion": env["GO_VERSION"],
    "protoc": env["PROTOC_VERSION"],
    "gpuServerSha256": env["GPU_SERVER_SHA256"],
    "gpuServerArchive": env["GPU_SERVER_ARCHIVE"],
    "hostBuildSeconds": int(env["BUILD_SECONDS"]),
    "identity": identity,
    # Справка о воспроизводимости: ELF, который собрал здесь build.rs. В пруф он не идёт.
    "serverBuiltElfSha256": built,
    "serverBuiltElfMatchesMac": built == program["programElfSha256"],
}, open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
PY
say "готово: remote-out/setup.json. Дальше — bash zkvm-evm/host/remote/measure.sh"
