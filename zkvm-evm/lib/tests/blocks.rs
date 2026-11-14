//! Тесты батча EVM на настоящих блоках.
//!
//! Фикстуры (`fixtures/evm_batches/<вариант>/`) пишет `zkvm-evm/scenario/anvil-scenario.sh`:
//! `block-N.bin` — вход батча, `block-N.json` — отчёт хоста (публичные значения из zkVM),
//! `expected.json` — хеши блоков и статусы переводов на мост со слов узла anvil, то есть
//! независимо от проверяемой программы.
use std::{fs, path::PathBuf};

use alloy_consensus::{
    proofs::calculate_withdrawals_root, Header, Signed, Transaction, TxEip1559, TxEip2930, TxEip4844, TxEip7702,
    TxLegacy,
};
use alloy_eips::eip4895::{Withdrawal, Withdrawals};
use alloy_primitives::{address, keccak256, Address, Bytes, Signature, TxKind, B256, U256};
use revm::state::Bytecode;
use rollup_evm::{
    apply_evm_batch, block_data_chunks, bridge_withdrawal, chain_config, Deposit, EvmBatchError, EvmBatchInput,
    Hash, PublicValues, QueueItem, WithdrawalLeaf, BRIDGE_ADDRESS,
};
use reth_trie::TrieAccount;
use rollup_stf::{batch_data_hash, deposit_hash, withdrawals_root, MAX_DATA_CHUNK_BYTES};
use rsp_mpt::{MptNode, MptNodeData};
use rsp_primitives::genesis::Genesis;
use serde_json::Value;

const CHAIN_ID: u64 = 362107787851;
/// Ненулевой хеш очереди: с нулевым не видно, что слово действительно берётся из входа.
const QUEUE_HASH: Hash = [5u8; 32];

fn fixtures(variant: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/evm_batches").join(variant)
}

/// Вход батча ровно как в фикстуре.
fn raw_batch(variant: &str, block: u64) -> EvmBatchInput {
    let bytes = fs::read(fixtures(variant).join(format!("block-{block}.bin")))
        .expect("нет фикстуры: запустите zkvm-evm/scenario/anvil-scenario.sh");
    bincode::deserialize(&bytes).expect("фикстура не разобрана")
}

/// Вход батча с ненулевым прежним хешем очереди.
fn batch(variant: &str, block: u64) -> EvmBatchInput {
    let mut input = raw_batch(variant, block);
    input.prev_deposit_hash = QUEUE_HASH;
    input
}

fn json(variant: &str, file: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(fixtures(variant).join(file)).unwrap()).unwrap()
}

/// Хеш блока со слов узла.
fn node_hash(variant: &str, block: u64) -> Hash {
    let expected = json(variant, "expected.json");
    expected["blocks"][block.to_string()]["hash"].as_str().unwrap().parse::<B256>().unwrap().0
}

