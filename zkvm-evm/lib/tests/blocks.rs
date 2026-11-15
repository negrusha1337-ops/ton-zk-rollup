//! Тесты батча EVM протокола версии 2 на настоящих блоках узла Reth.
//!
//! Фикстуры (`fixtures/evm_batches/reth/`) пишет `zkvm-evm/scenario/reth-scenario.mjs`:
//! `block-N.bin` — вход батча, `block-N.json` — отчёт хоста (публичные значения из zkVM),
//! `expected.json` — цепочка со слов узла и сценария (хеши блоков, очередь L1, логи моста), то
//! есть независимо от проверяемой программы. Ключи счетов сценария одноразовые, поэтому тесты
//! ничего не подписывают от их имени: случаи, которым нужен свой счёт, «подсаживают» его в
//! состояние родителя (`plant`) и приводят заголовки в соответствие.
use std::{collections::BTreeSet, fs, path::PathBuf};

use alloy_consensus::{
    proofs::{calculate_transaction_root, calculate_withdrawals_root},
    Header, Signed, TxEip1559, TxEip2930, TxEip4844, TxEip7702, TxLegacy,
};
use alloy_eips::eip4895::{Withdrawal, Withdrawals};
use alloy_primitives::{keccak256, Address, Bytes, Signature, TxKind, B256, U256};
use alloy_trie::{HashBuilder, Nibbles, EMPTY_ROOT_HASH};
use k256::ecdsa::SigningKey;
use reth_trie::TrieAccount;
use revm::state::Bytecode;
use rollup_evm::{
    apply_evm_batch, block_data_chunks, chain_config, genesis_header, process_evm_batch,
    protocol::{batch_data_hash, deposit_hash, forced_transaction_hash},
    BatchOutcome, Deposit, EvmBatchError, EvmBatchInput, ForcedOutcome, FrontierError, Hash, InvalidReason,
    PublicValues, QueueItem, SkipReason, WithdrawalLeaf, WithdrawalTree, BRIDGE_ADDRESS, BRIDGE_CODE,
    BRIDGE_CODE_HASH, GAS_LIMIT, GENESIS_HASH, MAX_BATCH_QUEUE_ITEMS, MAX_DATA_CHUNK_BYTES, MAX_WITHDRAWALS,
    WITHDRAWAL_TREE_DEPTH,
};
use rsp_mpt::{MptNode, MptNodeData};
use rsp_primitives::genesis::Genesis;
use serde_json::Value;

mod common;
use common::{address_of, bridge_call, encoded, key, sign, CHAIN_ID};

const NANOTON: u64 = 1_000_000_000;
const RECIPIENT: Hash = [0x5a; 32];

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/evm_batches/reth")
}

fn json(file: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(fixtures().join(file)).expect("нет фикстуры: запустите reth-scenario.mjs"))
        .unwrap()
}

fn expected() -> Value {
    json("expected.json")
}

/// Вход батча ровно как в фикстуре.
fn batch(block: u64) -> EvmBatchInput {
    let bytes = fs::read(fixtures().join(format!("block-{block}.bin")))
        .expect("нет фикстуры: запустите zkvm-evm/scenario/reth-scenario.mjs");
    bincode::deserialize(&bytes).expect("фикстура не разобрана")
}

fn outcome(block: u64) -> BatchOutcome {
    process_evm_batch(batch(block)).unwrap_or_else(|error| panic!("блок {block} отвергнут: {error:?}"))
}

fn block_count() -> u64 {
    expected()["blocks"].as_array().unwrap().len() as u64
}

fn hash(value: &Value) -> Hash {
    value.as_str().unwrap().parse::<B256>().unwrap().0
}

fn address(value: &Value) -> Address {
    value.as_str().unwrap().parse().unwrap()
}

/// Запись о блоке со слов узла.
fn node_block(block: u64) -> Value {
    expected()["blocks"][(block - 1) as usize].clone()
}

fn node_hash(block: u64) -> Hash {
    hash(&node_block(block)["hash"])
}

/// Вся очередь L1 в порядке постановки — со слов сценария.
fn l1_queue() -> Vec<QueueItem> {
    expected()["queue"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| match item["kind"].as_str().unwrap() {
            "deposit" => QueueItem::Deposit(Deposit {
                l2_recipient: address(&item["l2Recipient"]).into_array(),
                amount: item["amount"].as_str().unwrap().parse().unwrap(),
            }),
            "forced" => QueueItem::ForcedTransaction(item["bytes"].as_str().unwrap().parse::<Bytes>().unwrap().to_vec()),
            other => panic!("неизвестный вид элемента очереди: {other}"),
        })
        .collect()
}

/// Отрезок очереди блока: элементы (from, upTo].
fn segment(block: u64) -> (usize, usize) {
    let record = node_block(block);
    (record["queueProcessedFrom"].as_u64().unwrap() as usize, record["queueProcessedUpTo"].as_u64().unwrap() as usize)
}

/// Накопительный хеш очереди после первых `count` элементов — пересчёт по формулам контракта.
fn queue_hash_at(count: usize) -> Hash {
    l1_queue()[..count].iter().fold([0u8; 32], |hash, item| match item {
        QueueItem::Deposit(deposit) => deposit_hash(&hash, deposit),
        QueueItem::ForcedTransaction(bytes) => forced_transaction_hash(&hash, bytes),
    })
}

/// Все листья дерева выводов со слов узла (логи моста), с номером блока.
fn node_withdrawals() -> Vec<(u64, WithdrawalLeaf)> {
    expected()["withdrawals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|leaf| {
            let amount = leaf["amount"].as_str().unwrap().parse().unwrap();
            (leaf["block"].as_u64().unwrap(), WithdrawalLeaf { recipient_hash: hash(&leaf["recipientHash"]), amount })
        })
        .collect()
}

fn leaves_through(block: u64) -> Vec<WithdrawalLeaf> {
    node_withdrawals().into_iter().filter(|(at, _)| *at <= block).map(|(_, leaf)| leaf).collect()
}

/// Корень дерева выводов полным пересчётом — функцией игрушечного реестра, с которой сверен контракт.
fn full_root(leaves: &[WithdrawalLeaf]) -> Hash {
    let leaves: Vec<rollup_stf::WithdrawalLeaf> = leaves
        .iter()
        .map(|leaf| rollup_stf::WithdrawalLeaf { recipient_hash: leaf.recipient_hash, amount: leaf.amount })
        .collect();
    rollup_stf::withdrawals_root(&leaves)
}

/// Текст отказа: вид ошибки и сообщение библиотеки, от которой он пришёл.
fn refusal(result: Result<PublicValues, EvmBatchError>) -> String {
    format!("{:?}", result.expect_err("батч обязан быть отвергнут"))
}

/// Отказ обязан быть этого вида и прийти именно от этой проверки (по тексту её сообщения).
#[track_caller]
fn refused_by(result: Result<PublicValues, EvmBatchError>, variant: &str, message: &str) {
    let text = refusal(result);
    assert!(text.starts_with(variant) && text.contains(message), "ожидалось {variant}(…{message}…), получено {text}");
}

/// Перепубликовать блок после правки: иначе отказ пришёл бы от сверки данных, а не от той
/// проверки, на которую нацелен тест.
fn republish(input: &mut EvmBatchInput) {
    input.data_chunks = block_data_chunks(&input.block.current_block);
}

/// Блок с изменённым заголовком.
fn with_block_header(block: u64, change: impl FnOnce(&mut Header)) -> EvmBatchInput {
    let mut input = batch(block);
    change(&mut input.block.current_block.header);
    republish(&mut input);
    input
}

/// Блок с изменённым заголовком родителя; блок ссылается уже на изменённого.
fn with_parent_header(block: u64, change: impl FnOnce(&mut Header)) -> EvmBatchInput {
    let mut input = batch(block);
    change(&mut input.block.ancestor_headers[0]);
    input.block.current_block.header.parent_hash = input.block.ancestor_headers[0].hash_slow();
    republish(&mut input);
    input
}

/// Блок с изменёнными транзакциями: корень транзакций в заголовке приведён в соответствие, так
/// что отказ может прийти только от исполнения, а не от сверки тела с заголовком.
fn with_transactions(block: u64, change: impl FnOnce(&mut Vec<reth_ethereum_primitives::TransactionSigned>)) -> EvmBatchInput {
    let mut input = batch(block);
    change(&mut input.block.current_block.body.transactions);
    input.block.current_block.header.transactions_root =
        calculate_transaction_root(&input.block.current_block.body.transactions);
    republish(&mut input);
    input
}

