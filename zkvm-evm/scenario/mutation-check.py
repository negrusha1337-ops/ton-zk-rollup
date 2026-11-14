#!/usr/bin/env python3
"""Проверка тестов мутациями: убираем по одной защите из кода и смотрим, что тесты упали.

    python3 zkvm-evm/scenario/mutation-check.py

Для каждой мутации: правит исходник, запускает `cargo test --release --locked -p rollup-evm
--no-fail-fast`, возвращает исходник. У каждой мутации записан тест, который ОБЯЗАН её убить.

  убита              — код собрался, и среди упавших тестов есть ожидаемый
  УБИТА НЕ ТЕМ       — тесты упали, но ожидаемого среди них нет: защита покрыта случайно
  ВЫЖИЛА             — тесты прошли: защита тестами не покрыта
  НЕ СОБРАЛАСЬ       — мутация сломала компиляцию и ничего не доказывает: исправить мутацию
  НЕ ПРИМЕНЕНА       — образец не найден в исходнике ровно один раз: исправить мутацию

Время изменения файла при возврате ставится НОВОЕ: cargo судит о свежести по времени, и со
старым временем крейт остался бы собранным из мутации — так первый вариант скрипта «убил» 29
мутаций одним посторонним упавшим тестом. Поэтому после прогона хост считается устаревшим, и
перед сценарием его надо пересобрать.

Итог пишется в zkvm-evm/scenario/mutation-report.txt. Прерванный прогон оставляет рядом с
исходником копию `*.orig`; следующий запуск восстановит исходник из неё.
Нагрузка — пересборка одного крейта на каждую мутацию; запускать по одной.
"""
import datetime
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIB = ROOT / "lib/src/lib.rs"
EXECUTE = ROOT / "lib/src/execute.rs"
WITNESS = ROOT / "lib/src/witness.rs"
MPT = ROOT / "vendor/rsp-mpt/src/mpt.rs"
MPT_LIB = ROOT / "vendor/rsp-mpt/src/lib.rs"
REPORT = ROOT / "scenario/mutation-report.txt"
FILES = (LIB, EXECUTE, WITNESS, MPT, MPT_LIB)

BLOB_CHECK = (
    "if has_blob_transaction || block.header.blob_gas_used != Some(0) || block.header.excess_blob_gas != Some(0) {"
)
AMOUNT_CHECK = "if value.is_zero() || !(value % unit).is_zero() {"
QUEUE_WORDS = "        prev_deposit_hash,\n        new_deposit_hash,\n    })"

