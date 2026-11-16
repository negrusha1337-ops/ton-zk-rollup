"""Спайк агрегации: собирает bench/aggregation-spike.json из файлов замера (только измеренное).

    python3 -I zkvm-evm/spike-aggregate/ton/write-bench.py

Читает zkvm-evm/spike-aggregate/out/server/ (забрано с сервера rsync'ом) и out/ton/gas.json
(verify-gas.ts). Ничего не досчитывает, кроме сумм и максимумов из этих файлов.
"""
import csv
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = ROOT / "zkvm-evm/spike-aggregate/out"
SERVER = OUT / "server"


def wall_seconds(time_txt):
    text = time_txt.read_text()
    raw = re.search(r"Elapsed \(wall clock\) time .*: ([\d:.]+)", text).group(1)
    parts = [float(p) for p in raw.split(":")]
    return round(sum(v * 60 ** i for i, v in enumerate(reversed(parts))), 2)


def peak_vram(gpu_csv, card=None):
    peak = 0
    for row in csv.reader(gpu_csv.read_text().splitlines()):
        if len(row) < 3 or (card is not None and row[1].strip() != str(card)):
            continue
        peak = max(peak, int(row[2].strip().split()[0]))
    return peak


def gnark_lines(log):
    found = {}
    for name, key in [("Reading R1CS took", "readR1cs"), ("Reading proving key took", "readProvingKey"), ("Generating proof took", "gnarkProve")]:
        values = re.findall(re.escape(name) + r" ([\d.]+)(m?s)", log.read_text())
        found[key] = [round(float(v) / (1000 if unit == "ms" else 1), 1) for v, unit in values]
    return found


def rounded(stages):
    return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in stages.items()}


aggregates = []
for name in ["n2", "n3", "n4", "n8", "n8-ram"]:
    directory = SERVER / f"agg-{name}"
    result = json.loads((directory / "result.json").read_text())
    entry = {
        "run": name,
        "blocks": result["blocks"],
        "card": int(result["cudaDevice"]),
        "aggregateCycles": result["aggregateCycles"],
        "stageSeconds": rounded(result["seconds"]),
        "gnarkSeconds": gnark_lines(directory / "log.txt"),
        "processWallSeconds": wall_seconds(directory / "time.txt"),
        "peakVramMiB": peak_vram(directory / "gpu.csv"),
        "compressedProofBytes": result["compressedProofBytes"],
        "groth16ProofBytes": result["groth16ProofBytes"],
    }
    ram = directory / "ram.txt"
    if ram.exists():
        values = [int(v) for v in ram.read_text().split()]
        entry["machineRamUsedMiB"] = {"min": min(values), "max": max(values)}
    aggregates.append(entry)

cold_blocks = []
for row in list(csv.DictReader((SERVER / "compressed/summary.tsv").read_text().splitlines(), delimiter="\t")):
    log = (SERVER / f"compressed/log-{row['block']}.txt").read_text()
    proof = re.search(r"сжатый пруф построен и проверен за (\d+) с", log)
    vkey_check = re.search(r"Ключ программы из ELF совпал с program.json: \S+ \((\d+) с\)", log)
    cold_blocks.append({
        "block": int(row["block"]), "card": int(row["gpu"]), "exitCode": int(row["exit"]),
        "processSeconds": int(row["seconds"]), "maxRssKiB": int(row["maxRssKiB"]),
        "proofSeconds": int(proof.group(1)) if proof and row["exit"] == "0" else None,
        "cpuVkeyCheckSeconds": int(vkey_check.group(1)) if vkey_check else None,
    })

pipe = SERVER / "pipe"
lanes = {}
for lane, blocks in [("lane0", [1, 2, 3, 4]), ("lane1", [5, 6, 7, 8])]:
    result = json.loads((pipe / lane / "result.json").read_text())
    lanes[lane] = {
        "card": int(result["cudaDevice"]), "blocks": blocks,
        "evmSetupSeconds": round(result["seconds"]["evmSetup"], 2),
        "blockCompressedSeconds": [round(v, 2) for v in result["blockCompressedSeconds"]],
        "processWallSeconds": wall_seconds(pipe / lane / "time.txt"),
        "peakVramMiB": peak_vram(pipe / "gpu.csv", result["cudaDevice"]),
    }