/// Привести заголовки в соответствие изменённому состоянию родителя: корень состояния родителя
/// и ссылка блока на родителя.
fn reseal_parent(input: &mut EvmBatchInput) {
    input.block.ancestor_headers[0].state_root = input.block.parent_state.state_trie.hash();
    input.block.current_block.header.parent_hash = input.block.ancestor_headers[0].hash_slow();
    republish(input);
}

/// Корень состояния блока после правки состояния родителя. Его называет сама программа в отказе
/// (вычисленный исполнением); тесты, которые этим пользуются, проверяют не корень, а то, что
/// происходит ПОСЛЕ успешного исполнения либо до него.
fn settle_state_root(mut input: EvmBatchInput) -> EvmBatchInput {
    if let Err(EvmBatchError::MismatchedStateRoot { computed, .. }) = process_evm_batch(input.clone()) {
        input.block.current_block.header.state_root = B256::from(computed);
        republish(&mut input);
    }
    input
}

/// Тестовый ключ, чьему счёту есть место в раскрытой части дерева состояния родителя: путь к
/// нему не уходит в нераскрытый узел, и счёта там нет.
fn free_key(input: &EvmBatchInput) -> SigningKey {
    (1u8..=255)
        .map(key)
        .find(|candidate| {
            let path = keccak256(address_of(candidate));
            matches!(input.block.parent_state.state_trie.get(path.as_slice()), Ok(None))
        })
        .expect("в раскрытой части дерева есть свободное место")
}

/// «Подсадить» счёт в состояние родителя и привести заголовки в соответствие.
fn plant(input: &mut EvmBatchInput, address: Address, account: TrieAccount) {
    input.block.parent_state.state_trie.insert_rlp(keccak256(address).as_slice(), account).unwrap();
    reseal_parent(input);
}

fn plain_account(nonce: u64, nanotons: u64) -> TrieAccount {
    TrieAccount {
        nonce,
        balance: U256::from(nanotons) * U256::from(NANOTON),
        storage_root: EMPTY_ROOT_HASH,
        code_hash: alloy_primitives::KECCAK256_EMPTY,
    }
}

fn signature() -> Signature {
    Signature::new(U256::from(1u8), U256::from(1u8), false)
}

fn forced_items(input: &EvmBatchInput) -> Vec<Vec<u8>> {
    input
        .queue_items
        .iter()
        .filter_map(|item| match item {
            QueueItem::ForcedTransaction(bytes) => Some(bytes.clone()),
            QueueItem::Deposit(_) => None,
        })
        .collect()
}

// ---------------------------------------------------------------- честная цепочка

#[test]
fn every_block_gives_the_words_the_node_and_the_contract_expect() {
    let mut previous: Option<PublicValues> = None;
    for block in 1..=block_count() {
        let input = batch(block);
        let data_hash = batch_data_hash(&input.data_chunks).unwrap();
        let record = node_block(block);
        let (from, up_to) = segment(block);
        assert_eq!(input.queue_items, l1_queue()[from..up_to], "блок {block}: отрезок очереди");
        let values = apply_evm_batch(input).unwrap();

        assert_eq!(values.chain_id, CHAIN_ID);
        // Слова состояния — хеши заголовков родителя и блока со слов узла.
        let parent = if block == 1 { GENESIS_HASH.0 } else { node_hash(block - 1) };
        assert_eq!(values.prev_state_root, parent, "блок {block}");
        assert_eq!(values.prev_state_root, hash(&record["parentHash"]));
        assert_eq!(values.new_state_root, node_hash(block), "блок {block}");
        assert_ne!(values.batch_hash, [0u8; 32]);
        assert_eq!(values.batch_hash, data_hash);
        // Очередь L1: хеши в прежней отметке и в заявленной точке — пересчётом по всей очереди.
        assert_eq!(values.prev_deposit_hash, queue_hash_at(from), "блок {block}");
        assert_eq!(values.new_deposit_hash, queue_hash_at(up_to), "блок {block}");
        // Дерево выводов: корень и счётчик до и после — полным пересчётом по логам моста у узла.
        let before = leaves_through(block - 1);
        let after = leaves_through(block);
        assert_eq!(values.prev_withdrawals_count, before.len() as u64, "блок {block}");
        assert_eq!(values.withdrawals_count, after.len() as u64, "блок {block}");
        assert_eq!(values.prev_withdrawals_root, full_root(&before), "блок {block}");
        assert_eq!(values.withdrawals_root, full_root(&after), "блок {block}");
        assert_eq!(values.withdrawals_root, hash(&record["withdrawalsRoot"]));
        assert_eq!(values.block_timestamp, record["timestamp"].as_u64().unwrap(), "блок {block}");
        // Каждый блок продолжает предыдущий по всем парным словам.
        if let Some(previous) = &previous {
            assert_eq!(values.prev_state_root, previous.new_state_root);
            assert_eq!(values.prev_withdrawals_root, previous.withdrawals_root);
            assert_eq!(values.prev_withdrawals_count, previous.withdrawals_count);
            assert_eq!(values.prev_deposit_hash, previous.new_deposit_hash);
            assert!(values.block_timestamp > previous.block_timestamp);
        }
        previous = Some(values);
    }
}

#[test]
fn scenario_covers_what_the_tests_rely_on() {
    // Свойства цепочки, без которых тесты ниже проверяли бы не то.
    let queue = l1_queue();
    // Блок 1: родитель — генезис, отрезок короче очереди (N < head).
    assert_eq!(segment(1), (0, 1));
    assert_eq!(node_block(1)["headAtBatch"].as_u64().unwrap(), 2);
    assert_eq!(batch(1).block.ancestor_headers[0], genesis_header());
    // Блок 3: прежние корень и счётчик выводов ненулевые (урок 3-Т1), хеш очереди тоже.
    let third = outcome(3).values;
    assert_ne!(third.prev_withdrawals_root, [0u8; 32]);
    assert_eq!(third.prev_withdrawals_count, 2);
    assert_ne!(third.prev_deposit_hash, [0u8; 32]);
    // Блоки 4–6: отрезок пуст при непустой прежней очереди (N == processed == head).
    for block in [4, 5, 6] {
        let (from, up_to) = segment(block);
        assert!(from == up_to && from > 0);
        let values = outcome(block).values;
        assert_eq!(values.prev_deposit_hash, values.new_deposit_hash);
        assert_ne!(values.new_deposit_hash, [0u8; 32]);
    }
    // Блоки 7–10 и 12: отрезок ровно в предел.
    for block in [7, 8, 9, 10, 12] {
        let (from, up_to) = segment(block);
        assert_eq!(up_to - from, MAX_BATCH_QUEUE_ITEMS, "блок {block}");
    }
    assert!(queue[segment(9).0..segment(9).1].iter().all(|item| matches!(item, QueueItem::Deposit(_))));
    assert_eq!(batch(9).block.current_block.body.withdrawals.as_ref().unwrap().len(), MAX_BATCH_QUEUE_ITEMS);
    // Получатель чаевых — настоящий адрес.
    assert_ne!(batch(2).block.current_block.header.beneficiary, Address::ZERO);
    assert_eq!(batch(2).block.current_block.header.beneficiary, address(&expected()["feeRecipient"]));
}

#[test]
fn forced_transactions_end_up_as_the_scenario_says() {
    // Судьба каждой принудительной транзакции — со слов программы против сценария, который
    // строил элементы очереди под конкретную причину.
    let queue = expected()["queue"].as_array().unwrap().clone();
    let mut seen = BTreeSet::new();
    let mut included = 0;
    for block in 1..=block_count() {
        let (from, up_to) = segment(block);
        let expected: Vec<String> = queue[from..up_to]
            .iter()
            .filter(|item| item["kind"] == "forced")
            .map(|item| match item["outcome"].as_str().unwrap() {
                "included" => "Included".to_string(),
                skipped => skipped.to_string(),
            })
            .collect();
        let input = batch(block);
        let transactions: Vec<Vec<u8>> = input.block.current_block.body.transactions.iter().map(encoded).collect();
        let forced = forced_items(&input);
        let outcome = process_evm_batch(input).unwrap();
        let actual: Vec<String> = outcome.forced.iter().map(|outcome| format!("{outcome:?}")).collect();
        assert_eq!(actual, expected, "блок {block}");
        // Включённые стоят в начале блока в порядке очереди, байт в байт.
        let in_block: Vec<&Vec<u8>> = forced
            .iter()
            .zip(&outcome.forced)
            .filter(|(_, outcome)| **outcome == ForcedOutcome::Included)
            .map(|(bytes, _)| bytes)
            .collect();
        assert!(in_block.len() <= transactions.len());
        for (index, bytes) in in_block.iter().enumerate() {
            assert_eq!(&transactions[index], *bytes, "блок {block}, принудительная {index}");
        }
        included += in_block.len();
        seen.extend(actual);
    }
    assert_eq!(included, 4 + MAX_BATCH_QUEUE_ITEMS);
    // Причины, достижимые на настоящем узле: по каждой есть элемент очереди.
    let required = [
        "Included",
        "Skipped(TooLong)",
        "Skipped(Undecodable)",
        "Skipped(UnsupportedType)",
        "Skipped(MissingChainId)",
        "Skipped(ForeignChainId)",
        "Skipped(Create)",
        "Skipped(NotBridgeCall)",
        "Skipped(GasLimitAboveCap)",
        "Skipped(Signature)",
        "Skipped(Invalid(NonceTooLow))",
        "Skipped(Invalid(NonceTooHigh))",
        "Skipped(Invalid(NonceOverflow))",
        "Skipped(Invalid(LackOfFunds))",
        "Skipped(Invalid(PaymentOverflow))",
        "Skipped(Invalid(GasPriceBelowBaseFee))",
        "Skipped(Invalid(PriorityFeeAboveMaxFee))",
        "Skipped(Invalid(IntrinsicGas))",
    ];
    for reason in required {
        assert!(seen.contains(reason), "в цепочке нет случая {reason}");
    }
}

