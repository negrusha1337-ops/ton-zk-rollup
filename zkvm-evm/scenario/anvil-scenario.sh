#!/bin/bash
# Сценарий спайка EVM: локальная цепочка anvil → блоки → входы батчей (фикстуры тестов).
#
#   anvil-scenario.sh honest             # по адресу моста нет кода: переводы на мост состоялись
#   anvil-scenario.sh reverting-bridge   # в генезисе по адресу моста код, который всё отклоняет:
#                                        # те же переводы включены в блок, но не состоялись
#
# Что делает: поднимает anvil с нашим chainId, майнит пять блоков, записывает хеши блоков со
# слов узла (expected.json — с ними тесты сверяют публичные значения), штатным rsp получает
# входы блоков 2–5, хостом rollup-evm-host превращает их во входы батчей и исполняет каждый
# в zkVM без пруфа.
#
# Блок 1 батчем не становится: у блока 0 в anvil корень состояния в заголовке не соответствует
# состоянию генезиса, так что родителем первого доказуемого блока служит блок 1.
#
# Счета — встроенные тестовые счета anvil (разблокированы на узле, ключей в скрипте нет). У них
# есть баланс с генезиса: для настоящего rollup'а это необеспеченные монеты, здесь — только
# чтобы было чем платить за газ.
#
# Инструменты (вне репозитория, см. PROVING.md → «Спайк EVM»): anvil и cast из Foundry v1.9.0,
# rsp из succinctlabs/rsp на коммите 5afe72eb.
set -euo pipefail

VARIANT="${1:?вариант: honest | reverting-bridge}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${EVM_TOOLS:-$ROOT/.tools}"
ANVIL="${ANVIL:-$TOOLS/foundry/bin/anvil}"
CAST="${CAST:-$TOOLS/foundry/bin/cast}"
RSP="${RSP:-$TOOLS/rsp/target/release/rsp}"
HOST="${HOST:-$ROOT/zkvm-evm/target/release/rollup-evm-host}"
WORK="$TOOLS/evm-spike/$VARIANT"
OUT="$ROOT/fixtures/evm_batches/$VARIANT"

CHAIN_ID=362107787851
PORT=8546
RPC="http://127.0.0.1:$PORT"
# 20 байт строки «ton-zk-rollup-bridge» — BRIDGE_ADDRESS в zkvm-evm/lib.
BRIDGE=0x746f6e2d7a6b2d726f6c6c75702d627269646765

case "$VARIANT" in
  honest) ALLOC='{}' ;;
  # PUSH0 PUSH0 REVERT: любой вызов отклоняется, перевод не проходит.
  reverting-bridge) ALLOC="{\"$BRIDGE\": {\"balance\": \"0x0\", \"code\": \"0x5f5ffd\"}}" ;;
  *) echo "неизвестный вариант: $VARIANT" >&2; exit 1 ;;
esac

for tool in "$ANVIL" "$CAST" "$RSP" "$HOST"; do
  [ -x "$tool" ] || { echo "нет инструмента: $tool" >&2; exit 1; }
done
# Хост обязан быть собран из нынешних исходников: иначе фикстуры и отчёты были бы от прежнего
# кода (в бинарник вшит ELF гостевой программы).
STALE=$(find "$ROOT/zkvm-evm/lib" "$ROOT/zkvm-evm/program" "$ROOT/zkvm-evm/host" "$ROOT/zkvm-evm/vendor" \
  "$ROOT/zkvm-evm/Cargo.toml" "$ROOT/zkvm-evm/Cargo.lock" "$ROOT/zkvm/lib" \
  \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \) -not -path '*/target/*' -newer "$HOST" | sed -n '1,5p')
if [ -n "$STALE" ]; then
  echo "хост старше исходников — пересоберите (cargo build --release --locked -p rollup-evm-host):" >&2
  echo "$STALE" >&2; exit 1
fi
if lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "порт $PORT занят" >&2; exit 1
fi

rm -rf "$WORK"; mkdir -p "$WORK" "$OUT"
cat > "$WORK/genesis.json" <<EOF
{
  "config": {
    "chainId": $CHAIN_ID,
    "homesteadBlock": 0, "daoForkBlock": 0, "daoForkSupport": true,
    "eip150Block": 0, "eip155Block": 0, "eip158Block": 0,
    "byzantiumBlock": 0, "constantinopleBlock": 0, "petersburgBlock": 0,
    "istanbulBlock": 0, "muirGlacierBlock": 0, "berlinBlock": 0, "londonBlock": 0,
    "mergeNetsplitBlock": 0,
    "terminalTotalDifficulty": "0", "terminalTotalDifficultyPassed": true,
    "shanghaiTime": 0, "cancunTime": 0
  },
  "nonce": "0x0", "timestamp": "0x0", "extraData": "0x",
  "gasLimit": "0x1c9c380", "difficulty": "0x0",
  "mixHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "coinbase": "0x0000000000000000000000000000000000000000",
  "baseFeePerGas": "0x3b9aca00",
  "alloc": $ALLOC
}
EOF

