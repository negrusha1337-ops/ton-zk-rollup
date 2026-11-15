#!/usr/bin/env python3
"""Проверка тестов мутациями: убираем по одной защите из кода и смотрим, что тесты упали.

    python3 zkvm-evm/scenario/mutation-check.py
    python3 zkvm-evm/scenario/mutation-check.py <часть названия>   # только эти мутации, без записи отчёта
    python3 zkvm-evm/scenario/mutation-check.py --dry              # только сверить образцы с исходниками

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
FORCED = ROOT / "lib/src/forced.rs"
BRIDGE = ROOT / "lib/src/bridge.rs"
WITHDRAWALS = ROOT / "lib/src/withdrawals.rs"
PROTOCOL = ROOT / "lib/src/protocol.rs"
GENESIS = ROOT / "lib/src/genesis.rs"
MPT = ROOT / "vendor/rsp-mpt/src/mpt.rs"
MPT_LIB = ROOT / "vendor/rsp-mpt/src/lib.rs"
REPORT = ROOT / "scenario/mutation-report.txt"
FILES = (LIB, EXECUTE, WITNESS, FORCED, BRIDGE, WITHDRAWALS, PROTOCOL, GENESIS, MPT, MPT_LIB)

BLOB_CHECK = (
    "if has_blob_transaction || block.header.blob_gas_used != Some(0) || block.header.excess_blob_gas != Some(0) {"
)
# Тест, который сверяет все одиннадцать слов каждого блока цепочки с узлом и очередью.
WORDS = "every_block_gives_the_words_the_node_and_the_contract_expect"
CLASSIFY = "revm_refusals_are_classified_by_a_closed_list"
SHAPE = "bridge_log_of_another_shape_is_an_error"
FRONTIER = "frontier_root_equals_the_full_recomputation"
PORTED = "ported_protocol_functions_equal_the_toy_ledger_library"
BRIDGE_LOG_SHAPE = (
    "if topics.len() != 2 || topics[0] != WITHDRAWAL_TOPIC || topics[1][..12] != [0u8; 12] || data.len() != 64 {"
)


def classify(reason: str, pattern: str):
    """Мутация «этот отказ revm — ошибка батча, а не пропуск»."""
    line = f"        InvalidTransaction::{pattern} => Some(InvalidReason::{reason}),\n"
    return (f"отказ revm {reason} — не пропуск", EXECUTE, line, "", CLASSIFY)


def header_policy(field: str, condition: str):
    return (f"поле заголовка {field} не закреплено", LIB, f"    if {condition} {{\n        return Err(EvmBatchError::HeaderPolicy(\"{field}\"));",
            f"    if false {{\n        return Err(EvmBatchError::HeaderPolicy(\"{field}\"));", "header_fields_left_to_the_builder_are_fixed")


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
     "parent_hash: sealed_headers[1].hash(),", "parent_hash: sealed_headers[0].hash(),", WORDS),
    ("прежнее состояние — хеш самого дальнего предка", EXECUTE,
     "parent_hash: sealed_headers[1].hash(),", "parent_hash: sealed_headers.last().unwrap().hash(),",
     "previous_state_is_the_parent_even_with_more_ancestors"),
    # --- принудительные транзакции: исполнение
    ("действительная принудительная не обязана быть в блоке", EXECUTE,
     """                    if !in_block {
                        return Err(EvmBatchError::ForcedTransactionOmitted(index));
                    }