#[test]
fn duplicate_of_an_included_forced_transaction_is_skipped() {
    // В очереди блока 2 одна и та же транзакция стоит дважды: первая включена, вторая — уже
    // с использованным nonce.
    let input = batch(2);
    let forced = forced_items(&input);
    let outcome = process_evm_batch(input).unwrap();
    let first = outcome.forced.iter().position(|outcome| *outcome == ForcedOutcome::Included).unwrap();
    let duplicate = forced.iter().enumerate().position(|(index, bytes)| index != first && *bytes == forced[first]).unwrap();
    assert!(duplicate > first);
    assert_eq!(outcome.forced[duplicate], ForcedOutcome::Skipped(SkipReason::Invalid(InvalidReason::NonceTooLow)));
}

#[test]
fn refused_forced_transactions_leave_no_trace_in_the_state() {
    // Спайк 3. Блоки 8, 10, 11 и 12 — без транзакций и зачислений, в очереди только пропущенные
    // принудительные (в блоке 8 все 32 дошли до revm и отвергнуты им). Корень состояния у узла
    // после такого блока — тот же, что до него, и программа с ним согласна: отказ исполнения не
    // оставляет следа ни в nonce, ни в балансе, ни в «тронутых» счетах.
    for block in [8u64, 10, 11, 12] {
        let input = batch(block);
        assert!(input.block.current_block.body.transactions.is_empty());
        assert!(!forced_items(&input).is_empty());
        let parent_root = input.block.ancestor_headers[0].state_root;
        assert_eq!(input.block.current_block.header.state_root, parent_root, "блок {block}: корень со слов узла");
        assert_eq!(parent_root.0, hash(&node_block(block - 1)["stateRoot"]));
        let outcome = process_evm_batch(input).unwrap();
        assert!(outcome.forced.iter().all(|outcome| matches!(outcome, ForcedOutcome::Skipped(_))));
        assert_eq!(outcome.values.new_state_root, node_hash(block));
    }
    let revm_refused = outcome(8).forced;
    assert_eq!(revm_refused.len(), MAX_BATCH_QUEUE_ITEMS);
    assert!(revm_refused.iter().all(|outcome| *outcome == ForcedOutcome::Skipped(SkipReason::Invalid(InvalidReason::NonceTooHigh))));
    // Блок 12: элементы наибольшей длины, какую контракт ставит в очередь (64 ячейки по 127 байт).
    let longest = batch(12);
    assert!(forced_items(&longest).iter().all(|bytes| bytes.len() == 64 * 127));
    assert!(outcome(12).forced.iter().all(|outcome| *outcome == ForcedOutcome::Skipped(SkipReason::TooLong)));
    // Блок 3: пропущенные вперемешку с включёнными и с транзакциями секвенсора; корень состояния
    // со слов узла, который пропущенных транзакций не видел вовсе.
    assert_eq!(outcome(3).values.new_state_root, node_hash(3));
}

#[test]
fn zkvm_reports_match_the_current_code() {
    // Отчёт хоста записан после сверки публичных значений zkVM с нативным расчётом. Если
    // библиотека с тех пор изменилась так, что значения другие, фраза «zkVM совпал» устарела.
    for block in 1..=block_count() {
        let report = json(&format!("block-{block}.json"));
        assert!(report["zkvmCycles"].as_u64().unwrap() > 0, "блок {block}: в zkVM не исполнялся");
        let reported = report["publicValuesBytes"].as_str().unwrap().parse::<Bytes>().unwrap();
        assert_eq!(reported.len(), 352);
        let current = apply_evm_batch(batch(block)).unwrap().to_bytes();
        assert_eq!(reported.as_ref(), current.as_slice(), "блок {block}");
    }
}

#[test]
fn chain_rules_in_the_program_are_those_the_chain_was_built_with() {
    // Во входе блока лежит конфигурация из genesis.json сценария (её туда кладёт rsp). Программа
    // это поле не читает, но зашитые правила обязаны совпадать с ней поле в поле.
    assert_eq!(batch(2).block.genesis, Genesis::Custom(chain_config(CHAIN_ID)));
}

#[test]
fn genesis_of_the_chain_is_the_protocol_constant() {
    // Узел, получив генезис сценария, называет тот же хеш заголовка, что посчитан в библиотеке
    // из одного счёта моста; первый блок продолжает именно его.
    let expected = expected();
    assert_eq!(hash(&expected["genesisHash"]), GENESIS_HASH.0);
    assert_eq!(hash(&expected["genesisStateRoot"]), rollup_evm::GENESIS_STATE_ROOT.0);
    assert_eq!(genesis_header().hash_slow(), GENESIS_HASH);
    assert_eq!(batch(1).block.current_block.header.parent_hash, GENESIS_HASH);
    assert_eq!(outcome(1).values.prev_state_root, GENESIS_HASH.0);
    assert_eq!(expected["bridge"]["code"].as_str().unwrap().parse::<Bytes>().unwrap().as_ref(), BRIDGE_CODE);
    assert_eq!(hash(&expected["bridge"]["codeHash"]), BRIDGE_CODE_HASH.0);
}

// ---------------------------------------------------------------- принудительные транзакции: ошибки батча

#[test]
fn valid_forced_transaction_left_out_of_the_block_is_an_error() {
    // Блок 2: первая транзакция блока — принудительный вывод из очереди. Секвенсор её выбросил.
    let honest = batch(2);
    assert_eq!(encoded(&honest.block.current_block.body.transactions[0]), forced_items(&honest)[0]);
    let censored = with_transactions(2, |transactions| {
        transactions.remove(0);
    });
    assert_eq!(apply_evm_batch(censored), Err(EvmBatchError::ForcedTransactionOmitted(0)));

    // Блок вовсе без транзакций.
    let empty = with_transactions(2, Vec::clear);
    assert_eq!(apply_evm_batch(empty), Err(EvmBatchError::ForcedTransactionOmitted(0)));

    // Блок 7: выброшена последняя из тридцати двух — блок кончился раньше очереди.
    let last = MAX_BATCH_QUEUE_ITEMS - 1;
    let truncated = with_transactions(7, |transactions| {
        transactions.pop();
    });
    assert_eq!(apply_evm_batch(truncated), Err(EvmBatchError::ForcedTransactionOmitted(last)));
}

#[test]
fn valid_forced_transaction_out_of_its_place_is_an_error() {
    // Принудительные обязаны идти РАНЬШЕ транзакций секвенсора: в блоке 2 секвенсор поставил
    // свой перевод перед принудительным выводом.
    let behind = with_transactions(2, |transactions| transactions.swap(0, 1));
    assert_eq!(apply_evm_batch(behind), Err(EvmBatchError::ForcedTransactionOmitted(0)));

    // И в порядке очереди: в блоке 3 две включённые принудительные переставлены. Первая по
    // очереди действительна, а на её месте стоит вторая.
    let honest = batch(3);
    let outcomes = process_evm_batch(honest.clone()).unwrap().forced;
    let first = outcomes.iter().position(|outcome| *outcome == ForcedOutcome::Included).unwrap();
    assert_eq!(encoded(&honest.block.current_block.body.transactions[0]), forced_items(&honest)[first]);
    let reordered = with_transactions(3, |transactions| transactions.swap(0, 1));
    assert_eq!(apply_evm_batch(reordered), Err(EvmBatchError::ForcedTransactionOmitted(first)));
}

