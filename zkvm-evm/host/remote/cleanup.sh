#!/usr/bin/env bash
# Удаляет с арендованного сервера всё, что положили push.sh и setup.sh. Запуск на маке:
#
#   zkvm-evm/host/remote/cleanup.sh <ssh-хост> [--yes]
#
# Останавливает хост и sp1-gpu-server, затем удаляет: ~/ton-zk-rollup (набор, сборка,
# результаты), ~/.sp1 (SP1, sp1-gpu-server, артефакты схемы), ~/.local/go* и ~/.cache/go-*
# (Go и его кэш), ~/.cargo и ~/.rustup (Rust с кэшем крейтов). Пакеты apt остаются.
# Надёжнее всего после этого уничтожить сам инстанс в кабинете vast.ai (Destroy, не Stop):
# остановленный инстанс хранит диск.
set -euo pipefail

TARGET="${1:-}"
CONFIRM="${2:-}"
die() { echo "[cleanup] ОШИБКА: $*" >&2; exit 1; }
case "$TARGET" in ''|-*) die "использование: cleanup.sh <ssh-хост> [--yes]" ;; esac
[[ "$TARGET" =~ ^[A-Za-z0-9._@-]+$ ]] || die "имя ssh-хоста «$TARGET»: только буквы, цифры, . _ @ -"

# shellcheck disable=SC2088  # тильда раскрывается на сервере, не здесь
PATHS='~/ton-zk-rollup ~/.sp1 ~/.local/go* ~/.cache/go-path ~/.cache/go-build ~/.cargo ~/.rustup'
echo "[cleanup] на $TARGET будут остановлены rollup-evm-host и sp1-gpu-server и удалены: $PATHS"
if [ "$CONFIRM" != "--yes" ]; then
    read -r -p "[cleanup] удалить без возможности восстановления? (yes/no) " answer
    [ "$answer" = "yes" ] || { echo "[cleanup] отменено"; exit 1; }
fi
# shellcheck disable=SC2029  # пути раскрываются на сервере намеренно
ssh -- "$TARGET" "pkill -KILL -f '[r]elease/rollup-evm-host|[s]p1-gpu-server' || true; rm -rf $PATHS; echo '[cleanup] на сервере удалено'; df -h ~ | tail -1"
echo "[cleanup] теперь уничтожьте инстанс в vast.ai (Destroy)."