""", "                    let _ = in_block;\n", "valid_forced_transaction_left_out_of_the_block_is_an_error"),
    ("с транзакцией блока сверяется только наличие, а не байты", EXECUTE,
     "transactions.get(included).is_some_and(|next| next.encoded_2718() == *bytes);",
     "transactions.get(included).is_some_and(|next| !next.encoded_2718().is_empty() && !bytes.is_empty());",
     "valid_forced_transaction_out_of_its_place_is_an_error"),
    ("принудительная ищется где угодно в блоке, а не на своём месте", EXECUTE,
     "transactions.get(included).is_some_and(|next| next.encoded_2718() == *bytes);",
     "transactions.iter().skip(included).any(|next| next.encoded_2718() == *bytes);",
     "valid_forced_transaction_out_of_its_place_is_an_error"),
    ("не помещается по газу блока — пропуск вместо ошибки", EXECUTE,
     ")) => return Err(EvmBatchError::ForcedTransactionDoesNotFit(index)),",
     ")) => outcomes.push(ForcedOutcome::Skipped(SkipReason::GasLimitAboveCap)),",
     "forced_transaction_that_does_not_fit_the_block_is_a_batch_error"),
    ("включённая принудительная исполнена, но не применена", EXECUTE,
     "                    executor.commit_transaction(output);\n", "                    drop(output);\n", WORDS),
    ("включённая принудительная исполняется второй раз как транзакция секвенсора", EXECUTE,
     "block.transactions_recovered().skip(included)", "block.transactions_recovered().skip(0 * included)", WORDS),
    ("негодная по форме принудительная — ошибка батча вместо пропуска", EXECUTE,
     """                Err(reason) => {
                    outcomes.push(ForcedOutcome::Skipped(reason));
                    continue;
                }""",
     """                Err(reason) => {
                    return Err(EvmBatchError::ForcedTransactionRefusal(index, format!("{reason:?}")));
                }""", "forced_transactions_end_up_as_the_scenario_says"),
    classify("NonceTooLow", "NonceTooLow { .. }"),
    classify("NonceTooHigh", "NonceTooHigh { .. }"),
    classify("NonceOverflow", "NonceOverflowInTransaction"),
    classify("LackOfFunds", "LackOfFundForMaxFee { .. }"),
    classify("PaymentOverflow", "OverflowPaymentInTransaction"),
    classify("SenderHasCode", "RejectCallerWithCode"),
    classify("GasPriceBelowBaseFee", "GasPriceLessThanBasefee"),
    classify("PriorityFeeAboveMaxFee", "PriorityFeeGreaterThanMaxFee"),
    classify("IntrinsicGas", "CallGasCostMoreThanGasLimit { .. }"),
    ("любой отказ revm — пропуск", EXECUTE, "        _ => None,\n    }\n}",
     "        _ => Some(InvalidReason::LackOfFunds),\n    }\n}", CLASSIFY),
    ("отказ revm по состоянию — ошибка батча (в блоке)", EXECUTE,
     "match error.as_invalid_tx_err().and_then(classify_invalid) {",
     "match error.as_invalid_tx_err().and_then(classify_invalid).filter(|_| false) {",
     "transaction_invalid_on_the_current_state_is_skipped_for_each_reason"),
    ("предел газа принудительной транзакции не действует", LIB,
     "    process_with_gas_cap(input, FORCED_TX_GAS_CAP)\n", "    process_with_gas_cap(input, u64::MAX)\n",
     "forced_transactions_end_up_as_the_scenario_says"),
    ("другой предел газа принудительной транзакции", LIB, "pub const FORCED_TX_GAS_CAP: u64 = 40_000;",
     "pub const FORCED_TX_GAS_CAP: u64 = 40_001;", "gas_limit_is_capped"),
    # --- принудительные транзакции: форма
    ("предел длины принудительной транзакции не проверяется", FORCED,
     "if bytes.len() > FORCED_TX_MAX_BYTES {", "if false {", "forced_transaction_longer_than_the_limit_is_skipped"),
    ("предел длины принудительной транзакции — нестрогий", FORCED,
     "if bytes.len() > FORCED_TX_MAX_BYTES {", "if bytes.len() >= FORCED_TX_MAX_BYTES {",
     "forced_transaction_longer_than_the_limit_is_skipped"),
    ("другой предел длины принудительной транзакции", LIB, "pub const FORCED_TX_MAX_BYTES: usize = 256;",
     "pub const FORCED_TX_MAX_BYTES: usize = 257;", "forced_transaction_longer_than_the_limit_is_skipped"),
    ("хвост после транзакции допустим", FORCED,
     "TransactionSigned::decode_2718_exact(bytes).map_err(|_| SkipReason::Undecodable)?;",
     "TransactionSigned::decode_2718(&mut &bytes[..]).map_err(|_| SkipReason::Undecodable)?;",
     "bytes_that_are_not_one_transaction_are_skipped"),
    ("тип принудительной транзакции не ограничен", FORCED,
     """    if !matches!(transaction.tx_type(), TxType::Legacy | TxType::Eip2930 | TxType::Eip1559) {
        return Err(SkipReason::UnsupportedType);
    }