/// Статусы переводов на мост в блоке со слов узла, в порядке блока.
fn bridge_statuses(variant: &str, block: u64) -> Vec<u64> {
    json(variant, "expected.json")["blocks"][block.to_string()]["bridgeTransferStatuses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|status| status.as_u64().unwrap())
        .collect()
}

/// Хеш получателя вывода как в сценарии (`recipient`): первый байт задан, остальные 31 разные —
/// пары десятичных цифр 01…31, прочитанные как шестнадцатеричные байты.
fn recipient(first: u8) -> Hash {
    let mut hash = [first; 32];
    for (index, byte) in hash.iter_mut().enumerate().skip(1) {
        *byte = u8::from_str_radix(&format!("{index:02}"), 16).unwrap();
    }
    hash
}

fn leaf(byte: u8, nanotons: u128) -> WithdrawalLeaf {
    WithdrawalLeaf { recipient_hash: recipient(byte), amount: nanotons }
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

/// Выводы блока 2 по сценарию: 0,25 и 0,1 монеты.
fn block_two_leaves() -> Vec<WithdrawalLeaf> {
    vec![leaf(0x11, 250_000_000), leaf(0x22, 100_000_000)]
}

/// Перепубликовать блок после правки: иначе отказ пришёл бы от сверки данных, а не от той
/// проверки, на которую нацелен тест.
fn republish(input: &mut EvmBatchInput) {
    input.data_chunks = block_data_chunks(&input.block.current_block);
}

/// Блок 2 с изменённым заголовком.
fn with_block_header(change: impl FnOnce(&mut Header)) -> EvmBatchInput {
    let mut input = batch("honest", 2);
    change(&mut input.block.current_block.header);
    republish(&mut input);
    input
}

/// Блок 2 с изменённым заголовком родителя; блок ссылается уже на изменённого.
fn with_parent_header(change: impl FnOnce(&mut Header)) -> EvmBatchInput {
    let mut input = batch("honest", 2);
    change(&mut input.block.ancestor_headers[0]);
    input.block.current_block.header.parent_hash = input.block.ancestor_headers[0].hash_slow();
    republish(&mut input);
    input
}

fn signature() -> Signature {
    Signature::new(U256::from(1u8), U256::from(1u8), false)
}

// ---------------------------------------------------------------- честные блоки

#[test]
fn honest_block_gives_the_words_the_node_reports() {
    let input = batch("honest", 2);
    let data_hash = batch_data_hash(&input.data_chunks).unwrap();
    let values = apply_evm_batch(input).unwrap();

    assert_eq!(values.chain_id, CHAIN_ID);
    assert_eq!(values.prev_state_root, node_hash("honest", 1));
    assert_eq!(values.new_state_root, node_hash("honest", 2));
    assert_ne!(values.batch_hash, [0u8; 32]);
    assert_eq!(values.batch_hash, data_hash);
    // Все шесть переводов на мост в блоке состоялись, но выводами стали только два.
    assert_eq!(bridge_statuses("honest", 2), [1, 1, 1, 1, 1, 1]);
    assert_eq!(values.prev_withdrawals_root, [0u8; 32]);
    assert_eq!(values.withdrawals_root, withdrawals_root(&block_two_leaves()));
    // Очередь L1 пуста: её хеш не меняется.
    assert_eq!(values.prev_deposit_hash, QUEUE_HASH);
    assert_eq!(values.new_deposit_hash, QUEUE_HASH);
}

#[test]
fn next_block_continues_the_chain_and_the_withdrawal_tree() {
    let previous = apply_evm_batch(batch("honest", 2)).unwrap();
    let input = batch("honest", 3);
    assert_eq!(input.prior_withdrawals.len(), 2, "в фикстуре блока 3 — выводы блока 2");
    let values = apply_evm_batch(input).unwrap();

    assert_eq!(values.prev_state_root, previous.new_state_root);
    assert_eq!(values.new_state_root, node_hash("honest", 3));
    assert_ne!(values.prev_withdrawals_root, [0u8; 32]);
    assert_eq!(values.prev_withdrawals_root, previous.withdrawals_root);
    let mut leaves = block_two_leaves();
    leaves.push(leaf(0x33, 500_000_000));
    assert_eq!(values.withdrawals_root, withdrawals_root(&leaves));

    // Чужие «прежние выводы» дают другой прежний корень — контракт такой батч не примет.
    let mut forged = batch("honest", 3);
    forged.prior_withdrawals.swap(0, 1);
    assert_ne!(apply_evm_batch(forged).unwrap().prev_withdrawals_root, previous.withdrawals_root);
}

#[test]
fn empty_block_keeps_the_withdrawal_tree() {
    let values = apply_evm_batch(batch("honest", 4)).unwrap();
    assert_eq!(values.prev_state_root, node_hash("honest", 3));
    assert_eq!(values.new_state_root, node_hash("honest", 4));
    assert_ne!(values.withdrawals_root, [0u8; 32]);
    assert_eq!(values.withdrawals_root, values.prev_withdrawals_root);
}

#[test]
fn zkvm_reports_match_the_current_code() {
    // Отчёт хоста записан после сверки публичных значений zkVM с нативным расчётом. Если
    // библиотека с тех пор изменилась так, что значения другие, фраза «zkVM совпал» устарела.
    for variant in ["honest", "reverting-bridge"] {
        for block in [2, 3, 4, 5] {
            let report = json(variant, &format!("block-{block}.json"));
            assert!(report["zkvmCycles"].as_u64().unwrap() > 0, "{variant}/{block}: в zkVM не исполнялся");
            let reported = report["publicValuesBytes"].as_str().unwrap().parse::<Bytes>().unwrap();
            let current = apply_evm_batch(raw_batch(variant, block)).unwrap().to_bytes();
            assert_eq!(reported.as_ref(), current.as_slice(), "{variant}/{block}");
        }
    }
}

#[test]
fn chain_rules_in_the_program_are_those_the_chain_was_built_with() {
    // Во входе блока лежит конфигурация из genesis.json сценария (её туда кладёт rsp). Программа
    // это поле не читает, но зашитые правила обязаны совпадать с ней поле в поле.
    assert_eq!(raw_batch("honest", 2).block.genesis, Genesis::Custom(chain_config(CHAIN_ID)));
}

// ---------------------------------------------------------------- выводы

#[test]
fn bridge_transfer_rules() {
    let input = batch("honest", 2);
    let mut to_bridge: Vec<Option<(Hash, u128)>> = Vec::new();
    let mut elsewhere = 0;
    for transaction in &input.block.current_block.body.transactions {
        let leaf = bridge_withdrawal(transaction).map(|leaf| (leaf.recipient_hash, leaf.amount));
        if Transaction::to(transaction) == Some(BRIDGE_ADDRESS) {
            to_bridge.push(leaf);
        } else {
            // Перевод не на мост выводом не считается.
            assert_eq!(leaf, None);
            elsewhere += 1;
        }
    }
    // По сценарию: вывод, 31 байт данных, вывод, сумма не кратна нанотону, нулевая сумма,
    // 33 байта данных.
    assert_eq!(
        to_bridge,
        [Some((recipient(0x11), 250_000_000)), None, Some((recipient(0x22), 100_000_000)), None, None, None]
    );
    // Среди остальных — перевод, оформленный как вывод, но на посторонний адрес.
    assert_eq!(elsewhere, 3);
}

#[test]
fn reverted_bridge_transfer_is_not_a_withdrawal() {
    // В этой цепочке по адресу моста лежит код, который отклоняет любой вызов: те же переводы
    // включены в блок, но монеты не ушли. Вывод по ним был бы выплатой на L1 без сжигания.
    assert_eq!(bridge_statuses("reverting-bridge", 2), [0, 0, 0, 0, 0, 0]);
    let input = batch("reverting-bridge", 2);
    let candidates =
        input.block.current_block.body.transactions.iter().filter(|tx| bridge_withdrawal(tx).is_some()).count();
    assert_eq!(candidates, 2, "переводы по форме — выводы; решает только квитанция");
    let values = apply_evm_batch(input).unwrap();
    assert_eq!(values.new_state_root, node_hash("reverting-bridge", 2));
    assert_eq!(values.withdrawals_root, [0u8; 32]);
}

// ---------------------------------------------------------------- депозиты и очередь L1

/// Блок 2 с зачислением депозита: тело и корень зачислений в заголовке исправлены, корень
/// состояния в заголовке — ещё от блока без зачисления.
fn block_with_credit(deposit: &Deposit) -> EvmBatchInput {
    let mut input = batch("honest", 2);
    let credit = Withdrawal {
        index: 0,
        validator_index: 0,
        address: Address::from(deposit.l2_recipient),
        amount: u64::try_from(deposit.amount).unwrap(),
    };
    input.block.current_block.header.withdrawals_root = Some(calculate_withdrawals_root(&[credit]));
    input.block.current_block.body.withdrawals = Some(Withdrawals::new(vec![credit]));
    republish(&mut input);
    input
}

/// Второй тестовый счёт anvil: отправляет транзакции и в блоке 2, и в блоке 3, поэтому путь к
/// нему есть в свидетелях обоих блоков.
const DEPOSIT_RECIPIENT: Address = address!("70997970C51812dc3A010C7d01b50e0d17dc79C8");

/// Депозит на счёт, уже затронутый блоком 2.
fn deposit_to_touched_account() -> Deposit {
    Deposit { l2_recipient: DEPOSIT_RECIPIENT.into_array(), amount: 1_500_000_000 }
}

/// Корень состояния после блока 2, если бы получателю депозита зачислили `nanotons`. Считается
/// независимо от исполнения: берём дерево состояния ПОСЛЕ блока 2 (это свидетель блока 3, его
/// корень сверен с узлом) и правим в нём одно поле одного счёта.
fn state_root_after_block_two_with_credit(nanotons: u128) -> Hash {
    let mut trie = raw_batch("honest", 3).block.parent_state.state_trie;
    assert_eq!(trie.hash().0, raw_batch("honest", 2).block.current_block.header.state_root.0);
    let key = keccak256(DEPOSIT_RECIPIENT);
    let mut account: TrieAccount = trie.get_rlp(key.as_slice()).unwrap().expect("счёт есть в свидетеле блока 3");
    account.balance += U256::from(nanotons) * U256::from(1_000_000_000u64);
    trie.insert_rlp(key.as_slice(), account).unwrap();
    trie.hash().0
}

#[test]
fn block_with_a_deposit_advances_the_queue_hash() {
    // Блока с зачислением anvil собрать не умеет, поэтому он собран здесь из блока 2.
    let deposit = deposit_to_touched_account();
    let mut input = block_with_credit(&deposit);
    input.queue_items = vec![QueueItem::Deposit(deposit.clone())];
    let without_credit = input.block.current_block.header.state_root.0;
    let with_credit = state_root_after_block_two_with_credit(deposit.amount);
    assert_ne!(with_credit, without_credit);
    // С прежним корнем в заголовке программа отказывает и называет корень, который получила
    // исполнением: он обязан совпасть с посчитанным независимо — зачислено тому и столько.
    assert_eq!(
        apply_evm_batch(input.clone()),
        Err(EvmBatchError::MismatchedStateRoot { computed: with_credit, header: without_credit })
    );
    input.block.current_block.header.state_root = B256::from(with_credit);
    republish(&mut input);

    let values = apply_evm_batch(input).unwrap();
    assert_eq!(values.prev_deposit_hash, QUEUE_HASH);
    assert_eq!(values.new_deposit_hash, deposit_hash(&QUEUE_HASH, &deposit));
    assert_ne!(values.new_deposit_hash, values.prev_deposit_hash);
}

#[test]
fn credit_without_a_queue_item_is_rejected() {
    // Зачисление, которого нет в очереди L1, — монеты из воздуха.
    let input = block_with_credit(&deposit_to_touched_account());
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::DepositCountMismatch { block: 1, queue: 0 }));
}