#[test]
fn forced_transaction_cannot_be_dropped_from_the_queue_either() {
    // Секвенсор «не заметил» элемент очереди: блок честный, а отрезок во входе — без
    // принудительной транзакции. Блок исполняется (она идёт как транзакция секвенсора), но хеш
    // очереди — не тот, который подставит контракт.
    let honest = outcome(2).values;
    let mut input = batch(2);
    let position = input.queue_items.iter().position(|item| matches!(item, QueueItem::ForcedTransaction(_))).unwrap();
    input.queue_items.remove(position);
    let values = apply_evm_batch(input).unwrap();
    assert_ne!(values.new_deposit_hash, honest.new_deposit_hash);
    assert_eq!(PublicValues { new_deposit_hash: honest.new_deposit_hash, ..values }, honest);
}

#[test]
fn queue_segment_longer_than_the_limit_is_rejected() {
    let mut input = batch(10);
    assert_eq!(input.queue_items.len(), MAX_BATCH_QUEUE_ITEMS);
    input.queue_items.push(QueueItem::ForcedTransaction(vec![0xff]));
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::TooManyQueueItems(MAX_BATCH_QUEUE_ITEMS + 1)));
}

// ---------------------------------------------------------------- принудительные транзакции: отказ revm

/// Пустой блок 6 с одним элементом очереди — транзакцией тестового счёта; счёт подсажен в
/// состояние родителя (`account`) либо отсутствует (`None`).
fn refused_on_planted_account(
    account: Option<TrieAccount>,
    code: Option<Bytecode>,
    build: impl FnOnce(&mut TxEip1559),
) -> (BatchOutcome, EvmBatchInput) {
    let mut input = batch(6);
    assert!(input.block.current_block.body.transactions.is_empty() && input.queue_items.is_empty());
    let sender = free_key(&input);
    if let Some(account) = account {
        plant(&mut input, address_of(&sender), account);
    }
    if let Some(code) = code {
        input.block.bytecodes.push(code);
    }
    // Пустой блок состояние не меняет: корень после — корень родителя.
    input.block.current_block.header.state_root = input.block.ancestor_headers[0].state_root;
    let mut transaction = bridge_call(5, 50_000_000, RECIPIENT);
    build(&mut transaction);
    input.queue_items = vec![QueueItem::ForcedTransaction(encoded(&sign(&sender, transaction)))];
    republish(&mut input);
    let outcome = process_evm_batch(input.clone()).unwrap_or_else(|error| panic!("батч отвергнут: {error:?}"));
    (outcome, input)
}

#[test]
fn transaction_invalid_on_the_current_state_is_skipped_for_each_reason() {
    // Счёт с nonce 5 и одной монетой. Каждый случай — одна причина отказа revm; батч при этом
    // годен, а корень состояния блока — корень родителя (отказ следа не оставил).
    type Build = fn(&mut TxEip1559);
    let cases: Vec<(InvalidReason, Build)> = vec![
        (InvalidReason::NonceTooLow, |tx| tx.nonce = 4),
        (InvalidReason::NonceTooHigh, |tx| tx.nonce = 6),
        (InvalidReason::NonceOverflow, |tx| tx.nonce = u64::MAX),
        // Сумма больше баланса; и сумма по карману, а на газ уже не хватает.
        (InvalidReason::LackOfFunds, |tx| tx.value = U256::from(2 * NANOTON) * U256::from(NANOTON)),
        (InvalidReason::LackOfFunds, |tx| tx.value = U256::from(NANOTON) * U256::from(NANOTON)),
        (InvalidReason::PaymentOverflow, |tx| tx.value = U256::MAX),
        (InvalidReason::GasPriceBelowBaseFee, |tx| {
            tx.max_fee_per_gas = 1;
            tx.max_priority_fee_per_gas = 0;
        }),
        (InvalidReason::PriorityFeeAboveMaxFee, |tx| tx.max_priority_fee_per_gas = tx.max_fee_per_gas + 1),
        (InvalidReason::IntrinsicGas, |tx| tx.gas_limit = 21_000),
        (InvalidReason::IntrinsicGas, |tx| tx.gas_limit = 0),
    ];
    for (reason, build) in cases {
        let (outcome, input) = refused_on_planted_account(Some(plain_account(5, NANOTON)), None, build);
        assert_eq!(outcome.forced, [ForcedOutcome::Skipped(SkipReason::Invalid(reason))]);
        assert_eq!(outcome.values.new_state_root, input.block.current_block.header.hash_slow().0);
        assert!(outcome.withdrawals.is_empty());
    }
}

#[test]
fn transaction_valid_on_the_planted_state_must_be_in_the_block() {
    // Контроль к тесту выше: та же транзакция с верным nonce действительна — и тогда её
    // отсутствие в блоке уже не пропуск, а цензура. Блок 7 (его свидетель раскрывает счёт
    // моста): в очереди вместо его отрезка — одна транзакция подсаженного счёта, а блок
    // начинается с другой.
    let mut input = batch(7);
    let sender = free_key(&input);
    plant(&mut input, address_of(&sender), plain_account(5, NANOTON));
    let transaction = bridge_call(5, 50_000_000, RECIPIENT);
    input.queue_items = vec![QueueItem::ForcedTransaction(encoded(&sign(&sender, transaction.clone())))];
    assert_eq!(apply_evm_batch(input.clone()), Err(EvmBatchError::ForcedTransactionOmitted(0)));
    // С неверным nonce она же пропущена, и батч доходит до сверки итогов исполнения (очередь
    // другая, блок тот же — отказ уже не про цензуру).
    let mut stale = transaction;
    stale.nonce = 4;
    input.queue_items = vec![QueueItem::ForcedTransaction(encoded(&sign(&sender, stale)))];
    assert!(matches!(apply_evm_batch(input), Err(EvmBatchError::MismatchedStateRoot { .. })));
}

#[test]
fn sender_with_code_is_skipped() {
    // EIP-3607: у отправителя есть код. На настоящем узле недостижимо (нужен ключ к адресу
    // контракта), поэтому счёт с кодом подсажен; байткод лежит во входе, как положил бы хост.
    let code = Bytecode::new_raw(Bytes::from_static(&[0x60, 0x00, 0x00]));
    let account = TrieAccount { code_hash: code.hash_slow(), ..plain_account(5, NANOTON) };
    let (outcome, _) = refused_on_planted_account(Some(account), Some(code), |_| {});
    assert_eq!(outcome.forced, [ForcedOutcome::Skipped(SkipReason::Invalid(InvalidReason::SenderHasCode))]);
}

#[test]
fn sender_missing_from_the_state_is_skipped() {
    // Счёта нет, и свидетель это доказывает: нехватка баланса на нулевом счёте.
    let (outcome, _) = refused_on_planted_account(None, None, |tx| tx.nonce = 0);
    assert_eq!(outcome.forced, [ForcedOutcome::Skipped(SkipReason::Invalid(InvalidReason::LackOfFunds))]);
    // С ненулевым nonce отказ — по nonce: у отсутствующего счёта он ноль.
    let (outcome, _) = refused_on_planted_account(None, None, |tx| tx.nonce = 1);
    assert_eq!(outcome.forced, [ForcedOutcome::Skipped(SkipReason::Invalid(InvalidReason::NonceTooHigh))]);
}

/// Заменить узел на пути `nibbles` его дайджестом: дерево с тем же корнем, но с нераскрытым
/// местом. Возвращает `None`, если путь кончился раньше (ключа нет, скрывать нечего).
fn hide(node: &MptNode, nibbles: &[u8], depth: usize) -> Option<MptNode> {
    match node.as_data() {
        MptNodeData::Branch(children) => {
            let index = *nibbles.get(depth)? as usize;
            let child = children[index].as_ref()?;
            // Скрываем самый глубокий узел пути; если глубже скрывать нечего — этот потомок.
            let replacement = hide(child, nibbles, depth + 1)
                .unwrap_or_else(|| MptNode::from(MptNodeData::Digest(child.hash())));
            let mut children = children.clone();
            children[index] = Some(Box::new(replacement));
            Some(MptNode::from(MptNodeData::Branch(children)))
        }
        _ => None,
    }
}