""", "", "blob_and_delegation_transactions_are_skipped"),
    ("принудительная EIP-2930 недопустима", FORCED, "TxType::Legacy | TxType::Eip2930 | TxType::Eip1559",
     "TxType::Legacy | TxType::Eip1559", "bridge_call_of_each_ordinary_type_is_well_formed"),
    ("принудительная обычная недопустима", FORCED, "TxType::Legacy | TxType::Eip2930 | TxType::Eip1559",
     "TxType::Eip2930 | TxType::Eip1559", "bridge_call_of_each_ordinary_type_is_well_formed"),
    ("принудительная без chainId допустима", FORCED,
     "        None => return Err(SkipReason::MissingChainId),\n", "        None => {}\n",
     "transaction_for_another_chain_or_for_any_chain_is_skipped"),
    ("принудительная с чужим chainId допустима", FORCED,
     "        Some(id) if id != chain_id => return Err(SkipReason::ForeignChainId),\n", "",
     "transaction_for_another_chain_or_for_any_chain_is_skipped"),
    ("принудительное создание контракта допустимо", FORCED,
     "        None => return Err(SkipReason::Create),\n", "        None => {}\n",
     "only_a_call_to_the_bridge_can_be_forced"),
    ("принудительная транзакция на любой адрес", FORCED,
     "        Some(to) if to != BRIDGE_ADDRESS => return Err(SkipReason::NotBridgeCall),\n", "",
     "only_a_call_to_the_bridge_can_be_forced"),
    ("предел газа формы не проверяется", FORCED, "if transaction.gas_limit() > gas_cap {", "if false {",
     "gas_limit_is_capped"),
    ("предел газа формы — нестрогий", FORCED, "if transaction.gas_limit() > gas_cap {",
     "if transaction.gas_limit() >= gas_cap {", "gas_limit_is_capped"),
    ("подпись с s в верхней половине допустима", FORCED, "transaction.recover_signer().map_err",
     "transaction.recover_signer_unchecked().map_err", "unrecoverable_and_malleable_signatures_are_skipped"),
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
    ("счета удаляются вперемешку со вставками (правка 3 копии rsp-mpt)", MPT_LIB,
     """                None => {}
            }
        }
        for (hashed_address, account) in post_state.accounts.iter() {
            if account.is_none() {
                self.state_trie.delete(hashed_address.as_slice()).unwrap();
            }
        }
""", """                None => {
                    self.state_trie.delete(hashed_address.as_slice()).unwrap();
                }
            }
        }