#[test]
fn queue_item_without_a_credit_in_the_block_is_rejected() {
    let mut input = batch("honest", 2);
    input.queue_items = vec![QueueItem::Deposit(deposit_to_touched_account())];
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::DepositCountMismatch { block: 0, queue: 1 }));
}

// ---------------------------------------------------------------- данные батча

#[test]
fn published_data_must_be_the_block() {
    let mut truncated = batch("honest", 2);
    truncated.data_chunks.last_mut().unwrap().pop();
    assert_eq!(apply_evm_batch(truncated), Err(EvmBatchError::DataMismatch));

    let mut empty = batch("honest", 2);
    empty.data_chunks.clear();
    assert_eq!(apply_evm_batch(empty), Err(EvmBatchError::DataMismatch));

    // Данные другого блока.
    let mut foreign = batch("honest", 2);
    foreign.data_chunks = batch("honest", 3).data_chunks;
    assert_eq!(apply_evm_batch(foreign), Err(EvmBatchError::DataMismatch));

    let mut oversized = batch("honest", 2);
    oversized.data_chunks = vec![vec![0u8; MAX_DATA_CHUNK_BYTES + 1]];
    assert_eq!(apply_evm_batch(oversized), Err(EvmBatchError::DataChunkTooLarge));
}

#[test]
fn batch_hash_commits_to_the_chunks_as_published() {
    // Контракт копит хеш тех порций, что реально опубликованы, а не «канонической» нарезки.
    let canonical = apply_evm_batch(batch("honest", 2)).unwrap();
    let mut input = batch("honest", 2);
    let whole = input.data_chunks.concat();
    input.data_chunks = vec![whole[..100].to_vec(), whole[100..].to_vec()];
    let expected = batch_data_hash(&input.data_chunks).unwrap();
    let values = apply_evm_batch(input).unwrap();
    assert_eq!(values.batch_hash, expected);
    assert_ne!(values.batch_hash, canonical.batch_hash);
    assert_eq!(PublicValues { batch_hash: canonical.batch_hash, ..values }, canonical);
}