#[test]
#[should_panic(expected = "NodeNotResolved")]
fn hidden_sender_account_is_not_an_absent_account() {
    // Блок 3: счёт B существует, блок его не трогает, его принудительные транзакции пропущены.
    // Путь к нему раскрыт дополнением свидетеля (`eth_getProof`). Если узел на этом пути
    // спрятать за дайджест (корень дерева тот же), программа не вправе счесть счёт пустым —
    // иначе секвенсор объявлял бы «отправителя нет» про кого угодно. Нераскрытый узел — отказ:
    // батч недоказуем.
    let mut input = batch(3);
    let other = address(&expected()["other"]);
    let path: Vec<u8> = keccak256(other).iter().flat_map(|byte| [byte >> 4, byte & 0x0f]).collect();
    let root = input.block.parent_state.state_trie.hash();
    assert!(input.block.parent_state.state_trie.get(keccak256(other).as_slice()).unwrap().is_some());
    let hidden = hide(&input.block.parent_state.state_trie, &path, 0).expect("путь к счёту B идёт через ветки");
    assert_eq!(hidden.hash(), root, "скрытие не меняет корень состояния");
    assert!(hidden.get(keccak256(other).as_slice()).is_err());
    input.block.parent_state.state_trie = hidden;
    let _ = apply_evm_batch(input);
}

// ---------------------------------------------------------------- депозиты и очередь L1

#[test]
fn deposit_credit_is_exactly_the_deposit() {
    // Блок 1 зачисляет депозит счёту A. Состояние после него — мост из генезиса и счёт A с
    // суммой депозита; корень такого дерева посчитан независимым построителем и равен корню
    // состояния блока со слов узла: зачислено тому и столько.
    let input = batch(1);
    let QueueItem::Deposit(deposit) = &input.queue_items[0] else { panic!("первый элемент очереди — депозит") };
    assert_eq!(Address::from(deposit.l2_recipient), address(&expected()["user"]));
    let bridge = TrieAccount { nonce: 1, balance: U256::ZERO, storage_root: EMPTY_ROOT_HASH, code_hash: BRIDGE_CODE_HASH };
    let credited = plain_account(0, u64::try_from(deposit.amount).unwrap());
    let mut leaves = vec![
        (keccak256(BRIDGE_ADDRESS), alloy_rlp::encode(bridge)),
        (keccak256(deposit.l2_recipient), alloy_rlp::encode(credited)),
    ];
    leaves.sort();
    let mut builder = HashBuilder::default();
    for (path, account) in &leaves {
        builder.add_leaf(Nibbles::unpack(path), account);
    }
    assert_eq!(builder.root(), input.block.current_block.header.state_root);
    assert_eq!(builder.root().0, hash(&node_block(1)["stateRoot"]));
    let values = apply_evm_batch(input.clone()).unwrap();
    assert_eq!(values.prev_deposit_hash, [0u8; 32]);
    assert_eq!(values.new_deposit_hash, deposit_hash(&[0u8; 32], deposit));
}

#[test]
fn credit_without_a_queue_item_is_rejected() {
    // Зачисление, которого нет в очереди L1, — монеты из воздуха.
    let mut input = batch(1);
    input.queue_items.clear();
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::DepositCountMismatch { block: 1, queue: 0 }));
    // Зачисление «за» принудительную транзакцию.
    let mut input = batch(1);
    input.queue_items = vec![QueueItem::ForcedTransaction(vec![1, 2, 3])];
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::DepositCountMismatch { block: 1, queue: 0 }));
}

#[test]
fn queue_item_without_a_credit_in_the_block_is_rejected() {
    let mut input = batch(6);
    input.queue_items = vec![QueueItem::Deposit(Deposit { l2_recipient: [7u8; 20], amount: 1_500_000_000 })];
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::DepositCountMismatch { block: 0, queue: 1 }));
}

#[test]
fn credit_must_be_the_deposit_from_the_queue() {
    // Очередь говорит одно, блок зачисляет другое.
    let mut more = batch(1);
    let QueueItem::Deposit(deposit) = &mut more.queue_items[0] else { panic!() };
    deposit.amount += 1;
    assert_eq!(apply_evm_batch(more), Err(EvmBatchError::DepositMismatch(0)));
    let mut other = batch(1);
    let QueueItem::Deposit(deposit) = &mut other.queue_items[0] else { panic!() };
    deposit.l2_recipient[0] ^= 1;
    assert_eq!(apply_evm_batch(other), Err(EvmBatchError::DepositMismatch(0)));

    // Блок зачисляет больше, чем в очереди: тело и корень зачислений в заголовке согласованы.
    let mut inflated = batch(1);
    let mut credits: Vec<Withdrawal> = inflated.block.current_block.body.withdrawals.clone().unwrap().0;
    credits[0].amount += 1;
    inflated.block.current_block.header.withdrawals_root = Some(calculate_withdrawals_root(&credits));
    inflated.block.current_block.body.withdrawals = Some(Withdrawals::new(credits));
    republish(&mut inflated);
    assert_eq!(apply_evm_batch(inflated), Err(EvmBatchError::DepositMismatch(0)));

    // Депозиты блока 9 в другом порядке — другая очередь.
    let mut swapped = batch(9);
    swapped.queue_items.swap(0, 1);
    assert_eq!(apply_evm_batch(swapped), Err(EvmBatchError::DepositMismatch(0)));
}

// ---------------------------------------------------------------- данные батча

#[test]
fn published_data_must_be_the_block() {
    let mut truncated = batch(2);
    truncated.data_chunks.last_mut().unwrap().pop();
    assert_eq!(apply_evm_batch(truncated), Err(EvmBatchError::DataMismatch));

    let mut empty = batch(2);
    empty.data_chunks.clear();
    assert_eq!(apply_evm_batch(empty), Err(EvmBatchError::DataMismatch));

    // Данные другого блока.
    let mut foreign = batch(2);
    foreign.data_chunks = batch(3).data_chunks;
    assert_eq!(apply_evm_batch(foreign), Err(EvmBatchError::DataMismatch));

    let mut oversized = batch(2);
    oversized.data_chunks = vec![vec![0u8; MAX_DATA_CHUNK_BYTES + 1]];
    assert_eq!(apply_evm_batch(oversized), Err(EvmBatchError::DataChunkTooLarge));
}

#[test]
fn batch_hash_commits_to_the_chunks_as_published() {
    // Контракт копит хеш тех порций, что реально опубликованы, а не «канонической» нарезки.
    let canonical = apply_evm_batch(batch(2)).unwrap();
    let mut input = batch(2);
    let whole = input.data_chunks.concat();
    input.data_chunks = vec![whole[..100].to_vec(), whole[100..].to_vec()];
    let expected = batch_data_hash(&input.data_chunks).unwrap();
    let values = apply_evm_batch(input).unwrap();
    assert_eq!(values.batch_hash, expected);
    assert_ne!(values.batch_hash, canonical.batch_hash);
    assert_eq!(PublicValues { batch_hash: canonical.batch_hash, ..values }, canonical);
}

// ---------------------------------------------------------------- дерево выводов

#[test]
fn withdrawals_are_the_bridge_logs_the_node_reports() {
    // Листья — со слов программы против логов моста у узла, по блокам и по порядку.
    for block in 1..=block_count() {
        let leaves: Vec<WithdrawalLeaf> =
            node_withdrawals().into_iter().filter(|(at, _)| *at == block).map(|(_, leaf)| leaf).collect();
        assert_eq!(outcome(block).withdrawals, leaves, "блок {block}");
    }
    // Блок 3 (по сценарию): принудительный вывод на минимум, затем два вывода одной транзакцией
    // из контракта L2 — четверть суммы и остаток. Откат моста, нехватка газа, вывод во
    // внутреннем откатившемся кадре, DELEGATECALL в мост и вызов не по форме листьев не дают.
    let third: Vec<u128> = outcome(3).withdrawals.iter().map(|leaf| leaf.amount).collect();
    assert_eq!(third, [50_000_000, 50_000_000, 150_000_000]);
    let transactions = node_block(3)["transactions"].as_array().unwrap().clone();
    let logs = |label: &str| {
        let transaction = transactions.iter().find(|tx| tx["label"].as_str().unwrap().contains(label)).unwrap();
        (transaction["status"].as_u64().unwrap(), transaction["bridgeLogs"].as_u64().unwrap())
    };
    assert_eq!(logs("два вывода из контракта"), (1, 2));
    assert_eq!(logs("откатившемся кадре"), (1, 0), "транзакция успешна, вывода нет");
    assert_eq!(logs("DELEGATECALL"), (1, 0), "лог записан с адреса вызывающего");
    assert_eq!(logs("мост откатывает"), (0, 0));
    assert_eq!(logs("нехватка газа"), (0, 0));
    assert_eq!(logs("31 байтом"), (0, 0));
    // Фронтир после блока — вход следующего.
    for block in 1..block_count() {
        let after = outcome(block);
        let next = batch(block + 1);
        assert_eq!(next.withdrawals_frontier, after.withdrawals_frontier, "блок {block}");
        assert_eq!(next.withdrawals_count, after.values.withdrawals_count);
    }
}