"$ANVIL" --init "$WORK/genesis.json" --hardfork cancun --chain-id $CHAIN_ID --port $PORT --no-mining \
  > "$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  "$CAST" block-number --rpc-url $RPC >/dev/null 2>&1 && break
  sleep 0.2
done
"$CAST" block-number --rpc-url $RPC >/dev/null

A0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
A1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
A2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

# send <от> <nonce> <лимит газа> <сумма, wei> <кому> [данные]
send() {
  "$CAST" send --async --unlocked --from "$1" --nonce "$2" --gas-limit "$3" --value "$4" \
    --rpc-url $RPC "$5" ${6:+"$6"} > /dev/null
}
mine() { "$CAST" rpc evm_mine --rpc-url $RPC > /dev/null; sleep 1; }
word() { printf '0x'; printf "$1%.0s" $(seq 1 "$2"); }   # word 11 32 → 32 байта 0x11
# Хеш получателя вывода: первый байт задан, остальные 31 разные (0x01…0x31 как пары цифр) —
# с одинаковыми байтами перестановка внутри хеша была бы невидима.
recipient() { printf '0x%s' "$1"; seq -f '%02g' 1 31 | tr -d '\n'; }
# Аргументы вызова контракта. Слот хранилища — keccak(аргумент), путь в дереве — keccak(слот):
# у этих двух аргументов пути начинаются с одной пары полубайтов (0x2584… и 0x2596…), поэтому
# после второго вызова в дереве хранилища появляется узел-расширение.
ARG_A=0x0000000000000000000000000000000000000000000000000000000000000003
ARG_B=0x000000000000000000000000000000000000000000000000000000000000000e

# Блок 1: тестовый контракт (два SSTORE и лог на вызов) — чтобы в блоках был не только перевод.
# Код намеренно кончается без STOP: исполнение «проваливается за конец кода», и тест на
# недоверие к разбору байткода из входа (дописанные за концом инструкции) имеет смысл.
"$CAST" send --async --unlocked --from $A0 --nonce 0 --gas-limit 200000 --rpc-url $RPC \
  --create 0x60228060095f395ff3335f5260205f20805460010190555f355f5260205f20805460010190553360205fa1 > /dev/null
mine
TOKEN=$("$CAST" compute-address $A0 --nonce 0 | awk '{print $NF}')

# Блок 2. Все переводы на мост — с одного счёта, поэтому их порядок в блоке задан номерами
# nonce: 0,25 (вывод), 31 байт данных (не вывод), 0,1 (вывод), сумма не кратна нанотону
# (не вывод), нулевая сумма (не вывод), 33 байта данных (не вывод). Плюс перевод «как вывод»,
# но на посторонний адрес.
send $A1 0 21000 1000000000000000 0x00000000000000000000000000000000c0ffee01
send $A0 1 120000 0 "$TOKEN" $ARG_A
send $A2 0 40000 250000000000000000 $BRIDGE "$(recipient 11)"
send $A2 1 40000 50000000000000000 $BRIDGE "$(word ee 31)"
send $A2 2 40000 100000000000000000 $BRIDGE "$(recipient 22)"
send $A2 3 40000 50000000000000001 $BRIDGE "$(word ee 32)"
send $A2 4 40000 0 $BRIDGE "$(word ee 32)"
send $A2 5 40000 50000000000000000 $BRIDGE "$(word ee 33)"
# Перевод, оформленный как вывод (32 байта данных, сумма кратна нанотону), но не на мост.
send $A1 1 40000 300000000000000000 0x00000000000000000000000000000000c0ffee03 "$(word 44 32)"
mine

# Блок 3: ещё один вывод — он продолжает непустое дерево выводов.
send $A1 2 21000 2000000000000000 0x00000000000000000000000000000000c0ffee02
send $A2 6 40000 500000000000000000 $BRIDGE "$(recipient 33)"
send $A0 2 120000 0 "$TOKEN" $ARG_B
mine

# Блок 4: пустой — постоянная часть цены батча при непустом дереве выводов.
mine

# Блок 5: повторный вызов с первым аргументом — в свидетеле раскрыто расширение дерева хранилища.
send $A0 3 120000 0 "$TOKEN" $ARG_A
mine