// ---------------------------------------------------------------- правила цепочки

#[test]
fn chain_id_is_bound_by_transaction_signatures() {
    let mut input = batch("honest", 2);
    input.chain_id += 1;
    refused_by(apply_evm_batch(input), "Execution", "invalid chain ID");
}

#[test]
fn chain_ids_with_relaxed_rules_in_rsp_are_rejected() {
    for linea in [59144, 59141, 59140] {
        let mut input = batch("honest", 2);
        input.chain_id = linea;
        assert_eq!(apply_evm_batch(input), Err(EvmBatchError::UnsupportedChainId(linea)));
    }
}

#[test]
fn chain_rules_come_from_the_program_not_from_the_input() {
    let honest = apply_evm_batch(batch("honest", 2)).unwrap();
    let mut input = batch("honest", 2);
    input.block.genesis = Genesis::Mainnet;
    input.block.custom_beneficiary = Some(Address::from([9u8; 20]));
    input.block.opcode_tracking = true;
    assert_eq!(apply_evm_batch(input).unwrap(), honest);
}

#[test]
fn transaction_without_chain_id_is_rejected() {
    let mut input = batch("honest", 2);
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
    let mut input = batch("honest", 2);
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
    let header = with_block_header(|header| header.blob_gas_used = Some(131_072));
    assert_eq!(apply_evm_batch(header), Err(EvmBatchError::BlobsNotSupported));

    let mut input = batch("honest", 2);
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
    let excess = with_block_header(|header| header.excess_blob_gas = Some(131_072));
    assert_eq!(apply_evm_batch(excess), Err(EvmBatchError::BlobsNotSupported));
    let missing = with_block_header(|header| header.excess_blob_gas = None);
    assert_eq!(apply_evm_batch(missing), Err(EvmBatchError::BlobsNotSupported));
}

