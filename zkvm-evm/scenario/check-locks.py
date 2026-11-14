#!/usr/bin/env python3
"""Сверяет версии крейтов, из которых собрана библиотека rollup-evm, в двух lock-файлах:
рабочего пространства (нативные тесты, хост) и гостевой программы (ELF).

    python3 zkvm-evm/scenario/check-locks.py

Нативные тесты и проверка мутациями исполняют сборку по первому файлу, zkVM — по второму.
Если версии крейта, влияющего на исполнение, расходятся, тесты проверяют не тот код, что попал
в ELF: скрипт завершается с ошибкой. Выравнивать — `cargo update -p <крейт> --precise <версия>`
в рабочем пространстве (lock гостя повторяет lock гостевой программы RSP).
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
# Крейты, от которых зависит результат исполнения блока и разбор входа. Расхождение версий у них —
# ошибка; у остальных (процедурные макросы, платформенные и сборочные крейты) — только справка.
EXECUTION_PREFIXES = (
    "alloy", "revm", "reth", "rsp", "rollup", "serde", "bincode", "k256", "p256", "sha2", "sha3", "keccak",
    "ruint", "ecdsa", "elliptic", "nybbles", "bytes", "hashbrown", "foldhash", "substrate-bn", "bn", "kzg",
    "c-kzg", "sp1", "crypto", "primeorder", "ark", "blst", "secp", "aurora", "ripemd", "blake", "itertools",
    "thiserror", "derive_more", "auto_impl", "smallvec", "bumpalo", "rlp", "num", "tiny-keccak", "modular", "indexmap",
)


def closure(manifest: pathlib.Path, package: str) -> dict:
    """Имя крейта → множество версий в замыкании зависимостей пакета (без dev-зависимостей)."""
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--format-version", "1", "--locked", "--manifest-path", str(manifest)],
        cwd=manifest.parent))
    packages = {p["id"]: p for p in metadata["packages"]}
    nodes = {n["id"]: n for n in metadata["resolve"]["nodes"]}
    start = next(i for i, p in packages.items() if p["name"] == package)
    seen, stack = set(), [start]
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        for dep in nodes[current]["deps"]:
            if any(kind["kind"] in (None, "build") for kind in dep["dep_kinds"]):
                stack.append(dep["pkg"])
    versions = {}
    for package_id in seen:
        versions.setdefault(packages[package_id]["name"], set()).add(packages[package_id]["version"])
    return versions


def main() -> int:
    native = closure(ROOT / "Cargo.toml", "rollup-evm")
    guest = closure(ROOT / "program" / "Cargo.toml", "rollup-evm")
    differing = sorted(name for name in native.keys() & guest.keys() if native[name] != guest[name])
    relevant = [name for name in differing if name.startswith(EXECUTION_PREFIXES)]
    for name in relevant:
        print(f"{name}: рабочее пространство {sorted(native[name])}, гость {sorted(guest[name])}")
    print(f"Общих крейтов: {len(native.keys() & guest.keys())}; расходятся версии у {len(differing)}, "
          f"из них влияющих на исполнение блока: {len(relevant)}")
    print("Остальные расхождения (макросы, платформенные и сборочные крейты): " + ", ".join(
        name for name in differing if name not in relevant))
    return 1 if relevant else 0


if __name__ == "__main__":
    sys.exit(main())