#[test]
fn garbage_in_the_frontier_of_the_input_is_rejected() {
    // У блока 3 в дереве два листа: значим только элемент на бите 1.
    let honest = batch(3);
    assert_eq!(honest.withdrawals_count, 2);
    for height in (0..WITHDRAWAL_TREE_DEPTH).filter(|height| *height != 1) {
        let mut input = batch(3);
        input.withdrawals_frontier[height][7] = 1;
        assert_eq!(
            apply_evm_batch(input),
            Err(EvmBatchError::WithdrawalFrontier(FrontierError::NonCanonical(height)))
        );
    }
    let mut out_of_range = batch(3);
    out_of_range.withdrawals_count = MAX_WITHDRAWALS + 1;
    assert_eq!(apply_evm_batch(out_of_range), Err(EvmBatchError::WithdrawalFrontier(FrontierError::CountOutOfRange)));
}

#[test]
fn forged_previous_tree_gives_words_the_contract_will_not_accept() {
    let honest = outcome(3).values;
    // Другой элемент фронтира на значимом бите — другой прежний корень.
    let mut other_frontier = batch(3);
    other_frontier.withdrawals_frontier[1][0] ^= 1;
    let values = apply_evm_batch(other_frontier).unwrap();
    assert_ne!(values.prev_withdrawals_root, honest.prev_withdrawals_root);

    // Подмена счётчика при том же корне (раздел 4): «счётчик 4, на месте 2 — корень левого
    // поддерева высоты 2». Прежний корень — тот же; отличает подделку только слово счётчика.
    let tree = WithdrawalTree::from_input(batch(3).withdrawals_frontier, 2).unwrap();
    let empty_level_one = rollup_evm::protocol::sha256(&[&[0u8; 32], &[0u8; 32]]);
    let mut forged = batch(3);
    forged.withdrawals_frontier = [[0u8; 32]; WITHDRAWAL_TREE_DEPTH];
    forged.withdrawals_frontier[2] = rollup_evm::protocol::sha256(&[&tree.frontier()[1], &empty_level_one]);
    forged.withdrawals_count = 4;
    let values = apply_evm_batch(forged).unwrap();
    assert_eq!(values.prev_withdrawals_root, honest.prev_withdrawals_root, "корень подделку не отличает");
    assert_eq!(values.prev_withdrawals_count, 4);
    assert_ne!(values.prev_withdrawals_count, honest.prev_withdrawals_count);
    assert_eq!(values.withdrawals_count, 4 + 3);
    assert_ne!(values.withdrawals_root, honest.withdrawals_root);
    assert_ne!(values.digest(), honest.digest());
}

#[test]
fn withdrawal_into_a_full_tree_is_rejected() {
    // Счётчик у предела: в блоке 2 два вывода.
    let full_frontier = [[9u8; 32]; WITHDRAWAL_TREE_DEPTH];
    let mut full = batch(2);
    full.withdrawals_frontier = full_frontier;
    full.withdrawals_count = MAX_WITHDRAWALS;
    assert_eq!(apply_evm_batch(full), Err(EvmBatchError::TooManyWithdrawals));
    // Место есть для одного листа из двух.
    let mut one_left = batch(2);
    one_left.withdrawals_frontier = full_frontier;
    one_left.withdrawals_frontier[0] = [0u8; 32];
    one_left.withdrawals_count = MAX_WITHDRAWALS - 1;
    assert_eq!(apply_evm_batch(one_left), Err(EvmBatchError::TooManyWithdrawals));
    // Блок без выводов полному дереву не мешает.
    let mut untouched = batch(4);
    untouched.withdrawals_frontier = full_frontier;
    untouched.withdrawals_count = MAX_WITHDRAWALS;
    let values = apply_evm_batch(untouched).unwrap();
    assert_eq!((values.prev_withdrawals_count, values.withdrawals_count), (MAX_WITHDRAWALS, MAX_WITHDRAWALS));
    assert_eq!(values.prev_withdrawals_root, values.withdrawals_root);
}

// ---------------------------------------------------------------- мост

/// Блок с другим кодом по адресу моста в состоянии родителя. Код ведёт себя как код моста
/// (за концом дописан недостижимый байт), но хеш у него другой.
fn with_foreign_bridge_code(block: u64) -> EvmBatchInput {
    let mut input = batch(block);
    let mut code = BRIDGE_CODE.to_vec();
    code.push(0x00);
    let code = Bytecode::new_raw(Bytes::from(code));
    let path = keccak256(BRIDGE_ADDRESS);
    let mut account: TrieAccount = input
        .block
        .parent_state
        .state_trie
        .get_rlp(path.as_slice())
        .unwrap()
        .expect("счёт моста есть в свидетеле: блок его вызывает");
    assert_eq!(account.code_hash, BRIDGE_CODE_HASH, "в честной цепочке по адресу моста — код моста");
    account.code_hash = code.hash_slow();
    assert_ne!(account.code_hash, BRIDGE_CODE_HASH);
    input.block.bytecodes.push(code);
    plant(&mut input, BRIDGE_ADDRESS, account);
    settle_state_root(input)
}

#[test]
fn bridge_log_counts_only_if_the_bridge_code_is_the_protocol_one() {
    // Цепочка, где по адресу моста лежит другой код (генезис не тот): логи «моста» в блоке 2
    // есть, но обязательством вывода они не являются.
    assert!(!outcome(2).withdrawals.is_empty());
    assert_eq!(apply_evm_batch(with_foreign_bridge_code(2)), Err(EvmBatchError::BridgeCodeMismatch));
    assert_eq!(apply_evm_batch(with_foreign_bridge_code(7)), Err(EvmBatchError::BridgeCodeMismatch));
}

#[test]
fn bridge_code_is_checked_only_when_the_block_has_bridge_logs() {
    // Контроль: блоки без логов моста проходят, каким бы ни был (и был ли раскрыт) счёт моста в
    // свидетеле, — проверка кода условная. Без лога нет вывода, а значит и обязательства.
    for block in [4u64, 6] {
        let input = batch(block);
        let revealed = input.block.parent_state.state_trie.get(keccak256(BRIDGE_ADDRESS).as_slice());
        let outcome = process_evm_batch(input.clone()).unwrap();
        assert!(outcome.withdrawals.is_empty(), "блок {block}");
        assert_eq!(outcome.values.withdrawals_root, outcome.values.prev_withdrawals_root);
        // Если счёт моста всё же раскрыт — подменяем код и убеждаемся, что блок без логов проходит.
        if revealed.is_ok() {
            let foreign = with_foreign_bridge_code(block);
            assert!(process_evm_batch(foreign).unwrap().withdrawals.is_empty());
        }
    }
}

// ---------------------------------------------------------------- правила цепочки

#[test]
fn chain_id_is_bound_by_transaction_signatures() {
    // С другим chainId принудительный вывод из очереди пропущен как чужой, а в блоке он остался
    // — и как транзакция секвенсора отвергнут уже revm.
    let mut input = batch(2);
    input.chain_id += 1;
    refused_by(apply_evm_batch(input), "Execution", "invalid chain ID");
}

#[test]
fn chain_ids_with_relaxed_rules_in_rsp_are_rejected() {
    for linea in [59144, 59141, 59140] {
        let mut input = batch(2);
        input.chain_id = linea;
        assert_eq!(apply_evm_batch(input), Err(EvmBatchError::UnsupportedChainId(linea)));
    }
}

#[test]
fn chain_rules_come_from_the_program_not_from_the_input() {
    let honest = apply_evm_batch(batch(2)).unwrap();
    let mut input = batch(2);
    input.block.genesis = Genesis::Mainnet;
    input.block.custom_beneficiary = Some(Address::from([9u8; 20]));
    input.block.opcode_tracking = true;
    assert_eq!(apply_evm_batch(input).unwrap(), honest);
}

#[test]
fn transaction_without_chain_id_is_rejected() {
    let mut input = batch(2);
    let index = input.block.current_block.body.transactions.len();
    let unprotected = TxLegacy {
        chain_id: None,
        nonce: 0,
        gas_price: 1_000_000_000,
        gas_limit: 21_000,
        to: TxKind::Call(Address::from([1u8; 20])),
        value: U256::ZERO,
        input: Bytes::new(),
    };
    input.block.current_block.body.transactions.push(Signed::new_unhashed(unprotected, signature()).into());
    republish(&mut input);
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::UnprotectedTransaction(index)));
}