#[test]
fn transaction_with_delegation_is_rejected() {
    // EIP-7702 правила Cancun отвергают и сами, но на отсутствии делегирований держится
    // пересборка байткода — запрет явный и от хардфорка не зависит.
    let mut input = batch("honest", 2);
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
    let candidates: Vec<rollup_evm_transaction::Tx> = vec![
        Signed::new_unhashed(TxLegacy { chain_id: Some(CHAIN_ID), gas_limit: 21_000, to, ..Default::default() }, zero)
            .into(),
        Signed::new_unhashed(TxEip2930 { chain_id: CHAIN_ID, gas_limit: 21_000, to, ..Default::default() }, zero)
            .into(),
        Signed::new_unhashed(TxEip1559 { chain_id: CHAIN_ID, gas_limit: 21_000, to, ..Default::default() }, zero)
            .into(),
    ];
    for transaction in candidates {
        let mut input = batch("honest", 2);
        input.block.current_block.body.transactions.push(transaction);
        republish(&mut input);
        assert_eq!(apply_evm_batch(input), Err(EvmBatchError::SignatureRecovery));
    }
}

/// Тип транзакции блока — чтобы собрать в тесте список транзакций разных видов.
mod rollup_evm_transaction {
    pub type Tx = reth_ethereum_primitives::TransactionSigned;
}