# Хеши блоков и статусы переводов на мост — со слов узла, независимо от нашей программы.
python3 - "$CAST" "$RPC" "$CHAIN_ID" "$BRIDGE" > "$OUT/expected.json" <<'EOF'
import json, subprocess, sys
cast, rpc, chain_id, bridge = sys.argv[1:5]
def call(*args):
    answer = json.loads(subprocess.check_output([cast, *args, "--rpc-url", rpc, "--json"]))
    # cast 1.9 часть ответов заворачивает в конверт {schema_version, success, data}, часть — нет.
    return answer["data"] if isinstance(answer, dict) and "schema_version" in answer else answer
blocks = {}
for number in (1, 2, 3, 4, 5):
    block = call("block", str(number), "--full")
    header = block.get("header", block)
    bridge_statuses = []
    for tx in block["transactions"]:
        if (tx.get("to") or "").lower() == bridge.lower():
            receipt = call("receipt", tx["hash"])
            bridge_statuses.append(int(receipt["status"], 16) if isinstance(receipt["status"], str) else int(receipt["status"]))
    blocks[str(number)] = {
        "hash": header["hash"],
        "transactions": len(block["transactions"]),
        "bridgeTransferStatuses": bridge_statuses,
    }
print(json.dumps({"chainId": chain_id, "bridge": bridge, "blocks": blocks}, indent=2))
EOF

# Входы блоков 2–5 — штатным rsp (заодно он исполняет их своей программой в zkVM, без пруфа).
for number in 2 3 4 5; do
  SP1_PROVER=mock RAYON_NUM_THREADS=4 nice -n 15 "$RSP" --block-number $number --rpc-url $RPC \
    --genesis-path "$WORK/genesis.json" --cache-dir "$WORK/cache" --report-path "$WORK/rsp-report.csv" \
    > "$WORK/rsp-block-$number.log" 2>&1
done
kill $ANVIL_PID 2>/dev/null || true

# Свидетель rollup'а: выводы прежних блоков уже лежат в дереве (в варианте с отклоняющим
# мостом их нет — переводы не состоялись).
LEAF_1="{ \"recipientHash\": \"$(recipient 11)\", \"amount\": \"250000000\" }"
LEAF_2="{ \"recipientHash\": \"$(recipient 22)\", \"amount\": \"100000000\" }"
LEAF_3="{ \"recipientHash\": \"$(recipient 33)\", \"amount\": \"500000000\" }"
# Прежний хеш очереди L1 ненулевой: иначе в zkVM слова очереди всегда были бы нулями.
QUEUE="\"prevDepositHash\": \"$(word 05 32)\""
if [ "$VARIANT" = honest ]; then
  echo "{ $QUEUE }" > "$WORK/witness-2.json"
  echo "{ $QUEUE, \"priorWithdrawals\": [ $LEAF_1, $LEAF_2 ] }" > "$WORK/witness-3.json"
  echo "{ $QUEUE, \"priorWithdrawals\": [ $LEAF_1, $LEAF_2, $LEAF_3 ] }" > "$WORK/witness-4.json"
  cp "$WORK/witness-4.json" "$WORK/witness-5.json"
else
  for number in 2 3 4 5; do echo "{ $QUEUE }" > "$WORK/witness-$number.json"; done
fi

for number in 2 3 4 5; do
  SP1_PROVER=mock RAYON_NUM_THREADS=4 nice -n 15 "$HOST" \
    --block-input "$WORK/cache/input/$CHAIN_ID/$number.bin" --chain-id $CHAIN_ID \
    --witness "$WORK/witness-$number.json" --execute \
    --write-input "$OUT/block-$number.bin" --report "$OUT/block-$number.json"
done
# Батч для контракта на TON: тот же блок 2, но с нулевым хешем очереди L1 — как у только что
# развёрнутого контракта без депозитов. Под этот вход строится пруф Groth16 (PROVING.md).
if [ "$VARIANT" = honest ]; then
  mkdir -p "$ROOT/fixtures/evm_batches/contract"
  echo '{}' > "$WORK/witness-contract.json"
  SP1_PROVER=mock RAYON_NUM_THREADS=4 nice -n 15 "$HOST" \
    --block-input "$WORK/cache/input/$CHAIN_ID/2.bin" --chain-id $CHAIN_ID \
    --witness "$WORK/witness-contract.json" --execute \
    --write-input "$ROOT/fixtures/evm_batches/contract/block-2.bin" \
    --report "$ROOT/fixtures/evm_batches/contract/block-2.json"
fi
echo "Готово: $OUT"