#[test]
fn transaction_with_an_unrecoverable_signature_is_rejected() {
    let mut input = batch(2);
    let transaction = TxLegacy {
        chain_id: Some(CHAIN_ID),
        nonce: 0,
        gas_price: 1_000_000_000,
        gas_limit: 21_000,
        to: TxKind::Call(Address::from([1u8; 20])),
        value: U256::ZERO,
        input: Bytes::new(),
    };
    let zero = Signature::new(U256::ZERO, U256::ZERO, false);
    input.block.current_block.body.transactions.push(Signed::new_unhashed(transaction, zero).into());
    republish(&mut input);
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::SignatureRecovery));
}

#[test]
fn blobs_are_rejected() {
    // Расход blob-газа в заголовке с транзакциями не сверяется: RSP не вызывает эту проверку Reth.
    let header = with_block_header(2, |header| header.blob_gas_used = Some(131_072));
    assert_eq!(apply_evm_batch(header), Err(EvmBatchError::BlobsNotSupported));

    let mut input = batch(2);
    let blob = TxEip4844 {
        chain_id: CHAIN_ID,
        gas_limit: 21_000,
        to: Address::from([1u8; 20]),
        blob_versioned_hashes: vec![B256::repeat_byte(1)],
        ..Default::default()
    };
    input.block.current_block.body.transactions.push(Signed::new_unhashed(blob, signature()).into());
    republish(&mut input);
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::BlobsNotSupported));

    // Избыток blob-газа правила считают от родителя, то есть в итоге от генезиса.
    let excess = with_block_header(2, |header| header.excess_blob_gas = Some(131_072));
    assert_eq!(apply_evm_batch(excess), Err(EvmBatchError::BlobsNotSupported));
    let missing = with_block_header(2, |header| header.excess_blob_gas = None);
    assert_eq!(apply_evm_batch(missing), Err(EvmBatchError::BlobsNotSupported));
}

#[test]
fn transaction_with_delegation_is_rejected() {
    // EIP-7702 правила Cancun отвергают и сами, но на отсутствии делегирований держится
    // пересборка байткода — запрет явный и от хардфорка не зависит.
    let mut input = batch(2);
    let index = input.block.current_block.body.transactions.len();
    let delegation = TxEip7702 {
        chain_id: CHAIN_ID,
        gas_limit: 21_000,
        to: Address::from([1u8; 20]),
        ..Default::default()
    };
    input.block.current_block.body.transactions.push(Signed::new_unhashed(delegation, signature()).into());
    republish(&mut input);
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::UnsupportedTransactionType(index)));
}

#[test]
fn ordinary_transaction_types_pass_the_type_check() {
    // Обычная, EIP-2930 и EIP-1559 — допустимые типы: транзакция с негодной подписью обязана
    // дойти до восстановления отправителя, а не быть отвергнутой по типу.
    let zero = Signature::new(U256::ZERO, U256::ZERO, false);
    let to = TxKind::Call(Address::from([1u8; 20]));
    let candidates: Vec<reth_ethereum_primitives::TransactionSigned> = vec![
        Signed::new_unhashed(TxLegacy { chain_id: Some(CHAIN_ID), gas_limit: 21_000, to, ..Default::default() }, zero)
            .into(),
        Signed::new_unhashed(TxEip2930 { chain_id: CHAIN_ID, gas_limit: 21_000, to, ..Default::default() }, zero)
            .into(),
        Signed::new_unhashed(TxEip1559 { chain_id: CHAIN_ID, gas_limit: 21_000, to, ..Default::default() }, zero)
            .into(),
    ];
    for transaction in candidates {
        let mut input = batch(2);
        input.block.current_block.body.transactions.push(transaction);
        republish(&mut input);
        assert_eq!(apply_evm_batch(input), Err(EvmBatchError::SignatureRecovery));
    }
    // И в самой цепочке все три типа есть среди исполненных транзакций.
    let types: BTreeSet<u8> = [2u64, 3]
        .iter()
        .flat_map(|block| batch(*block).block.current_block.body.transactions)
        .map(|transaction| transaction.tx_type() as u8)
        .collect();
    assert_eq!(types, BTreeSet::from([0, 1, 2]));
}

#[test]
fn trailing_bytes_in_the_input_do_not_change_the_result() {
    // Гостевая программа разбирает вход через bincode, а он допускает хвост после структуры.
    let mut bytes = fs::read(fixtures().join("block-2.bin")).unwrap();
    let honest = apply_evm_batch(bincode::deserialize(&bytes).unwrap()).unwrap();
    bytes.extend_from_slice(&[0xff; 100]);
    assert_eq!(apply_evm_batch(bincode::deserialize(&bytes).unwrap()).unwrap(), honest);
}

// ---------------------------------------------------------------- заголовок, родитель, предки

#[test]
fn header_fields_left_to_the_builder_are_fixed_in_a_real_block() {
    // Каждое из этих значений узел Ethereum принял бы: правила цепочки их не закрепляют.
    let honest = batch(2).block.current_block.header;
    assert_eq!(honest.gas_limit, GAS_LIMIT);
    let cases: Vec<(&str, fn(&mut Header))> = vec![
        // Сползание лимита в допуске правил Ethereum (1/1024 от родителя).
        ("gas_limit", |header| header.gas_limit -= 1),
        ("gas_limit", |header| header.gas_limit += 1),
        ("mix_hash", |header| header.mix_hash = B256::repeat_byte(7)),
        ("extra_data", |header| header.extra_data = Bytes::from_static(b"x")),
        ("parent_beacon_block_root", |header| header.parent_beacon_block_root = Some(B256::repeat_byte(7))),
    ];
    for (field, change) in cases {
        assert_eq!(apply_evm_batch(with_block_header(2, change)), Err(EvmBatchError::HeaderPolicy(field)));
    }
    // Получатель чаевых свободен: правка этого поля до правил заголовка не доходит — блок
    // отвергается уже по корню состояния (чаевые ушли бы другому счёту).
    let other_recipient = with_block_header(2, |header| header.beneficiary = Address::repeat_byte(9));
    assert!(matches!(apply_evm_batch(other_recipient), Err(EvmBatchError::MismatchedStateRoot { .. })));
}

#[test]
fn block_timestamp_word_is_the_time_in_the_header() {
    for block in [1u64, 3] {
        let input = batch(block);
        let header_time = input.block.current_block.header.timestamp;
        let parent_time = input.block.ancestor_headers[0].timestamp;
        assert!(header_time > parent_time && header_time > 1_700_000_000);
        let values = apply_evm_batch(input).unwrap();
        assert_eq!(values.block_timestamp, header_time);
        assert_ne!(values.block_timestamp, parent_time);
    }
    // Время — часть заголовка: другое время даёт другой хеш блока, а с ним другое слово состояния.
    let honest = outcome(4).values;
    let later = with_block_header(4, |header| header.timestamp += 1);
    let values = apply_evm_batch(later).unwrap();
    assert_eq!(values.block_timestamp, honest.block_timestamp + 1);
    assert_ne!(values.new_state_root, honest.new_state_root);
}

#[test]
fn block_header_must_follow_the_chain_rules() {
    // Поле, которое на исполнение не влияет, но правилами цепочки запрещено.
    let input = with_block_header(2, |header| header.difficulty = U256::from(1u8));
    refused_by(apply_evm_batch(input), "InvalidBlock", "difficulty after merge is not zero");
}

#[test]
fn block_body_must_match_the_header() {
    // Лишний «дядя» в теле на исполнение не влияет: отказ может прийти только от сверки тела
    // с заголовком.
    let mut input = batch(2);
    input.block.current_block.body.ommers.push(Header::default());
    republish(&mut input);
    refused_by(apply_evm_batch(input), "InvalidBlock", "mismatched block ommer hash");
}

#[test]
fn state_root_in_the_header_must_be_the_executed_one() {
    let honest = batch(2).block.current_block.header.state_root.0;
    let input = with_block_header(2, |header| header.state_root.0[0] ^= 1);
    match apply_evm_batch(input) {
        Err(EvmBatchError::MismatchedStateRoot { computed, header }) => {
            assert_eq!(computed, honest);
            assert_ne!(header, honest);
        }
        other => panic!("ожидалось несовпадение корня состояния, получено {other:?}"),
    }
}

#[test]
fn execution_results_in_the_header_must_be_the_executed_ones() {
    let receipts = with_block_header(2, |header| header.receipts_root.0[0] ^= 1);
    refused_by(apply_evm_batch(receipts), "InvalidExecutionResult", "receipt root mismatch");
    let gas = with_block_header(2, |header| header.gas_used += 1);
    refused_by(apply_evm_batch(gas), "InvalidExecutionResult", "block gas used mismatch");
    let bloom = with_block_header(2, |header| header.logs_bloom.0[0] ^= 1);
    refused_by(apply_evm_batch(bloom), "InvalidExecutionResult", "header bloom filter mismatch");
}