#[test]
fn trailing_bytes_in_the_input_do_not_change_the_result() {
    // Гостевая программа разбирает вход через bincode, а он допускает хвост после структуры.
    let mut bytes = fs::read(fixtures("honest").join("block-2.bin")).unwrap();
    let honest = apply_evm_batch(bincode::deserialize(&bytes).unwrap()).unwrap();
    bytes.extend_from_slice(&[0xff; 100]);
    assert_eq!(apply_evm_batch(bincode::deserialize(&bytes).unwrap()).unwrap(), honest);
}

// ---------------------------------------------------------------- заголовок, родитель, предки

#[test]
fn block_header_must_follow_the_chain_rules() {
    // Поле, которое на исполнение не влияет, но правилами цепочки запрещено.
    let input = with_block_header(|header| header.difficulty = U256::from(1u8));
    refused_by(apply_evm_batch(input), "InvalidBlock", "difficulty after merge is not zero");
}

#[test]
fn block_body_must_match_the_header() {
    // Лишний «дядя» в теле на исполнение не влияет: отказ может прийти только от сверки тела
    // с заголовком.
    let mut input = batch("honest", 2);
    input.block.current_block.body.ommers.push(Header::default());
    republish(&mut input);
    refused_by(apply_evm_batch(input), "InvalidBlock", "mismatched block ommer hash");
}

#[test]
fn state_root_in_the_header_must_be_the_executed_one() {
    let honest = batch("honest", 2).block.current_block.header.state_root.0;
    let input = with_block_header(|header| header.state_root.0[0] ^= 1);
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
    let receipts = with_block_header(|header| header.receipts_root.0[0] ^= 1);
    refused_by(apply_evm_batch(receipts), "InvalidExecutionResult", "receipt root mismatch");
    let gas = with_block_header(|header| header.gas_used += 1);
    refused_by(apply_evm_batch(gas), "InvalidExecutionResult", "block gas used mismatch");
    let bloom = with_block_header(|header| header.logs_bloom.0[0] ^= 1);
    refused_by(apply_evm_batch(bloom), "InvalidExecutionResult", "header bloom filter mismatch");
}

#[test]
fn parent_with_another_hash_is_rejected() {
    // Родитель изменён, а блок по-прежнему ссылается на настоящего.
    let mut input = batch("honest", 2);
    input.block.ancestor_headers[0].timestamp -= 1;
    refused_by(apply_evm_batch(input), "Witness", "Invalid parent header found for block");
}

#[test]
fn witness_must_match_the_parent_state_root() {
    // Родитель с другим корнем состояния, блок ссылается уже на него: свидетель не сходится.
    let input = with_parent_header(|parent| parent.state_root.0[0] ^= 1);
    refused_by(apply_evm_batch(input), "Witness", "Mismatched state root");
}

#[test]
fn block_must_follow_the_rules_against_its_parent() {
    // Секвенсор подставляет родителя с тем же корнем состояния, но другим временем, и блок,
    // который на него ссылается. Состояние и транзакции те же — отличается только заголовок.
    let block_time = batch("honest", 2).block.current_block.header.timestamp;
    let input = with_parent_header(|parent| parent.timestamp = block_time);
    refused_by(apply_evm_batch(input), "InvalidAncestry", "is in the past");
}