agg = json.loads((pipe / "agg/result.json").read_text())
wall = dict(line.split("=") for line in (pipe / "wall.txt").read_text().split())
pipeline = {
    "note": "Тёплый конвейер (remote/pipeline.sh): карта 0 — сжатые пруфы блоков 1–4, карта 1 — 5–8, каждая в ОДНОМ процессе хоста спайка (сервер GPU и ключ программы подняты один раз), одновременно; затем агрегат N = 8 на карте 0 с двумя Groth16 подряд в одном процессе (второй — тёплый: схема gnark уже прочитана)",
    "lanes": lanes,
    "aggregate": {
        "blocks": agg["blocks"], "card": int(agg["cudaDevice"]),
        "stageSeconds": rounded(agg["seconds"]),
        "groth16RepeatSeconds": [round(v, 2) for v in agg["groth16RepeatSeconds"]],
        "gnarkSeconds": gnark_lines(pipe / "agg/log.txt"),
        "processWallSeconds": wall_seconds(pipe / "agg/time.txt"),
    },
    "wallSeconds": {k: int(v) for k, v in wall.items()},
}

gas = {r["directory"]: r for r in json.loads((OUT / "ton/gas.json").read_text())}
bench = {
    "source": "Спайк агрегации zkvm-evm/spike-aggregate (README.md там же): замер на арендованном сервере zk-gpu 16.11.2026 12:28–12:57 UTC, газ — Sandbox на маке (ton/verify-gas.ts); собрано ton/write-bench.py, не редактировать вручную",
    "machine": "2× NVIDIA RTX A6000 48 ГБ, Xeon Gold 6248R 48 потоков, 377 ГБ ОЗУ (как в bench/remote-gpu-proof.json)",
    "protocolNote": "Измерение, не протокол v2: контракт, программа EVM, ключи и фикстуры не менялись; агрегатный пруф к контракту не подключён",
    "evmProgramVKey": agg["evmProgramVkey"],
    "aggregateVKey": agg["aggregateVkey"],
    "aggregateElfSha256": agg["aggregateElfSha256"],
    "chain": "цепочка Reth fixtures/evm_batches/reth, блоки 1–8 подряд (входы ~/allblocks/in на сервере — те же sha256, что на маке)",
    "blockCompressedColdProcesses": {
        "note": "Существующий хост EVM, по процессу на блок (remote/compress-blocks.sh), две карты одновременно. processSeconds — весь процесс: сверка ключа ELF на процессоре (cpuVkeyCheckSeconds), подъём сервера GPU, пруф (proofSeconds). Код 101 — сервер GPU не поднялся («Could not connect to sp1-gpu-server socket»), повтор. Блоки 4, 6, 7 повторены, пока на сервере шла сборка хоста спайка (процессор занят)",
        "runs": cold_blocks,
        "peakVramMiB": peak_vram(SERVER / "compressed/gpu.csv"),
    },
    "aggregatesColdProcess": {
        "note": "Агрегат блоков 1..N на карте 0, по процессу на N (remote/aggregate.sh): подъём клиента и ключа программы EVM, проверка сжатых пруфов блоков, исполнение агрегатора, сжатый агрегат, Groth16 агрегата одним запросом SDK (рекурсия на GPU, gnark на процессоре: в журнале acceleration=none). n8-ram — повтор N = 8 с записью занятой ОЗУ машины (сервер GPU — отдельный процесс, RSS хоста его не включает)",
        "runs": aggregates,
    },
    "warmPipelineTwoCards": pipeline,
    "tonVerifyGas": {
        "note": "Общий верификатор contracts/bn254_groth16_verifier.tolk в Sandbox, одна транзакция Verify (переменные входы — дайджест и нонс, как у sp1_v6_fibonacci); это не rollup-контракт. Пруфы проверены эталонной библиотекой (ton/check-proof.mjs — шаги zk/import-sp1-fixture.mjs) под закреплённым ключом схемы v6.1.0, публичные значения агрегата — из отчётов блоков на маке (ton/expected-aggregate.mjs). Лучшая подделка каждого отклонена кодом 7100 (wrongProof верификатора)",
        "evmBlock3Proof": gas["block3"]["gasUsed"],
        "aggregate": {name: gas[f"agg-{name}"]["gasUsed"] for name in ["n2", "n3", "n4", "n8"]},
        "forgeryExitCodes": sorted({r["forgeryExitCode"] for r in gas.values()}),
    },
}
target = ROOT / "bench/aggregation-spike.json"
target.write_text(json.dumps(bench, ensure_ascii=False, indent=2) + "\n")
print(f"записано {target.relative_to(ROOT)}")