#[test]
fn parent_with_another_hash_is_rejected() {
    // Родитель изменён, а блок по-прежнему ссылается на настоящего.
    let mut input = batch(2);
    input.block.ancestor_headers[0].timestamp -= 1;
    refused_by(apply_evm_batch(input), "Witness", "Invalid parent header found for block");
}

#[test]
fn witness_must_match_the_parent_state_root() {
    // Родитель с другим корнем состояния, блок ссылается уже на него: свидетель не сходится.
    let input = with_parent_header(2, |parent| parent.state_root.0[0] ^= 1);
    refused_by(apply_evm_batch(input), "Witness", "Mismatched state root");
}

#[test]
fn block_must_follow_the_rules_against_its_parent() {
    // Секвенсор подставляет родителя с тем же корнем состояния, но другим временем, и блок,
    // который на него ссылается. Состояние и транзакции те же — отличается только заголовок.
    let block_time = batch(2).block.current_block.header.timestamp;
    let input = with_parent_header(2, |parent| parent.timestamp = block_time);
    refused_by(apply_evm_batch(input), "InvalidAncestry", "is in the past");
}

#[test]
fn base_fee_must_follow_from_the_parent() {
    // Без London в зашитых правилах базовая комиссия блока стала бы произвольной.
    let input = with_block_header(2, |header| {
        header.base_fee_per_gas = Some(header.base_fee_per_gas.unwrap() + 1);
    });
    refused_by(apply_evm_batch(input), "InvalidAncestry", "block base fee mismatch");
}

#[test]
fn parent_header_must_follow_the_chain_rules() {
    // Родитель сам по себе некорректен (сложность после Merge), а со связью «блок — родитель»
    // всё в порядке.
    let input = with_parent_header(2, |parent| parent.difficulty = U256::from(1u8));
    refused_by(apply_evm_batch(input), "InvalidAncestry", "difficulty after merge is not zero");
}

#[test]
fn missing_parent_is_rejected() {
    let mut input = batch(2);
    input.block.ancestor_headers.clear();
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::MissingParentHeader));
}

#[test]
fn previous_state_is_the_parent_even_with_more_ancestors() {
    // Во входе блока 3 — два предка: блок 2 и блок 1. «Состояние до» обязано быть хешем
    // именно родителя, а не самого дальнего предка.
    let grandparent = batch(2).block.ancestor_headers[0].clone();
    let mut input = batch(3);
    input.block.ancestor_headers.truncate(1);
    input.block.ancestor_headers.push(grandparent.clone());
    assert_eq!(input.block.ancestor_headers.len(), 2);
    let values = apply_evm_batch(input).unwrap();
    assert_eq!(values.prev_state_root, node_hash(2));
    assert_ne!(values.prev_state_root, node_hash(1));

    // Дальний предок, не образующий цепочку, отвергается.
    let mut forged = batch(3);
    forged.block.ancestor_headers.truncate(1);
    let mut other = grandparent;
    other.timestamp += 1;
    forged.block.ancestor_headers.push(other);
    refused_by(apply_evm_batch(forged), "Witness", "Invalid parent header found for block");
}

// ---------------------------------------------------------------- свидетель состояния

#[test]
fn bytecode_analysis_from_the_input_is_not_trusted() {
    // Контракт сценария, вызывающий мост через DELEGATECALL, кончается без STOP: исполнение
    // «проваливается за конец кода». Во входе байткод приходит с дополнением и таблицей
    // переходов, и хеш кода покрывает только сам код. Дописываем за концом КАЖДОГО кода запись
    // в хранилище: PUSH1 2, PUSH1 1, SSTORE.
    let honest = apply_evm_batch(batch(3)).unwrap();
    let mut input = batch(3);
    let mut tampered = 0;
    for code in input.block.bytecodes.iter_mut() {
        if code.is_empty() {
            continue;
        }
        let original = code.original_bytes();
        let code_hash = code.hash_slow();
        let mut padded = original.to_vec();
        padded.extend_from_slice(&[0x60, 0x02, 0x60, 0x01, 0x55]);
        padded.extend_from_slice(&[0u8; 33]);
        let jump_table = code.legacy_jump_table().unwrap().clone();
        *code = Bytecode::new_analyzed(Bytes::from(padded), original.len(), jump_table);
        assert_eq!(code.hash_slow(), code_hash, "подмена не меняет хеш кода");
        tampered += 1;
    }
    assert!(tampered >= 4, "в свидетеле блока 3 — код моста и трёх вызываемых контрактов");
    let falls_off_the_end = batch(3).block.bytecodes.iter().any(|code| {
        let bytes = code.original_bytes();
        !bytes.is_empty() && !matches!(bytes[bytes.len() - 1], 0x00 | 0xf3 | 0xfd)
    });
    assert!(falls_off_the_end, "среди контрактов блока 3 есть код без завершающей инструкции");
    // Программа исполняет только код, покрытый хешем: результат тот же, что у честного входа.
    assert_eq!(apply_evm_batch(input).unwrap(), honest);
}

/// Первое расширение в дереве заменяет «листом» с тем же путём, значение которого — хеш
/// потомка: кодировка и хеш узла те же. Возвращает дерево с подменой, если расширение нашлось.
fn present_extension_as_a_leaf(node: &MptNode) -> Option<MptNode> {
    match node.as_data() {
        MptNodeData::Extension(path, child) => {
            Some(MptNode::from(MptNodeData::Leaf(path.clone(), child.hash().to_vec())))
        }
        MptNodeData::Branch(children) => {
            for (index, child) in children.iter().enumerate() {
                if let Some(forged) = child.as_ref().and_then(|child| present_extension_as_a_leaf(child)) {
                    let mut children = children.clone();
                    children[index] = Some(Box::new(forged));
                    return Some(MptNode::from(MptNodeData::Branch(children)));
                }
            }
            None
        }
        _ => None,
    }
}

#[test]
fn extension_presented_as_a_leaf_in_a_real_block_is_rejected() {
    // Блок 5 обнуляет слот контракта, у которого к этому времени два слота с общим первым
    // полубайтом: корень дерева хранилища — расширение. Подменяем его «листом»: корень
    // хранилища и корень состояния те же, а слот читался бы как отсутствующий.
    let mut input = batch(5);
    let mut forged = 0;
    for trie in input.block.parent_state.storage_tries.values_mut() {
        if let Some(replacement) = present_extension_as_a_leaf(trie) {
            assert_eq!(replacement.hash(), trie.hash(), "подмена не меняет корень хранилища");
            *trie = replacement;
            forged += 1;
        }
    }
    assert_eq!(forged, 1, "в свидетеле блока 5 одно дерево хранилища с расширением");
    assert_eq!(
        apply_evm_batch(input),
        Err(EvmBatchError::Witness("лист с признаком расширения в пути".into()))
    );
}

#[test]
fn slot_deletions_next_to_a_branch_and_under_an_extension_are_provable() {
    // Находка 7-1: блок 4 обнуляет слот, после чего в корневой ветке хранилища остаётся один
    // потомок — ветка; блок 5 обнуляет слот под расширением, и корень сворачивается в лист.
    // Свидетель узла раскрывает соседей, программа принимает оба блока с корнем состояния узла.
    let deletion = expected()["storageDeletion"].clone();
    let contract = keccak256(address(&deletion["contract"]));
    for (block, root_is_extension) in [(4u64, false), (5, true)] {
        let input = batch(block);
        let trie = &input.block.parent_state.storage_tries[&contract];
        assert_eq!(matches!(trie.as_data(), MptNodeData::Extension(..)), root_is_extension, "блок {block}");
        assert_eq!(apply_evm_batch(input).unwrap().new_state_root, node_hash(block));
    }
}

#[test]
fn witness_node_with_another_reading_is_rejected() {
    // Пустой потомок ветки кодируется так же, как отсутствующий: хеш узла и корень состояния
    // те же, а дерево при удалении посчитало бы такого потомка «оставшимся».
    let mut input = batch(2);
    let root = input.block.parent_state.state_trie.clone();
    let MptNodeData::Branch(children) = root.as_data() else {
        panic!("корень дерева состояния в фикстуре — ветка");
    };
    let mut children = children.clone();
    let empty = children.iter().position(Option::is_none).expect("в ветке есть свободное место");
    children[empty] = Some(Box::new(MptNode::from(MptNodeData::Null)));
    let forged = MptNode::from(MptNodeData::Branch(children));
    assert_eq!(forged.hash(), root.hash(), "подмена не меняет корень состояния");
    input.block.parent_state.state_trie = forged;
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::Witness("пустой узел внутри дерева".into())));
}