# (название, файл, что заменить, на что, тест, который обязан упасть)
MUTATIONS = [
    # --- исполнение блока
    ("нет сверки блока с родителем", EXECUTE,
     """        <EthPrimitives as BlockValidator<ChainSpec>>::validate_header_against_parent(
            header,
            parent,
            chain_spec.clone(),
        )
        .map_err(|e| EvmBatchError::InvalidAncestry(e.to_string()))?;
""", "", "block_must_follow_the_rules_against_its_parent"),
    ("нет проверки заголовков предков", EXECUTE,
     """        <EthPrimitives as BlockValidator<ChainSpec>>::validate_header(parent, chain_spec.clone())
            .map_err(|e| EvmBatchError::InvalidAncestry(e.to_string()))?;
""", "", "parent_header_must_follow_the_chain_rules"),
    ("нет проверки блока до исполнения", EXECUTE,
     """    <EthPrimitives as BlockValidator<ChainSpec>>::validate_block(&block, chain_spec.clone())
        .map_err(|e| EvmBatchError::InvalidBlock(e.to_string()))?;
""", "", "block_body_must_match_the_header"),
    ("нет проверки итогов исполнения", EXECUTE,
     """    <EthPrimitives as BlockValidator<ChainSpec>>::validate_block_post_execution(
        &block,
        chain_spec.clone(),
        &execution_output,
    )
    .map_err(|e| EvmBatchError::InvalidExecutionResult(e.to_string()))?;
""", "", "execution_results_in_the_header_must_be_the_executed_ones"),
    ("нет сверки корня состояния", EXECUTE,
     "if computed != input.current_block.header.state_root {", "if false {",
     "state_root_in_the_header_must_be_the_executed_one"),
    ("нет проверки наличия родителя", EXECUTE, "if sealed_headers.len() < 2 {", "if false {",
     "missing_parent_is_rejected"),
    ("прежнее состояние — хеш блока вместо хеша родителя", EXECUTE,
     "parent_hash: sealed_headers[1].hash(),", "parent_hash: sealed_headers[0].hash(),",
     "honest_block_gives_the_words_the_node_reports"),
    ("прежнее состояние — хеш самого дальнего предка", EXECUTE,
     "parent_hash: sealed_headers[1].hash(),", "parent_hash: sealed_headers.last().unwrap().hash(),",
     "previous_state_is_the_parent_even_with_more_ancestors"),
    # --- свидетель состояния
    ("байткод из входа не пересобирается", EXECUTE, "    rebuild_bytecodes(&mut input.bytecodes)?;\n", "",
     "bytecode_analysis_from_the_input_is_not_trusted"),
    ("пересборка оставляет байткод из входа", WITNESS,
     "        *code = Bytecode::new_legacy(code.original_bytes());\n", "",
     "rebuilt_bytecode_depends_only_on_the_hashed_bytes"),
    ("длина байткода не проверяется", WITNESS,
     """        if code.len() > code.bytes_slice().len() {
            return Err(EvmBatchError::Witness("длина байткода больше самого байткода".into()));
        }
""", "", "bytecode_longer_than_its_bytes_is_rejected"),
    ("форма узлов дерева не проверяется", EXECUTE, "    check_state_tries(&input.parent_state)?;\n", "",
     "witness_node_with_another_reading_is_rejected"),
    ("деревья хранилищ не обходятся", WITNESS,
     """    for trie in state.storage_tries.values() {
        check_trie(trie)?;
    }
""", "", "extension_presented_as_a_leaf_in_a_real_block_is_rejected"),
    ("потомки ветки не проверяются", WITNESS,
     "                check_node(child, depth + 1)?;\n", "                let _ = child;\n",
     "extension_presented_as_a_leaf_is_rejected"),
    ("узлы под расширением не проверяются", WITNESS,
     "MptNodeData::Branch(_) => check_node(child, depth + nibbles),", "MptNodeData::Branch(_) => Ok(()),",
     "node_under_an_extension_is_checked"),
    ("признак листа в пути не проверяется", WITNESS,
     """            if !is_leaf {
                return Err("лист с признаком расширения в пути");
            }
""", "", "extension_presented_as_a_leaf_is_rejected"),
    ("признак расширения в пути не проверяется", WITNESS,
     """            if is_leaf {
                return Err("расширение с признаком листа в пути");
            }
""", "", "extension_presented_as_a_leaf_is_rejected"),
    ("пустой узел внутри дерева допустим", WITNESS,
     'MptNodeData::Null => Err("пустой узел внутри дерева"),', "MptNodeData::Null => Ok(()),",
     "non_canonical_shapes_are_rejected"),
    ("ветка с одним потомком допустима", WITNESS, "if present < 2 {", "if false {",
     "non_canonical_shapes_are_rejected"),
    ("лист на любой глубине", WITNESS, "if depth + nibbles != KEY_NIBBLES {", "if false {",
     "non_canonical_shapes_are_rejected"),
    ("лист без значения допустим", WITNESS,
     """            if value.is_empty() {
                return Err("лист без значения");
            }
""", "            let _ = value;\n", "non_canonical_shapes_are_rejected"),
    ("расширение с пустым путём допустимо", WITNESS, "if nibbles == 0 {", "if false {",
     "non_canonical_shapes_are_rejected"),
    ("расширение до глубины ключа допустимо", WITNESS, "if depth + nibbles >= KEY_NIBBLES {", "if false {",
     "non_canonical_shapes_are_rejected"),
    ("расширение в лист допустимо", WITNESS,
     '_ => Err("расширение ведёт не в ветку"),', "_ => Ok(()),", "non_canonical_shapes_are_rejected"),
    ("неизвестные флаги пути допустимы", WITNESS, "if flags > 3 {", "if false {",
     "non_canonical_shapes_are_rejected"),
    ("лишний полубайт в пути чётной длины допустим", WITNESS, "if !odd && first & 0x0f != 0 {", "if false {",
     "non_canonical_shapes_are_rejected"),
    ("удаление рядом с нераскрытым узлом (правка 2 копии rsp-mpt)", MPT,
     """                        MptNodeData::Digest(digest) => {
                            return Err(Error::NodeNotResolved(*digest));
                        }
""", """                        MptNodeData::Digest(_) => {
                            self.data = MptNodeData::Extension(
                                to_encoded_path(&[index as u8], false),
                                orphan,
                            );
                        }
""", "deleting_next_to_an_unrevealed_node_is_an_error"),
    ("вставки и удаления вперемешку (правка 3 копии rsp-mpt)", MPT_LIB,
     """                        for (key, value) in state_storage.storage.iter() {
                            if !value.is_zero() {
                                storage_trie.insert_rlp(key.as_slice(), *value).unwrap();
                            }
                        }
                        for (key, value) in state_storage.storage.iter() {
                            if value.is_zero() {
                                storage_trie.delete(key.as_slice()).unwrap();
                            }
                        }
""", """                        for (key, value) in state_storage.storage.iter() {
                            if value.is_zero() {
                                storage_trie.delete(key.as_slice()).unwrap();
                            } else {
                                storage_trie.insert_rlp(key.as_slice(), *value).unwrap();
                            }
                        }
""", "insertions_go_before_deletions"),
    # --- правила цепочки
    ("правила цепочки без Cancun", LIB, "    config.cancun_time = Some(0);\n", "",
     "honest_block_gives_the_words_the_node_reports"),
    ("правила цепочки без London", LIB, "    config.london_block = Some(0);\n", "",
     "base_fee_must_follow_from_the_parent"),
    ("chainId сетей Linea допустим", LIB,
     "        return Err(EvmBatchError::UnsupportedChainId(chain_id));\n", "",
     "chain_ids_with_relaxed_rules_in_rsp_are_rejected"),
    ("нет запрета транзакций без chainId", LIB, "    reject_unprotected(&body.transactions)?;\n", "",
     "transaction_without_chain_id_is_rejected"),
    ("типы транзакций не ограничены", LIB, "    reject_unsupported_types(&body.transactions)?;\n", "",
     "transaction_with_delegation_is_rejected"),
    ("blob-транзакции допустимы", LIB, BLOB_CHECK,
     "if block.header.blob_gas_used != Some(0) || block.header.excess_blob_gas != Some(0) {",
     "blobs_are_rejected"),
    ("расход blob-газа в заголовке не проверяется", LIB, BLOB_CHECK,
     "if has_blob_transaction || block.header.excess_blob_gas != Some(0) {", "blobs_are_rejected"),
    ("избыток blob-газа в заголовке не проверяется", LIB, BLOB_CHECK,
     "if has_blob_transaction || block.header.blob_gas_used != Some(0) {", "blobs_are_rejected"),
    # --- данные батча
    ("нет сверки данных батча с блоком", LIB,
     "    check_block_data(&alloy_rlp::encode(&block.current_block), &data_chunks)?;\n", "",
     "published_data_must_be_the_block"),
    ("хеш данных — от своей нарезки, а не от опубликованных порций", LIB,
     "batch_data_hash(&data_chunks).map_err(|_| EvmBatchError::DataChunkTooLarge)?;",
     "batch_data_hash(&block_data_chunks(&block.current_block)).map_err(|_| EvmBatchError::DataChunkTooLarge)?;",
     "batch_hash_commits_to_the_chunks_as_published"),
    # --- депозиты
    ("нет сверки депозитов с очередью", LIB,
     "let new_deposit_hash = check_deposits(credits, &queue_items, &prev_deposit_hash)?;",
     "let new_deposit_hash = { let _ = (credits, &queue_items); prev_deposit_hash };",
     "credit_without_a_queue_item_is_rejected"),
    ("очередь сверена, но её хеш не продвинут в публичных значениях", LIB, QUEUE_WORDS,
     "        prev_deposit_hash,\n        new_deposit_hash: { let _ = new_deposit_hash; prev_deposit_hash },\n    })",
     "block_with_a_deposit_advances_the_queue_hash"),
    ("слова очереди переставлены", LIB, QUEUE_WORDS,
     "        prev_deposit_hash: new_deposit_hash,\n        new_deposit_hash: prev_deposit_hash,\n    })",
     "block_with_a_deposit_advances_the_queue_hash"),
    ("число зачислений не сверяется", LIB, "if credits.len() != queue_items.len() {", "if false {",
     "extra_or_missing_credit_is_rejected"),
    ("получатель зачисления не сверяется", LIB,
     "            credit.address != Address::from(deposit.l2_recipient) ||\n", "",
     "credit_must_equal_the_deposit_field_by_field"),
    ("сумма зачисления не сверяется", LIB, "            credit.amount != amount\n", "            false\n",
     "credit_must_equal_the_deposit_field_by_field"),
    ("сумма депозита обрезается до 64 бит", LIB,
     "u64::try_from(deposit.amount).map_err(|_| EvmBatchError::DepositTooLarge(index))?;",
     "deposit.amount as u64;", "deposit_beyond_64_bits_and_forced_transaction_are_rejected"),
    ("номер зачисления не сверяется", LIB, "if credit.index != index as u64 ||", "if false ||",
     "credit_must_equal_the_deposit_field_by_field"),
    ("номер валидатора не сверяется", LIB, "            credit.validator_index != 0 ||\n", "",
     "credit_must_equal_the_deposit_field_by_field"),
    ("хеш очереди не продвигается", LIB, "        hash = deposit_hash(&hash, deposit);\n", "",
     "deposits_matching_the_queue_extend_its_hash"),
    ("принудительная транзакция принимается за депозит молча", LIB,
     "            return Err(EvmBatchError::ForcedTransactionsNotSupported);\n", "            continue;\n",
     "deposit_beyond_64_bits_and_forced_transaction_are_rejected"),
    # --- выводы
    ("неуспешный перевод на мост считается выводом", LIB, "if receipt.success {", "if true {",
     "reverted_bridge_transfer_is_not_a_withdrawal"),
    ("вывод с нулевой суммой", LIB, AMOUNT_CHECK, "if !(value % unit).is_zero() {", "bridge_transfer_rules"),
    ("вывод с суммой не кратной нанотону", LIB, AMOUNT_CHECK, "if value.is_zero() {", "bridge_transfer_rules"),
    ("вывод с любого адреса получателя", LIB, "if transaction.to() != Some(BRIDGE_ADDRESS) {", "if false {",
     "bridge_transfer_rules"),
    ("вывод с данными длиннее 32 байт", LIB, "let recipient_hash = Hash::try_from(data).ok()?;",
     "let recipient_hash = Hash::try_from(data.get(..32)?).ok()?;", "bridge_transfer_rules"),
    ("другой адрес моста", LIB, 'Address::new(*b"ton-zk-rollup-bridge")', 'Address::new(*b"ton-zk-rollup-bridgf")',
     "honest_block_gives_the_words_the_node_reports"),
    ("другая цена нанотона", LIB, "pub const WEI_PER_NANOTON: u64 = 1_000_000_000;",
     "pub const WEI_PER_NANOTON: u64 = 10_000_000_000;", "bridge_transfer_rules"),
    ("прежний корень выводов — ноль", LIB,
     "    let prev_withdrawals_root = withdrawals_root(&prior_withdrawals);\n    let mut leaves = prior_withdrawals;",
     "    let mut leaves = prior_withdrawals;\n    let prev_withdrawals_root = [0u8; 32];",
     "next_block_continues_the_chain_and_the_withdrawal_tree"),
    ("прежний корень выводов — от новых листьев", LIB,
     "        prev_withdrawals_root,\n        withdrawals_root: withdrawals_root(&leaves),",
     "        prev_withdrawals_root: { let _ = prev_withdrawals_root; withdrawals_root(&leaves) },\n"
     "        withdrawals_root: withdrawals_root(&leaves),",
     "next_block_continues_the_chain_and_the_withdrawal_tree"),
    ("новый корень выводов — прежний", LIB,
     "        withdrawals_root: withdrawals_root(&leaves),",
     "        withdrawals_root: { let _ = &leaves; prev_withdrawals_root },",
     "honest_block_gives_the_words_the_node_reports"),
    # --- слова публичных значений
    ("слова состояния переставлены", LIB,
     "        prev_state_root: executed.parent_hash.0,\n        new_state_root: executed.block_hash.0,",
     "        prev_state_root: executed.block_hash.0,\n        new_state_root: executed.parent_hash.0,",
     "honest_block_gives_the_words_the_node_reports"),
    ("слово chainId — не из входа", LIB,
     "        chain_id,\n        prev_state_root: executed.parent_hash.0,",
     "        chain_id: chain_id + 1,\n        prev_state_root: executed.parent_hash.0,",
     "honest_block_gives_the_words_the_node_reports"),
]