""", "account_insertions_go_before_deletions"),
    # --- правила цепочки
    ("правила цепочки без Cancun", LIB, "    config.cancun_time = Some(0);\n", "", WORDS),
    ("правила цепочки без London", LIB, "    config.london_block = Some(0);\n", "",
     "base_fee_must_follow_from_the_parent"),
    ("chainId сетей Linea допустим", LIB,
     "        return Err(EvmBatchError::UnsupportedChainId(chain_id));\n", "",
     "chain_ids_with_relaxed_rules_in_rsp_are_rejected"),
    ("нет запрета транзакций без chainId", LIB, "    reject_unprotected(&body.transactions)?;\n", "",
     "transaction_without_chain_id_is_rejected"),
    ("типы транзакций не ограничены", LIB, "    reject_unsupported_types(&body.transactions)?;\n", "",
     "transaction_with_delegation_is_rejected"),
    ("транзакции EIP-2930 недопустимы", LIB, "TxType::Legacy | TxType::Eip2930 | TxType::Eip1559",
     "TxType::Legacy | TxType::Eip1559", "ordinary_transaction_types_pass_the_type_check"),
    ("транзакции EIP-1559 недопустимы", LIB, "TxType::Legacy | TxType::Eip2930 | TxType::Eip1559",
     "TxType::Legacy | TxType::Eip2930", "ordinary_transaction_types_pass_the_type_check"),
    ("blob-транзакции допустимы", LIB, BLOB_CHECK,
     "if block.header.blob_gas_used != Some(0) || block.header.excess_blob_gas != Some(0) {",
     "blobs_are_rejected"),
    ("расход blob-газа в заголовке не проверяется", LIB, BLOB_CHECK,
     "if has_blob_transaction || block.header.excess_blob_gas != Some(0) {", "blobs_are_rejected"),
    ("избыток blob-газа в заголовке не проверяется", LIB, BLOB_CHECK,
     "if has_blob_transaction || block.header.blob_gas_used != Some(0) {", "blobs_are_rejected"),
    # --- поля заголовка
    header_policy("gas_limit", "header.gas_limit != GAS_LIMIT"),
    header_policy("mix_hash", "header.mix_hash != B256::ZERO"),
    header_policy("extra_data", "!header.extra_data.is_empty()"),
    header_policy("parent_beacon_block_root", "header.parent_beacon_block_root != Some(B256::ZERO)"),
    ("закреплённые поля заголовка не проверяются в блоке", LIB,
     "    check_header_policy(&block.current_block.header)?;\n", "",
     "header_fields_left_to_the_builder_are_fixed_in_a_real_block"),
    ("другой лимит газа блока", LIB, "pub const GAS_LIMIT: u64 = 30_000_000;",
     "pub const GAS_LIMIT: u64 = 30_000_001;", "constants_shared_with_the_contract_are_equal"),
    # --- данные батча
    ("нет сверки данных батча с блоком", LIB,
     "    check_block_data(&alloy_rlp::encode(&block.current_block), &data_chunks)?;\n", "",
     "published_data_must_be_the_block"),
    ("хеш данных — от своей нарезки, а не от опубликованных порций", LIB,
     "batch_data_hash(&data_chunks).map_err(|_| EvmBatchError::DataChunkTooLarge)?;",
     "batch_data_hash(&block_data_chunks(&block.current_block)).map_err(|_| EvmBatchError::DataChunkTooLarge)?;",
     "batch_hash_commits_to_the_chunks_as_published"),
    # --- очередь L1
    ("нет сверки очереди с блоком", LIB,
     "let new_deposit_hash = check_queue(credits, &queue_items, &prev_deposit_hash)?;",
     "let new_deposit_hash = { let _ = (credits, &queue_items); prev_deposit_hash };",
     "credit_without_a_queue_item_is_rejected"),
    ("очередь сверена, но её хеш не продвинут в публичных значениях", LIB,
     "            prev_deposit_hash,\n            new_deposit_hash,\n",
     "            prev_deposit_hash,\n            new_deposit_hash: { let _ = new_deposit_hash; prev_deposit_hash },\n",
     WORDS),
    ("слова очереди переставлены", LIB,
     "            prev_deposit_hash,\n            new_deposit_hash,\n",
     "            prev_deposit_hash: new_deposit_hash,\n            new_deposit_hash: prev_deposit_hash,\n", WORDS),
    ("предел отрезка очереди не проверяется", LIB, "if queue_items.len() > MAX_BATCH_QUEUE_ITEMS {", "if false {",
     "queue_segment_is_limited"),
    ("предел отрезка очереди не как в контракте", LIB, "pub const MAX_BATCH_QUEUE_ITEMS: usize = 32;",
     "pub const MAX_BATCH_QUEUE_ITEMS: usize = 33;", "constants_shared_with_the_contract_are_equal"),
    ("зачисление положено и за принудительную транзакцию", LIB,
     "let deposits = queue_items.iter().filter(|item| matches!(item, QueueItem::Deposit(_))).count();",
     "let deposits = queue_items.len();", "forced_transactions_enter_the_queue_hash_in_order_and_take_no_credit"),
    ("число зачислений не сверяется", LIB, "if credits.len() != deposits {", "if false {",
     "extra_or_missing_credit_is_rejected"),
    ("получатель зачисления не сверяется", LIB,
     "                credit.address != Address::from(deposit.l2_recipient) ||\n", "",
     "credit_must_equal_the_deposit_field_by_field"),
    ("сумма зачисления не сверяется", LIB, "                credit.amount != amount\n", "                false\n",
     "credit_must_equal_the_deposit_field_by_field"),
    ("сумма депозита обрезается до 64 бит", LIB,
     "u64::try_from(deposit.amount).map_err(|_| EvmBatchError::DepositTooLarge(index))?;",
     "deposit.amount as u64;", "deposit_beyond_64_bits_is_rejected"),
    ("номер зачисления не сверяется", LIB, "if credit.index != index as u64 ||", "if false ||",
     "credit_must_equal_the_deposit_field_by_field"),
    ("номер валидатора не сверяется", LIB, "                credit.validator_index != 0 ||\n", "",
     "credit_must_equal_the_deposit_field_by_field"),
    ("хеш очереди не продвигается", LIB, "        hash = queue_item_hash(&hash, item);\n", "",
     "deposits_matching_the_queue_extend_its_hash"),
    ("принудительная транзакция не входит в хеш очереди", PROTOCOL,
     "QueueItem::ForcedTransaction(bytes) => forced_transaction_hash(previous, bytes),",
     "QueueItem::ForcedTransaction(_) => *previous,",
     "forced_transactions_enter_the_queue_hash_in_order_and_take_no_credit"),
    ("хеш принудительной транзакции без метки", PROTOCOL,
     "sha256(&[previous, &FORCED_TRANSACTION_MARKER, &keccak256(transaction_bytes).0])",
     "sha256(&[previous, &[0u8; 32], &keccak256(transaction_bytes).0])",
     "forced_transaction_hash_is_the_marker_and_keccak_of_the_bytes"),
    ("другая метка принудительной транзакции", PROTOCOL, "    marker[0] = 0x80;\n", "    marker[0] = 0x40;\n",
     "constants_shared_with_the_contract_are_equal"),
    ("хеш депозита: поля в другом порядке", PROTOCOL,
     "sha256(&[previous, &address_word(&deposit.l2_recipient), &word(deposit.amount)])",
     "sha256(&[previous, &word(deposit.amount), &address_word(&deposit.l2_recipient)])", PORTED),
    ("хеш порции данных: длина куска не удвоена", PROTOCOL, "(piece.len() * 2) as u8", "piece.len() as u8", PORTED),
    ("хеш листа вывода: поля в другом порядке", PROTOCOL,
     "sha256(&[&word(leaf_index as u128), &leaf.recipient_hash, &word(leaf.amount)])",
     "sha256(&[&word(leaf_index as u128), &word(leaf.amount), &leaf.recipient_hash])", PORTED),
    # --- мост и выводы
    ("лог с любого адреса считается выводом", BRIDGE, "            if log.address == BRIDGE_ADDRESS {",
     "            if log.address == BRIDGE_ADDRESS || true {", "withdrawals_are_the_bridge_logs_in_block_order"),
    ("лог моста негодной формы пропускается молча", BRIDGE,
     "                leaves.push(withdrawal_from_log(log)?);\n",
     "                if let Ok(leaf) = withdrawal_from_log(log) {\n                    leaves.push(leaf);\n                }\n",
     "withdrawals_are_the_bridge_logs_in_block_order"),
    ("выводы в обратном порядке логов", BRIDGE,
     "                leaves.push(withdrawal_from_log(log)?);\n",
     "                leaves.insert(0, withdrawal_from_log(log)?);\n", "withdrawals_are_the_bridge_logs_in_block_order"),
    ("событие лога моста не проверяется", BRIDGE, BRIDGE_LOG_SHAPE,
     "if topics.len() != 2 || topics[1][..12] != [0u8; 12] || data.len() != 64 {", SHAPE),
    ("лог моста с лишними топиками допустим", BRIDGE, BRIDGE_LOG_SHAPE,
     "if topics.len() < 2 || topics[0] != WITHDRAWAL_TOPIC || topics[1][..12] != [0u8; 12] || data.len() != 64 {", SHAPE),
    ("отправитель в логе моста шире адреса", BRIDGE, BRIDGE_LOG_SHAPE,
     "if topics.len() != 2 || topics[0] != WITHDRAWAL_TOPIC || data.len() != 64 {", SHAPE),
    ("данные лога моста длиннее 64 байт допустимы", BRIDGE, BRIDGE_LOG_SHAPE,
     "if topics.len() != 2 || topics[0] != WITHDRAWAL_TOPIC || topics[1][..12] != [0u8; 12] || data.len() < 64 {", SHAPE),
    ("сумма вывода обрезается до 128 бит", BRIDGE,
     "u128::try_from(U256::from_be_slice(&data[32..])).map_err(|_| MalformedBridgeLog)?;",
     "U256::from_be_slice(&data[32..64]).wrapping_to::<u128>();", SHAPE),
    ("другой адрес моста", BRIDGE, 'Address::new(*b"ton-zk-rollup-bridge")', 'Address::new(*b"ton-zk-rollup-bridgf")',
     "bridge_constants_follow_from_the_bytecode"),
    ("другое событие моста", BRIDGE,
     'b256!("4206db6775563d1043abfcf27cd0ecd19fcc464be574a1487fc95b24957a671a")',
     'b256!("4206db6775563d1043abfcf27cd0ecd19fcc464be574a1487fc95b24957a671b")',
     "bridge_constants_follow_from_the_bytecode"),
    ("другой хеш кода моста", BRIDGE,
     'b256!("4fb6d78f56819527fe507eb73d6490c14924233bc459195a7fdd4ec422a80bae")',
     'b256!("4fb6d78f56819527fe507eb73d6490c14924233bc459195a7fdd4ec422a80baf")',
     "bridge_constants_follow_from_the_bytecode"),
    ("код моста не проверяется", LIB,
     "if !withdrawals.is_empty() && executed.bridge_code_hash != Some(Some(BRIDGE_CODE_HASH)) {", "if false {",
     "bridge_log_counts_only_if_the_bridge_code_is_the_protocol_one"),
    ("код моста проверяется и без логов", LIB,
     "if !withdrawals.is_empty() && executed.bridge_code_hash != Some(Some(BRIDGE_CODE_HASH)) {",
     "if executed.bridge_code_hash != Some(Some(BRIDGE_CODE_HASH)) {",
     "bridge_code_is_checked_only_when_the_block_has_bridge_logs"),
    ("выводы блока не дозаписываются в дерево", LIB,
     "        tree.append(leaf).map_err(|_| EvmBatchError::TooManyWithdrawals)?;\n", "        let _ = leaf;\n", WORDS),
    ("вывод в полное дерево проходит молча", LIB,
     "        tree.append(leaf).map_err(|_| EvmBatchError::TooManyWithdrawals)?;\n",
     "        let _ = tree.append(leaf);\n", "withdrawal_into_a_full_tree_is_rejected"),
    # --- дерево выводов
    ("канонический вид фронтира не проверяется", WITHDRAWALS,
     "if (count >> height) & 1 == 0 && *node != [0u8; 32] {", "if false {", "garbage_in_the_frontier_is_rejected"),
    ("фронтир из входа не проверяется в батче", LIB,
     "WithdrawalTree::from_input(withdrawals_frontier, withdrawals_count)\n        .map_err(EvmBatchError::WithdrawalFrontier)?;",
     "WithdrawalTree::from_input(withdrawals_frontier, withdrawals_count.min(MAX_WITHDRAWALS))\n        .or_else(|_| WithdrawalTree::from_input([[0u8; 32]; WITHDRAWAL_TREE_DEPTH], 0))\n        .map_err(EvmBatchError::WithdrawalFrontier)?;",
     "garbage_in_the_frontier_of_the_input_is_rejected"),
    ("счётчик выводов без предела", WITHDRAWALS, "if count > MAX_WITHDRAWALS {", "if false {",
     "counter_is_limited_to_the_tree"),
    ("предел счётчика выводов — 2^32", WITHDRAWALS,
     "pub const MAX_WITHDRAWALS: u64 = (1 << WITHDRAWAL_TREE_DEPTH) - 1;",
     "pub const MAX_WITHDRAWALS: u64 = 1 << WITHDRAWAL_TREE_DEPTH;", "counter_is_limited_to_the_tree"),
    ("дозапись в полное дерево", WITHDRAWALS, "if self.count >= MAX_WITHDRAWALS {", "if false {",
     "counter_is_limited_to_the_tree"),
    ("корень: склейка с фронтиром в другом порядке", WITHDRAWALS,
     "                sha256(&[&self.frontier[height], &node])\n",
     "                sha256(&[&node, &self.frontier[height]])\n", FRONTIER),
    ("корень: склейка с пустым поддеревом в другом порядке", WITHDRAWALS,
     "                sha256(&[&node, &empty])\n", "                sha256(&[&empty, &node])\n", FRONTIER),
    ("корень: пустое поддерево не растёт с уровнем", WITHDRAWALS,
     "            empty = sha256(&[&empty, &empty]);\n", "", FRONTIER),
    ("корень дерева без листьев — не ноль", WITHDRAWALS,
     "        if self.count == 0 {\n            return [0u8; 32];\n        }\n", "", FRONTIER),
    ("дозапись: склейка в другом порядке", WITHDRAWALS,
     "            node = sha256(&[&self.frontier[height], &node]);\n",
     "            node = sha256(&[&node, &self.frontier[height]]);\n", FRONTIER),
    ("дозапись: элемент фронтира не обнуляется", WITHDRAWALS,
     "            self.frontier[height] = [0u8; 32];\n", "", FRONTIER),
    ("дозапись: счётчик не растёт", WITHDRAWALS, "        self.count += 1;\n", "", FRONTIER),
    ("номер листа не входит в его хеш", WITHDRAWALS,
     "withdrawal_leaf_hash(self.count as u32, leaf)", "withdrawal_leaf_hash(0, leaf)",
     "leaf_number_is_part_of_the_leaf_hash"),
    # --- слова публичных значений
    ("слова состояния переставлены", LIB,
     "            prev_state_root: executed.parent_hash.0,\n            new_state_root: executed.block_hash.0,",
     "            prev_state_root: executed.block_hash.0,\n            new_state_root: executed.parent_hash.0,", WORDS),
    ("слово chainId — не из входа", LIB,
     "            chain_id,\n            prev_state_root: executed.parent_hash.0,",
     "            chain_id: chain_id + 1,\n            prev_state_root: executed.parent_hash.0,", WORDS),
    ("прежний корень выводов — ноль", LIB, "    let prev_withdrawals_root = tree.root();\n",
     "    let prev_withdrawals_root = { let _ = &tree; [0u8; 32] };\n", WORDS),
    ("прежний корень выводов — после дозаписи", LIB,
     "            prev_withdrawals_root,\n            withdrawals_root: tree.root(),",
     "            prev_withdrawals_root: { let _ = prev_withdrawals_root; tree.root() },\n            withdrawals_root: tree.root(),",
     WORDS),
    ("новый корень выводов — прежний", LIB,
     "            withdrawals_root: tree.root(),", "            withdrawals_root: prev_withdrawals_root,", WORDS),
    ("слово 8 (прежний счётчик выводов) — ноль", LIB,
     "            prev_withdrawals_count: withdrawals_count,", "            prev_withdrawals_count: 0 * withdrawals_count,", WORDS),
    ("слово 9 (счётчик выводов) — ноль", LIB,
     "            withdrawals_count: tree.count(),", "            withdrawals_count: 0,", WORDS),
    ("слово 9 (счётчик выводов) — прежний счётчик", LIB,
     "            withdrawals_count: tree.count(),", "            withdrawals_count,", WORDS),
    ("слово 10 (время блока) — ноль", LIB,
     "    let block_timestamp = block.current_block.header.timestamp;\n",
     "    let block_timestamp = 0 * block.current_block.header.timestamp;\n",
     "block_timestamp_word_is_the_time_in_the_header"),
    ("слово 10 (время блока) — время родителя", LIB,
     "    let block_timestamp = block.current_block.header.timestamp;\n",
     "    let block_timestamp = block.ancestor_headers.first().map_or(0, |parent| parent.timestamp);\n",
     "block_timestamp_word_is_the_time_in_the_header"),
    ("слова счётчиков выводов переставлены в байтах", PROTOCOL,
     "            word(self.prev_withdrawals_count as u128),\n            word(self.withdrawals_count as u128),",
     "            word(self.withdrawals_count as u128),\n            word(self.prev_withdrawals_count as u128),",
     "public_values_are_eleven_words_with_the_first_eight_as_before"),
    ("слово времени блока не на последнем месте", PROTOCOL,
     "            word(self.withdrawals_count as u128),\n            word(self.block_timestamp as u128),",
     "            word(self.block_timestamp as u128),\n            word(self.withdrawals_count as u128),",
     "public_values_are_eleven_words_with_the_first_eight_as_before"),
    ("дайджест без маски 253 бита", PROTOCOL, "        digest[0] &= 0x1f;\n", "",
     "public_values_are_eleven_words_with_the_first_eight_as_before"),
    # --- генезис
    ("другой хеш генезиса", GENESIS,
     'b256!("c0284e91570e7f1314f6e4460a613225f49b46deeebd2be3c463fb1c1e0e7883")',
     'b256!("c0284e91570e7f1314f6e4460a613225f49b46deeebd2be3c463fb1c1e0e7884")',
     "genesis_constants_follow_from_the_bridge_account"),
    ("другой корень состояния генезиса", GENESIS,
     'b256!("01635824b7294796d2a6b1fd3485a3083ef24d56fa956ca9d72c3b3c71df252a")',
     'b256!("01635824b7294796d2a6b1fd3485a3083ef24d56fa956ca9d72c3b3c71df252b")',
     "genesis_constants_follow_from_the_bridge_account"),
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


def check_patterns() -> int:
    """Только сверка образцов с исходниками: каждый обязан встретиться ровно один раз."""
    bad = 0
    for name, path, old, new, _ in MUTATIONS:
        count = path.read_text().count(old)
        if count != 1 or old == new:
            bad += 1
            print(f"НЕ ПРИМЕНЕНА  {name}: образец найден {count} раз")
    names = [mutation[0] for mutation in MUTATIONS]
    for name in sorted(set(name for name in names if names.count(name) > 1)):
        bad += 1
        print(f"Название повторяется: {name}")
    print(f"Мутаций: {len(MUTATIONS)}, негодных образцов: {bad}")
    return 1 if bad else 0


def main() -> int:
    restore_interrupted()
    if sys.argv[1:] == ["--dry"]:
        return check_patterns()
    outcome, details = run_tests()
    if outcome != "ok":
        print("Тесты падают и без мутаций — проверять нечего:", *details, sep="\n  ")
        return 2
    only = sys.argv[1] if len(sys.argv) > 1 else None
    selected = [mutation for mutation in MUTATIONS if only is None or only in mutation[0]]
    lines, bad = [], 0
    for name, path, old, new, expected in selected:
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
    summary = f"Мутаций: {len(selected)}, не убито ожидаемым тестом: {bad}"
    print("\n" + summary)
    if only is not None:
        print("Прогон частичный: отчёт не перезаписан.")
        return 1 if bad else 0
    REPORT.write_text(
        f"Проверка тестов мутациями, {datetime.date.today().isoformat()}\n"
        "Команда: python3 zkvm-evm/scenario/mutation-check.py\n"
        "В скобках — тест, который обязан убить мутацию, и все упавшие тесты.\n\n"
        + "\n".join(lines) + "\n\n" + summary + "\n"
    )
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