#[test]
fn base_fee_must_follow_from_the_parent() {
    // Без London в зашитых правилах базовая комиссия блока стала бы произвольной.
    let input = with_block_header(|header| {
        header.base_fee_per_gas = Some(header.base_fee_per_gas.unwrap() + 1);
    });
    refused_by(apply_evm_batch(input), "InvalidAncestry", "block base fee mismatch");
}

#[test]
fn parent_header_must_follow_the_chain_rules() {
    // Родитель сам по себе некорректен (сложность после Merge), а со связью «блок — родитель»
    // всё в порядке.
    let input = with_parent_header(|parent| parent.difficulty = U256::from(1u8));
    refused_by(apply_evm_batch(input), "InvalidAncestry", "difficulty after merge is not zero");
}

#[test]
fn missing_parent_is_rejected() {
    let mut input = batch("honest", 2);
    input.block.ancestor_headers.clear();
    assert_eq!(apply_evm_batch(input), Err(EvmBatchError::MissingParentHeader));
}

#[test]
fn previous_state_is_the_parent_even_with_more_ancestors() {
    // Во входе блока 3 — два предка: блок 2 и блок 1. «Состояние до» обязано быть хешем
    // именно родителя, а не самого дальнего предка.
    let grandparent = batch("honest", 2).block.ancestor_headers[0].clone();
    let mut input = batch("honest", 3);
    input.block.ancestor_headers.push(grandparent.clone());
    assert_eq!(input.block.ancestor_headers.len(), 2);
    let values = apply_evm_batch(input).unwrap();
    assert_eq!(values.prev_state_root, node_hash("honest", 2));
    assert_ne!(values.prev_state_root, node_hash("honest", 1));

    // Дальний предок, не образующий цепочку, отвергается.
    let mut forged = batch("honest", 3);
    let mut other = grandparent;
    other.timestamp += 1;
    forged.block.ancestor_headers.push(other);
    refused_by(apply_evm_batch(forged), "Witness", "Invalid parent header found for block");
}

// ---------------------------------------------------------------- свидетель состояния

#[test]
fn bytecode_analysis_from_the_input_is_not_trusted() {
    // Контракт сценария заканчивается без STOP: исполнение «проваливается за конец кода».
    // Во входе байткод приходит с дополнением и таблицей переходов, и хеш кода покрывает только
    // сам код. Дописываем за его концом запись в хранилище: PUSH1 1, PUSH0, SSTORE.
    let honest = apply_evm_batch(batch("honest", 2)).unwrap();
    let mut input = batch("honest", 2);
    let mut tampered = 0;
    for code in input.block.bytecodes.iter_mut() {
        if code.is_empty() {
            continue;
        }
        let original = code.original_bytes();
        let hash = code.hash_slow();
        let mut padded = original.to_vec();
        padded.extend_from_slice(&[0x60, 0x01, 0x5f, 0x55]);
        padded.extend_from_slice(&[0u8; 33]);
        let jump_table = code.legacy_jump_table().unwrap().clone();
        *code = Bytecode::new_analyzed(Bytes::from(padded), original.len(), jump_table);
        assert_eq!(code.hash_slow(), hash, "подмена не меняет хеш кода");
        tampered += 1;
    }
    assert!(tampered >= 1, "в свидетеле блока 2 есть код вызываемого контракта");
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
    // Блок 5 вызывает контракт с аргументом, чей слот лежит под расширением дерева хранилища
    // (аргументы подобраны в сценарии). Подменяем это расширение «листом»: корень хранилища и
    // корень состояния те же, а слот читался бы как отсутствующий.
    let mut input = batch("honest", 5);
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
fn witness_node_with_another_reading_is_rejected() {
    // Пустой потомок ветки кодируется так же, как отсутствующий: хеш узла и корень состояния
    // те же, а дерево при удалении посчитало бы такого потомка «оставшимся».
    let mut input = batch("honest", 2);
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