def backup(path: pathlib.Path) -> pathlib.Path:
    return path.with_suffix(path.suffix + ".orig")


def restore_interrupted() -> None:
    for path in FILES:
        if backup(path).exists():
            print(f"Найдена копия от прерванного прогона — восстанавливаю {path.name}")
            os.replace(backup(path), path)
            os.utime(path)


def run_tests():
    """Возвращает (исход, подробности): исход — 'ok', 'tests' или 'build'."""
    result = subprocess.run(
        ["nice", "-n", "15", "cargo", "test", "--release", "--locked", "-p", "rollup-evm", "--no-fail-fast"],
        cwd=ROOT, capture_output=True, text=True, env={**os.environ, "CARGO_BUILD_JOBS": "4"},
    )
    if result.returncode == 0:
        return "ok", []
    output = result.stdout + result.stderr
    failed = sorted(set(re.findall(r"^test (\S+) \.\.\. FAILED", output, flags=re.M)))
    if failed:
        return "tests", failed
    return "build", [line for line in output.splitlines() if line.startswith("error")][:3]


def main() -> int:
    restore_interrupted()
    outcome, details = run_tests()
    if outcome != "ok":
        print("Тесты падают и без мутаций — проверять нечего:", *details, sep="\n  ")
        return 2
    lines, bad = [], 0
    for name, path, old, new, expected in MUTATIONS:
        source = path.read_text()
        if source.count(old) != 1:
            verdict, details = "НЕ ПРИМЕНЕНА", [f"образец найден {source.count(old)} раз"]
        else:
            os.replace(path, backup(path))
            try:
                path.write_text(source.replace(old, new))
                outcome, details = run_tests()
            finally:
                os.replace(backup(path), path)
                os.utime(path)
            if outcome == "tests":
                hit = any(test.split("::")[-1] == expected for test in details)
                verdict = "убита" if hit else "УБИТА НЕ ТЕМ"
                details = [f"ожидался {expected}; упали: {', '.join(details)}"]
            else:
                verdict = {"ok": "ВЫЖИЛА", "build": "НЕ СОБРАЛАСЬ"}[outcome]
        if verdict != "убита":
            bad += 1
        line = f"{verdict:<13} {name}" + (f"  [{'; '.join(details)}]" if details else "")
        print(line, flush=True)
        lines.append(line)
    # Исходники возвращены: без мутаций тесты обязаны снова проходить.
    outcome, details = run_tests()
    if outcome != "ok":
        print("После возврата исходников тесты падают — результатам верить нельзя:", *details, sep="\n  ")
        return 2
    summary = f"Мутаций: {len(MUTATIONS)}, не убито ожидаемым тестом: {bad}"
    print("\n" + summary)
    REPORT.write_text(
        f"Проверка тестов мутациями, {datetime.date.today().isoformat()}\n"
        "Команда: python3 zkvm-evm/scenario/mutation-check.py\n"
        "В скобках — тест, который обязан убить мутацию, и все упавшие тесты.\n\n"
        + "\n".join(lines) + "\n\n" + summary + "\n"
    )
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
