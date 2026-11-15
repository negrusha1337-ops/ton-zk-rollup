#!/usr/bin/env bash
# Забирает с сервера результат замера в .tools/remote-proofs/<ssh-хост>-<время>/ (вне git и вне
# fixtures/): proof.json, measure.json, setup.json и журналы этапов. Запуск на маке:
#
#   zkvm-evm/host/remote/pull.sh <ssh-хост>
#
# Дальше — zkvm-evm/host/remote/verify-local.sh <каталог, который напечатает этот скрипт>.
set -euo pipefail

TARGET="${1:-}"
REPOSITORY="$(cd "$(dirname "$0")/../../.." && pwd -P)"
REMOTE_DIR="ton-zk-rollup"

die() { echo "[pull] ОШИБКА: $*" >&2; exit 1; }
case "$TARGET" in ''|-*) die "использование: pull.sh <ssh-хост>" ;; esac
[[ "$TARGET" =~ ^[A-Za-z0-9._@-]+$ ]] || die "имя ssh-хоста «$TARGET»: только буквы, цифры, . _ @ -"

DEST="$REPOSITORY/.tools/remote-proofs/$TARGET-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
# Только перечисленные файлы, и только если они есть: архив собирает сервер, распаковка — сюда.
ssh -- "$TARGET" "set -e; cd ~/$REMOTE_DIR/remote-out
files=''
for name in proof.json proof-twostep.json measure.json setup.json build.log stages; do [ -e \"\$name\" ] && files=\"\$files \$name\"; done
[ -n \"\$files\" ] || { echo 'на сервере нет результатов в remote-out' >&2; exit 1; }
tar -czf - \$files" | tar -xzf - -C "$DEST"

for name in measure.json proof.json; do
    [ -f "$DEST/$name" ] || { echo "[pull] нет $name — пруф не построен, смотрите $DEST/stages/*/log.txt" >&2; continue; }
    python3 -I -c 'import json, sys; json.load(open(sys.argv[1]))' "$DEST/$name" || die "$DEST/$name — не JSON"
done
# Пути в архиве — только внутри каталога назначения (tar сервера мог бы прислать «../»).
if find "$DEST" -mindepth 1 -maxdepth 1 ! -name proof.json ! -name proof-twostep.json ! -name measure.json \
    ! -name setup.json ! -name build.log ! -name stages | grep -q .; then
    die "в архиве с сервера лишние файлы: $DEST"
fi
echo "[pull] забрано в $DEST"
[ -f "$DEST/measure.json" ] && python3 -I -c '
import json, sys
measure = json.load(open(sys.argv[1]))
print("путь:", measure["pathUsed"])
for stage in measure["stages"]:
    print("  {stage:15} код {exitCode:3}  {seconds:6} с  GPU {peakGpuMemMiB} МиБ  ОЗУ {peakRamUsedMiB} МиБ".format(**stage))
for name, proof in measure["proofs"].items():
    print(" ", name, proof)' "$DEST/measure.json"
echo "[pull] проверка на маке: zkvm-evm/host/remote/verify-local.sh $DEST"
