//! Тесты чистых функций батча EVM и сторожа совпадения протокола. Тесты на настоящих блоках —
//! в `tests/blocks.rs` (им нужны фикстуры из `fixtures/evm_batches/`), проверка формы
//! принудительных транзакций — в `tests/forced.rs`.
use std::{fs, path::PathBuf};

use alloy_consensus::Header;
use alloy_eips::eip4895::Withdrawal;
use alloy_primitives::{keccak256, Address, Bytes, Log, LogData, B256, U256};
use reth_ethereum_primitives::Receipt;
use serde_json::{json, Value};

use crate::{
    bridge::{bridge_withdrawals, withdrawal_from_log, MalformedBridgeLog, MIN_WITHDRAWAL_NANOTONS},
    check_block_data, check_header_policy, check_queue,
    protocol::{
        batch_data_hash, data_chunk_hash, data_hash_step, deposit_hash, forced_transaction_hash, sha256,
        withdrawal_leaf_hash, word, FORCED_TRANSACTION_MARKER, PUBLIC_VALUES_BYTES,
    },
    withdrawals::{FrontierError, WithdrawalTree, MAX_WITHDRAWALS, WITHDRAWAL_TREE_DEPTH},
    Deposit, EvmBatchError, Hash, PublicValues, QueueItem, WithdrawalLeaf, BRIDGE_ADDRESS, BRIDGE_CODE,
    BRIDGE_CODE_HASH, FORCED_TX_GAS_CAP, GAS_LIMIT, MAX_BATCH_QUEUE_ITEMS, WITHDRAWAL_TOPIC,
};

fn deposit(recipient: u8, amount: u128) -> Deposit {
    Deposit { l2_recipient: [recipient; 20], amount }
}

fn credit(index: u64, recipient: u8, amount: u64) -> Withdrawal {
    Withdrawal { index, validator_index: 0, address: Address::from([recipient; 20]), amount }
}

fn queue(deposits: &[Deposit]) -> Vec<QueueItem> {
    deposits.iter().cloned().map(QueueItem::Deposit).collect()
}

fn leaf(byte: u8, amount: u128) -> WithdrawalLeaf {
    let mut recipient_hash = [byte; 32];
    recipient_hash[31] = byte.wrapping_mul(7).wrapping_add(1);
    WithdrawalLeaf { recipient_hash, amount }
}

fn leaves(count: usize) -> Vec<WithdrawalLeaf> {
    (0..count).map(|index| leaf(index as u8 + 1, 50_000_000 + index as u128)).collect()
}

fn tree_of(leaves: &[WithdrawalLeaf]) -> WithdrawalTree {
    let mut tree = WithdrawalTree::empty();
    for leaf in leaves {
        tree.append(leaf).unwrap();
    }
    tree
}

/// Ненулевой прежний хеш: с нулевым не видно, что он участвует в цепочке.
const PREVIOUS: [u8; 32] = [7u8; 32];

// ---------------------------------------------------------------- очередь L1

#[test]
fn deposits_matching_the_queue_extend_its_hash() {
    let deposits = [deposit(1, 1_000_000_000), deposit(2, 500_000_000)];
    let credits = [credit(0, 1, 1_000_000_000), credit(1, 2, 500_000_000)];
    let expected = deposit_hash(&deposit_hash(&PREVIOUS, &deposits[0]), &deposits[1]);
    assert_eq!(check_queue(&credits, &queue(&deposits), &PREVIOUS), Ok(expected));
    // Пустой отрезок очереди хеш не меняет.
    assert_eq!(check_queue(&[], &[], &PREVIOUS), Ok(PREVIOUS));
}

#[test]
fn extra_or_missing_credit_is_rejected() {
    let deposits = [deposit(1, 100)];
    // Лишнее зачисление — монеты из воздуха.
    let extra = [credit(0, 1, 100), credit(1, 9, 1_000_000)];
    assert_eq!(
        check_queue(&extra, &queue(&deposits), &PREVIOUS),
        Err(EvmBatchError::DepositCountMismatch { block: 2, queue: 1 })
    );
    // Пропущенное — депозит из очереди не зачислен.
    assert_eq!(
        check_queue(&[], &queue(&deposits), &PREVIOUS),
        Err(EvmBatchError::DepositCountMismatch { block: 0, queue: 1 })
    );
}

#[test]
fn credit_must_equal_the_deposit_field_by_field() {
    let deposits = [deposit(1, 100), deposit(2, 200)];
    let items = queue(&deposits);
    let honest = [credit(0, 1, 100), credit(1, 2, 200)];
    assert!(check_queue(&honest, &items, &PREVIOUS).is_ok());

    let mut other_recipient = honest;
    other_recipient[1].address = Address::from([3u8; 20]);
    assert_eq!(check_queue(&other_recipient, &items, &PREVIOUS), Err(EvmBatchError::DepositMismatch(1)));

    let mut other_amount = honest;
    other_amount[0].amount = 101;
    assert_eq!(check_queue(&other_amount, &items, &PREVIOUS), Err(EvmBatchError::DepositMismatch(0)));

    let mut other_index = honest;
    other_index[1].index = 5;
    assert_eq!(check_queue(&other_index, &items, &PREVIOUS), Err(EvmBatchError::DepositMismatch(1)));

    let mut other_validator = honest;
    other_validator[0].validator_index = 1;
    assert_eq!(check_queue(&other_validator, &items, &PREVIOUS), Err(EvmBatchError::DepositMismatch(0)));

    // Те же депозиты в другом порядке — другая очередь.
    let swapped = [credit(0, 2, 200), credit(1, 1, 100)];
    assert_eq!(check_queue(&swapped, &items, &PREVIOUS), Err(EvmBatchError::DepositMismatch(0)));
}

#[test]
fn deposit_beyond_64_bits_is_rejected() {
    let huge = [deposit(1, u64::MAX as u128 + 1)];
    assert_eq!(check_queue(&[credit(0, 1, 0)], &queue(&huge), &PREVIOUS), Err(EvmBatchError::DepositTooLarge(0)));
}

#[test]
fn forced_transactions_enter_the_queue_hash_in_order_and_take_no_credit() {
    // Депозит, принудительная, депозит: зачислений два, их номера — места среди ДЕПОЗИТОВ.
    let first = deposit(1, 100);
    let second = deposit(2, 200);
    let forced = vec![0xde, 0xad, 0xbe, 0xef];
    let items = vec![
        QueueItem::Deposit(first.clone()),
        QueueItem::ForcedTransaction(forced.clone()),
        QueueItem::Deposit(second.clone()),
    ];
    let credits = [credit(0, 1, 100), credit(1, 2, 200)];
    let expected =
        deposit_hash(&forced_transaction_hash(&deposit_hash(&PREVIOUS, &first), &forced), &second);
    assert_eq!(check_queue(&credits, &items, &PREVIOUS), Ok(expected));

    // Порядок элементов — часть хеша: те же элементы иначе дают другой хеш.
    let reordered = vec![
        QueueItem::ForcedTransaction(forced.clone()),
        QueueItem::Deposit(first.clone()),
        QueueItem::Deposit(second.clone()),
    ];
    assert_ne!(check_queue(&credits, &reordered, &PREVIOUS), Ok(expected));
    assert!(check_queue(&credits, &reordered, &PREVIOUS).is_ok());

    // Только принудительные: зачислений нет, хеш продвинут.
    let only_forced = vec![QueueItem::ForcedTransaction(forced.clone())];
    assert_eq!(check_queue(&[], &only_forced, &PREVIOUS), Ok(forced_transaction_hash(&PREVIOUS, &forced)));
    // Зачисление «за» принудительную транзакцию — монеты из воздуха.
    assert_eq!(
        check_queue(&[credit(0, 1, 100)], &only_forced, &PREVIOUS),
        Err(EvmBatchError::DepositCountMismatch { block: 1, queue: 0 })
    );
}

#[test]
fn queue_segment_is_limited() {
    let item = QueueItem::ForcedTransaction(vec![1]);
    let full = vec![item.clone(); MAX_BATCH_QUEUE_ITEMS];
    assert!(check_queue(&[], &full, &PREVIOUS).is_ok());
    let over = vec![item; MAX_BATCH_QUEUE_ITEMS + 1];
    assert_eq!(check_queue(&[], &over, &PREVIOUS), Err(EvmBatchError::TooManyQueueItems(MAX_BATCH_QUEUE_ITEMS + 1)));
}

#[test]
fn forced_transaction_hash_is_the_marker_and_keccak_of_the_bytes() {
    let bytes = b"any bytes at all".to_vec();
    let mut marker = [0u8; 32];
    marker[0] = 0x80;
    assert_eq!(FORCED_TRANSACTION_MARKER, marker);
    assert_eq!(forced_transaction_hash(&PREVIOUS, &bytes), sha256(&[&PREVIOUS, &marker, &keccak256(&bytes).0]));
    // Депозит с теми же «полями» метку дать не может: получатель — 160 бит.
    assert_ne!(forced_transaction_hash(&PREVIOUS, &bytes), deposit_hash(&PREVIOUS, &deposit(0x80, 1)));
}

// ---------------------------------------------------------------- данные батча

#[test]
fn data_chunks_must_concatenate_to_the_block() {
    let encoded: Vec<u8> = (0u8..200).collect();
    let split = |at: usize| vec![encoded[..at].to_vec(), encoded[at..].to_vec()];
    // Границы порций произвольны.
    assert_eq!(check_block_data(&encoded, &[encoded.clone()]), Ok(()));
    assert_eq!(check_block_data(&encoded, &split(1)), Ok(()));
    assert_eq!(check_block_data(&encoded, &split(127)), Ok(()));

    // Недостающий хвост, лишний хвост, изменённый байт, отсутствие данных.
    assert_eq!(check_block_data(&encoded, &[encoded[..199].to_vec()]), Err(EvmBatchError::DataMismatch));
    let mut longer = encoded.clone();
    longer.push(0);
    assert_eq!(check_block_data(&encoded, &[longer]), Err(EvmBatchError::DataMismatch));
    let mut changed = split(100);
    changed[1][0] ^= 1;
    assert_eq!(check_block_data(&encoded, &changed), Err(EvmBatchError::DataMismatch));
    assert_eq!(check_block_data(&encoded, &[]), Err(EvmBatchError::DataMismatch));
}

// ---------------------------------------------------------------- дерево выводов

/// Числа листьев для сверки: 0, 1, 2, 3 и вокруг степеней двойки.
const LEAF_COUNTS: [usize; 19] = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 129];

#[test]
fn frontier_root_equals_the_full_recomputation() {
    // Полный пересчёт — функция игрушечного реестра (zkvm/lib), с которой сверен контракт.
    for count in LEAF_COUNTS {
        let leaves = leaves(count);
        let full: Vec<rollup_stf::WithdrawalLeaf> = leaves
            .iter()
            .map(|leaf| rollup_stf::WithdrawalLeaf { recipient_hash: leaf.recipient_hash, amount: leaf.amount })
            .collect();
        let tree = tree_of(&leaves);
        assert_eq!(tree.count(), count as u64);
        assert_eq!(tree.root(), rollup_stf::withdrawals_root(&full), "листьев: {count}");
        // Фронтир после дозаписи — канонический: его принимает разбор входа и даёт тот же корень.
        let reread = WithdrawalTree::from_input(*tree.frontier(), tree.count()).unwrap();
        assert_eq!(reread, tree);
    }
    assert_eq!(WithdrawalTree::empty().root(), [0u8; 32], "корень дерева без листьев — ноль");
}

#[test]
fn appending_in_two_batches_equals_appending_at_once() {
    // Батч продолжает дерево по фронтиру и счётчику из входа.
    let all = leaves(11);
    for split in [0usize, 1, 2, 3, 4, 7, 8, 10, 11] {
        let first = tree_of(&all[..split]);
        let mut second = WithdrawalTree::from_input(*first.frontier(), first.count()).unwrap();
        for leaf in &all[split..] {
            second.append(leaf).unwrap();
        }
        assert_eq!(second, tree_of(&all), "разрез после {split} листьев");
    }
}

#[test]
fn leaf_number_is_part_of_the_leaf_hash() {
    // Один и тот же вывод на разных местах — разные листья: иначе его можно было бы «повторить».
    let same = leaf(9, 123);
    assert_ne!(withdrawal_leaf_hash(0, &same), withdrawal_leaf_hash(1, &same));
    let tree = tree_of(&[same.clone(), same.clone()]);
    let single = withdrawal_leaf_hash(0, &same);
    assert_ne!(tree.root(), tree_of(&[same]).root());
    assert_eq!(tree.frontier()[1], sha256(&[&single, &withdrawal_leaf_hash(1, &leaf(9, 123))]));
}

#[test]
fn garbage_in_the_frontier_is_rejected() {
    for count in [0u64, 1, 2, 5, 8] {
        let tree = tree_of(&leaves(count as usize));
        for height in 0..WITHDRAWAL_TREE_DEPTH {
            let mut frontier = *tree.frontier();
            if (count >> height) & 1 == 1 {
                // На единичном бите элемент значим: другой элемент — другой корень (его не примет
                // контракт), но вход по форме годен.
                frontier[height][0] ^= 1;
                let forged = WithdrawalTree::from_input(frontier, count).unwrap();
                assert_ne!(forged.root(), tree.root());
            } else {
                frontier[height][31] = 1;
                assert_eq!(
                    WithdrawalTree::from_input(frontier, count),
                    Err(FrontierError::NonCanonical(height)),
                    "листьев: {count}, уровень: {height}"
                );
            }
        }
    }
}

#[test]
fn the_same_root_with_another_count_needs_the_count_word() {
    // Атака из раздела 4: при настоящем счётчике 2 вход «счётчик 2^i, на месте i — корень
    // левого поддерева высоты i» даёт ТОТ ЖЕ корень. Отличает их только счётчик — поэтому он
    // отдельное слово публичных значений (подставляет контракт).
    let honest = tree_of(&leaves(2));
    for height in [2usize, 5, 31] {
        // Корень левого поддерева высоты `height` дерева из двух листьев.
        let mut node = honest.frontier()[1];
        let mut empty = sha256(&[&[0u8; 32], &[0u8; 32]]);
        for _ in 1..height {
            node = sha256(&[&node, &empty]);
            empty = sha256(&[&empty, &empty]);
        }
        let mut frontier = [[0u8; 32]; WITHDRAWAL_TREE_DEPTH];
        frontier[height] = node;
        let forged = WithdrawalTree::from_input(frontier, 1 << height).unwrap();
        assert_eq!(forged.root(), honest.root(), "тот же корень при счётчике 2^{height}");
        assert_ne!(forged.count(), honest.count());
    }
}

#[test]
fn counter_is_limited_to_the_tree() {
    let frontier = [[1u8; 32]; WITHDRAWAL_TREE_DEPTH];
    assert_eq!(MAX_WITHDRAWALS, (1u64 << 32) - 1);
    // Полное по счётчику дерево — допустимый вход, но листу в нём места нет.
    let mut full = WithdrawalTree::from_input(frontier, MAX_WITHDRAWALS).unwrap();
    assert_ne!(full.root(), [0u8; 32]);
    assert_eq!(full.append(&leaf(1, 1)), Err(FrontierError::TreeFull));
    assert_eq!(full.count(), MAX_WITHDRAWALS);
    // Предпоследний лист помещается.
    let mut almost = *full.frontier();
    almost[0] = [0u8; 32];
    let mut tree = WithdrawalTree::from_input(almost, MAX_WITHDRAWALS - 1).unwrap();
    assert_eq!(tree.append(&leaf(1, 1)), Ok(()));
    assert_eq!(tree.count(), MAX_WITHDRAWALS);
    // Счётчик за пределом: 2^32 дал бы корень как у пустого по битам дерева.
    assert_eq!(WithdrawalTree::from_input([[0u8; 32]; 32], MAX_WITHDRAWALS + 1), Err(FrontierError::CountOutOfRange));
    assert_eq!(WithdrawalTree::from_input(frontier, u64::MAX), Err(FrontierError::CountOutOfRange));
}

// ---------------------------------------------------------------- мост

fn bridge_log(topics: Vec<B256>, data: Vec<u8>) -> Log {
    Log { address: BRIDGE_ADDRESS, data: LogData::new_unchecked(topics, Bytes::from(data)) }
}

fn sender_topic(byte: u8) -> B256 {
    let mut topic = [0u8; 32];
    topic[12..].copy_from_slice(&[byte; 20]);
    B256::from(topic)
}

fn log_data(recipient: Hash, nanotons: u128) -> Vec<u8> {
    [recipient.as_slice(), word(nanotons).as_slice()].concat()
}

#[test]
fn bridge_constants_follow_from_the_bytecode() {
    assert_eq!(keccak256(BRIDGE_CODE), BRIDGE_CODE_HASH);
    assert_eq!(keccak256("Withdrawal(address,bytes32,uint256)"), WITHDRAWAL_TOPIC);
    assert_eq!(BRIDGE_ADDRESS.as_slice(), b"ton-zk-rollup-bridge");
    // Константы внутри кода: событие — аргумент PUSH32, наименьшая сумма — PUSH4, нанотон — PUSH4.
    assert_eq!(BRIDGE_CODE[44], 0x7f);
    assert_eq!(BRIDGE_CODE[45..77], WITHDRAWAL_TOPIC.0);
    assert_eq!(BRIDGE_CODE[25], 0x63);
    assert_eq!(BRIDGE_CODE[26..30], (MIN_WITHDRAWAL_NANOTONS as u32).to_be_bytes());
    assert_eq!(BRIDGE_CODE[8..12], 1_000_000_000u32.to_be_bytes());
    assert_eq!(BRIDGE_CODE[18..22], 1_000_000_000u32.to_be_bytes());
    // Все три условных перехода ведут на JUMPDEST отказа; в коде нет вызовов и самоуничтожения.
    assert_eq!(BRIDGE_CODE[0x53], 0x5b);
    assert_eq!(BRIDGE_CODE[0x53..], [0x5b, 0x60, 0x00, 0x60, 0x00, 0xfd]);
    for jump in [6usize, 16, 33] {
        assert_eq!(BRIDGE_CODE[jump - 2..=jump], [0x60, 0x53, 0x57], "PUSH1 0x53 JUMPI");
    }
    // Опкоды по порядку (аргументы PUSH пропущены): среди них нет CALL, CALLCODE, DELEGATECALL,
    // STATICCALL, CREATE, CREATE2, SELFDESTRUCT, SSTORE.
    let mut opcodes = Vec::new();
    let mut offset = 0;
    while offset < BRIDGE_CODE.len() {
        let opcode = BRIDGE_CODE[offset];
        opcodes.push(opcode);
        offset += 1 + if (0x60..=0x7f).contains(&opcode) { (opcode - 0x5f) as usize } else { 0 };
    }
    assert_eq!(offset, BRIDGE_CODE.len());
    for forbidden in [0xf0u8, 0xf1, 0xf2, 0xf4, 0xf5, 0xfa, 0xff, 0x55] {
        assert!(!opcodes.contains(&forbidden), "опкод {forbidden:#x}");
    }
}

#[test]
fn withdrawal_is_read_from_the_bridge_log() {
    let recipient = leaf(4, 0).recipient_hash;
    let log = bridge_log(vec![WITHDRAWAL_TOPIC, sender_topic(9)], log_data(recipient, 250_000_000));
    assert_eq!(withdrawal_from_log(&log), Ok(WithdrawalLeaf { recipient_hash: recipient, amount: 250_000_000 }));
}

#[test]
fn bridge_log_of_another_shape_is_an_error() {
    let recipient = [3u8; 32];
    let honest = (vec![WITHDRAWAL_TOPIC, sender_topic(9)], log_data(recipient, 100_000_000));
    assert!(withdrawal_from_log(&bridge_log(honest.0.clone(), honest.1.clone())).is_ok());

    let mut other_event = honest.0.clone();
    other_event[0].0[0] ^= 1;
    let mut wide_sender = honest.0.clone();
    wide_sender[1].0[0] = 1;
    let mut huge_amount = honest.1.clone();
    huge_amount[32] = 1;
    let cases: Vec<(Vec<B256>, Vec<u8>)> = vec![
        (vec![WITHDRAWAL_TOPIC], honest.1.clone()),
        (vec![WITHDRAWAL_TOPIC, sender_topic(9), B256::ZERO], honest.1.clone()),
        (vec![], honest.1.clone()),
        (other_event, honest.1.clone()),
        (wide_sender, honest.1.clone()),
        (honest.0.clone(), honest.1[..63].to_vec()),
        (honest.0.clone(), [honest.1.clone(), vec![0]].concat()),
        (honest.0.clone(), vec![]),
        (honest.0.clone(), huge_amount),
    ];
    for (topics, data) in cases {
        assert_eq!(withdrawal_from_log(&bridge_log(topics.clone(), data.clone())), Err(MalformedBridgeLog), "{topics:?} {data:?}");
    }
}

#[test]
fn withdrawals_are_the_bridge_logs_in_block_order() {
    let other = Log {
        address: Address::from([7u8; 20]),
        data: LogData::new_unchecked(vec![WITHDRAWAL_TOPIC, sender_topic(1)], Bytes::from(log_data([9u8; 32], 1))),
    };
    let log = |byte: u8, amount: u128| bridge_log(vec![WITHDRAWAL_TOPIC, sender_topic(byte)], log_data([byte; 32], amount));
    let receipt = |logs: Vec<Log>| Receipt { tx_type: alloy_consensus::TxType::Legacy, success: true, cumulative_gas_used: 0, logs };
    let receipts = vec![
        receipt(vec![log(1, 10), other.clone(), log(2, 20)]),
        receipt(vec![]),
        receipt(vec![other.clone()]),
        receipt(vec![log(3, 30)]),
    ];
    let expected: Vec<WithdrawalLeaf> =
        [(1u8, 10u128), (2, 20), (3, 30)].iter().map(|(b, a)| WithdrawalLeaf { recipient_hash: [*b; 32], amount: *a }).collect();
    // Лог с тем же событием, но с чужого адреса (DELEGATECALL в мост) выводом не считается.
    assert_eq!(bridge_withdrawals(&receipts), Ok(expected));
    // Негодный лог моста — ошибка, даже если остальные годны.
    let mut broken = receipts;
    broken[1].logs.push(bridge_log(vec![WITHDRAWAL_TOPIC], vec![]));
    assert_eq!(bridge_withdrawals(&broken), Err(MalformedBridgeLog));
}

// ---------------------------------------------------------------- заголовок

fn policy_header() -> Header {
    Header { gas_limit: GAS_LIMIT, parent_beacon_block_root: Some(B256::ZERO), ..Default::default() }
}

#[test]
fn header_fields_left_to_the_builder_are_fixed() {
    assert_eq!(check_header_policy(&policy_header()), Ok(()));
    // Получатель чаевых свободен.
    let free = Header { beneficiary: Address::from([5u8; 20]), ..policy_header() };
    assert_eq!(check_header_policy(&free), Ok(()));

    let cases: Vec<(Header, &str)> = vec![
        (Header { gas_limit: GAS_LIMIT + 1, ..policy_header() }, "gas_limit"),
        (Header { gas_limit: GAS_LIMIT - 1, ..policy_header() }, "gas_limit"),
        (Header { mix_hash: B256::repeat_byte(1), ..policy_header() }, "mix_hash"),
        (Header { extra_data: Bytes::from_static(&[0]), ..policy_header() }, "extra_data"),
        (Header { parent_beacon_block_root: Some(B256::repeat_byte(1)), ..policy_header() }, "parent_beacon_block_root"),
        (Header { parent_beacon_block_root: None, ..policy_header() }, "parent_beacon_block_root"),
    ];
    for (header, field) in cases {
        assert_eq!(check_header_policy(&header), Err(EvmBatchError::HeaderPolicy(field)));
    }
}

#[test]
fn forced_transactions_of_a_full_segment_always_fit_the_block() {
    // На этом держится недостижимость ошибки «не помещается по газу блока».
    assert!(MAX_BATCH_QUEUE_ITEMS as u64 * FORCED_TX_GAS_CAP <= GAS_LIMIT);
}

// ---------------------------------------------------------------- сторож: zkvm/lib и TypeScript

fn stf_deposit(deposit: &Deposit) -> rollup_stf::Deposit {
    rollup_stf::Deposit { l2_recipient: deposit.l2_recipient, amount: deposit.amount }
}

fn sample_data(length: usize) -> Vec<u8> {
    (0..length).map(|index| (index * 31 + 7) as u8).collect()
}

/// Длины порций вокруг границ раскладки: ячейка — 127 байт, у ячейки четыре ссылки.
const DATA_LENGTHS: [usize; 12] = [0, 1, 126, 127, 128, 254, 508, 635, 636, 2667, 5000, 60_000];

fn sample_values() -> PublicValues {
    PublicValues {
        chain_id: 362107787851,
        prev_state_root: [0x11; 32],
        new_state_root: [0x22; 32],
        batch_hash: [0x33; 32],
        prev_withdrawals_root: [0x44; 32],
        withdrawals_root: [0x55; 32],
        prev_deposit_hash: [0x66; 32],
        new_deposit_hash: [0x77; 32],
        prev_withdrawals_count: 0x0102030405,
        withdrawals_count: 0x0102030406,
        block_timestamp: 1_794_000_000,
    }
}

#[test]
fn ported_protocol_functions_equal_the_toy_ledger_library() {
    // Перенесённое из zkvm/lib обязано давать те же байты: по нему построены контракт и TS.
    for deposit in [deposit(1, 0), deposit(0xfe, 1), deposit(7, u64::MAX as u128), deposit(9, u128::MAX)] {
        assert_eq!(deposit_hash(&PREVIOUS, &deposit), rollup_stf::deposit_hash(&PREVIOUS, &stf_deposit(&deposit)));
    }
    for length in DATA_LENGTHS {
        let data = sample_data(length);
        assert_eq!(data_chunk_hash(&data), rollup_stf::data_chunk_hash(&data), "порция {length} байт");
    }
    assert_eq!(data_hash_step(&PREVIOUS, &[9u8; 32]), rollup_stf::data_hash_step(&PREVIOUS, &[9u8; 32]));
    let chunks = vec![sample_data(300), sample_data(0), sample_data(5000)];
    assert_eq!(batch_data_hash(&chunks).unwrap(), rollup_stf::batch_data_hash(&chunks).unwrap());
    assert_eq!(batch_data_hash(&[]).unwrap(), [0u8; 32]);
    assert_eq!(crate::MAX_DATA_CHUNK_BYTES, rollup_stf::MAX_DATA_CHUNK_BYTES);
    assert!(batch_data_hash(&[vec![0u8; crate::MAX_DATA_CHUNK_BYTES + 1]]).is_err());
    assert!(batch_data_hash(&[vec![0u8; crate::MAX_DATA_CHUNK_BYTES]]).is_ok());

    for (index, amount) in [(0u32, 1u128), (1, 50_000_000), (u32::MAX, u128::MAX)] {
        let ours = WithdrawalLeaf { recipient_hash: [index as u8 ^ 0x5a; 32], amount };
        let theirs = rollup_stf::WithdrawalLeaf { recipient_hash: ours.recipient_hash, amount };
        assert_eq!(withdrawal_leaf_hash(index, &ours), rollup_stf::withdrawal_leaf_hash(index, &theirs));
    }
    assert_eq!(WITHDRAWAL_TREE_DEPTH, rollup_stf::WITHDRAWAL_TREE_DEPTH);

    // Порядок вариантов QueueItem — часть формата входа.
    let item = deposit(3, 77);
    assert_eq!(
        bincode::serialize(&QueueItem::Deposit(item.clone())).unwrap(),
        bincode::serialize(&rollup_stf::QueueItem::Deposit(stf_deposit(&item))).unwrap()
    );
    assert_eq!(
        bincode::serialize(&QueueItem::ForcedTransaction(vec![1, 2, 3])).unwrap(),
        bincode::serialize(&rollup_stf::QueueItem::ForcedTransaction(vec![1, 2, 3])).unwrap()
    );
}

#[test]
fn public_values_are_eleven_words_with_the_first_eight_as_before() {
    let values = sample_values();
    let bytes = values.to_bytes();
    assert_eq!(bytes.len(), 352);
    assert_eq!(PUBLIC_VALUES_BYTES, 352);
    let old = rollup_stf::PublicValues {
        chain_id: values.chain_id,
        prev_state_root: values.prev_state_root,
        new_state_root: values.new_state_root,
        batch_hash: values.batch_hash,
        prev_withdrawals_root: values.prev_withdrawals_root,
        withdrawals_root: values.withdrawals_root,
        prev_deposit_hash: values.prev_deposit_hash,
        new_deposit_hash: values.new_deposit_hash,
    };
    assert_eq!(bytes[..256], old.to_bytes());
    assert_eq!(bytes[256..288], word(values.prev_withdrawals_count as u128));
    assert_eq!(bytes[288..320], word(values.withdrawals_count as u128));
    assert_eq!(bytes[320..352], word(values.block_timestamp as u128));
    // Каждое слово различимо: смена любого поля меняет ровно своё слово.
    let changed: Vec<PublicValues> = vec![
        PublicValues { chain_id: 1, ..values.clone() },
        PublicValues { prev_state_root: [1; 32], ..values.clone() },
        PublicValues { new_state_root: [1; 32], ..values.clone() },
        PublicValues { batch_hash: [1; 32], ..values.clone() },
        PublicValues { prev_withdrawals_root: [1; 32], ..values.clone() },
        PublicValues { withdrawals_root: [1; 32], ..values.clone() },
        PublicValues { prev_deposit_hash: [1; 32], ..values.clone() },
        PublicValues { new_deposit_hash: [1; 32], ..values.clone() },
        PublicValues { prev_withdrawals_count: 1, ..values.clone() },
        PublicValues { withdrawals_count: 1, ..values.clone() },
        PublicValues { block_timestamp: 1, ..values.clone() },
    ];
    for (index, other) in changed.iter().enumerate() {
        let other = other.to_bytes();
        for word in 0..11 {
            let same = other[word * 32..(word + 1) * 32] == bytes[word * 32..(word + 1) * 32];
            assert_eq!(same, word != index, "поле {index}, слово {word}");
        }
    }
    // Дайджест: sha256 всех байтов без трёх старших бит.
    let mut digest = sha256(&[&bytes]);
    digest[0] &= 0x1f;
    assert_eq!(values.digest(), digest);
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// Значения для сверки с `wrappers/rollupMath.ts` (тест на TypeScript читает этот файл).
fn protocol_vectors() -> Value {
    let values = sample_values();
    let forced = sample_data(300);
    let frontier = |tree: &WithdrawalTree| tree.frontier().iter().map(|node| hex(node)).collect::<Vec<_>>();
    let mut tree = WithdrawalTree::empty();
    let mut appended = Vec::new();
    for (index, leaf) in leaves(9).iter().enumerate() {
        let leaf_hash = withdrawal_leaf_hash(index as u32, leaf);
        tree.append(leaf).unwrap();
        appended.push(json!({
            "leafIndex": index,
            "recipientHash": hex(&leaf.recipient_hash),
            "amount": leaf.amount.to_string(),
            "leafHash": hex(&leaf_hash),
            "countAfter": tree.count().to_string(),
            "frontierAfter": frontier(&tree),
            "rootAfter": hex(&tree.root()),
        }));
    }
    let chunks = vec![sample_data(300), sample_data(0), sample_data(5000)];
    json!({
        "source": "Сгенерировано тестом zkvm-evm/lib (protocol_vectors_fixture_is_current); не редактировать вручную",
        "note": "Значения программы zkVM для сверки с wrappers/rollupMath.ts: batchDigest, depositHash, forcedTransactionHash, фронтир дерева выводов, dataChunkCell.",
        "previous": hex(&PREVIOUS),
        "publicValues": {
            "chainId": values.chain_id.to_string(),
            "prevStateRoot": hex(&values.prev_state_root),
            "newStateRoot": hex(&values.new_state_root),
            "batchHash": hex(&values.batch_hash),
            "prevWithdrawalsRoot": hex(&values.prev_withdrawals_root),
            "withdrawalsRoot": hex(&values.withdrawals_root),
            "prevDepositHash": hex(&values.prev_deposit_hash),
            "newDepositHash": hex(&values.new_deposit_hash),
            "prevWithdrawalsCount": values.prev_withdrawals_count.to_string(),
            "withdrawalsCount": values.withdrawals_count.to_string(),
            "blockTimestamp": values.block_timestamp.to_string(),
            "bytes": hex(&values.to_bytes()),
            "digest": hex(&values.digest()),
        },
        "deposit": {
            "l2Recipient": hex(&[0xabu8; 20]),
            "amount": "1500000000",
            "hash": hex(&deposit_hash(&PREVIOUS, &deposit(0xab, 1_500_000_000))),
        },
        "forcedTransaction": {
            "bytes": hex(&forced),
            "keccak": hex(&keccak256(&forced).0),
            "hash": hex(&forced_transaction_hash(&PREVIOUS, &forced)),
        },
        "withdrawals": appended,
        "dataChunks": DATA_LENGTHS.iter().filter(|length| **length <= 5000).map(|length| {
            let data = sample_data(*length);
            json!({ "data": hex(&data), "cellHash": hex(&data_chunk_hash(&data)) })
        }).collect::<Vec<_>>(),
        "batchData": {
            "chunks": chunks.iter().map(|chunk| hex(chunk)).collect::<Vec<_>>(),
            "hash": hex(&batch_data_hash(&chunks).unwrap()),
        },
        "constants": {
            "bridgeAddress": hex(BRIDGE_ADDRESS.as_slice()),
            "bridgeCode": hex(&BRIDGE_CODE),
            "bridgeCodeHash": hex(&BRIDGE_CODE_HASH.0),
            "withdrawalTopic": hex(&WITHDRAWAL_TOPIC.0),
            "minWithdrawalNanotons": MIN_WITHDRAWAL_NANOTONS.to_string(),
            "gasLimit": GAS_LIMIT.to_string(),
            "forcedTxGasCap": FORCED_TX_GAS_CAP.to_string(),
            "maxBatchQueueItems": MAX_BATCH_QUEUE_ITEMS,
            "maxWithdrawals": MAX_WITHDRAWALS.to_string(),
        },
    })
}

#[test]
fn protocol_vectors_fixture_is_current() {
    // Файл читает тест на TypeScript. Обновить: ROLLUP_EVM_WRITE_VECTORS=1 cargo test … protocol_vectors
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/evm_batches/protocol-vectors.json");
    let text = serde_json::to_string_pretty(&protocol_vectors()).unwrap() + "\n";
    if std::env::var("ROLLUP_EVM_WRITE_VECTORS").is_ok() {
        fs::write(&path, &text).unwrap();
    }
    let on_disk = fs::read_to_string(&path).expect("нет fixtures/evm_batches/protocol-vectors.json");
    assert_eq!(on_disk, text, "фикстура устарела: перезапишите её (ROLLUP_EVM_WRITE_VECTORS=1)");
}

#[test]
fn amounts_and_counts_are_hashed_as_big_endian_words() {
    assert_eq!(word(1)[31], 1);
    assert_eq!(word(1)[..31], [0u8; 31]);
    assert_eq!(word(u128::MAX)[..16], [0u8; 16]);
    let amount = U256::from(0x0102u64);
    assert_eq!(word(0x0102).as_slice(), amount.to_be_bytes::<32>().as_slice());
}

// ---------------------------------------------------------------- генезис

#[test]
fn genesis_constants_follow_from_the_bridge_account() {
    use alloy_trie::{HashBuilder, Nibbles, EMPTY_ROOT_HASH};
    use reth_trie::TrieAccount;

    use crate::genesis::{genesis_header, GENESIS_HASH, GENESIS_STATE_ROOT};

    // Состояние генезиса — один счёт: мост с кодом, nonce 1, без баланса и хранилища.
    let bridge = TrieAccount { nonce: 1, balance: U256::ZERO, storage_root: EMPTY_ROOT_HASH, code_hash: BRIDGE_CODE_HASH };
    let mut builder = HashBuilder::default();
    builder.add_leaf(Nibbles::unpack(keccak256(BRIDGE_ADDRESS)), &alloy_rlp::encode(bridge));
    assert_eq!(builder.root(), GENESIS_STATE_ROOT, "корень состояния генезиса");
    let header = genesis_header();
    assert_eq!(header.hash_slow(), GENESIS_HASH, "хеш заголовка генезиса");
    // Заголовок генезиса сам соблюдает закреплённые поля.
    assert_eq!(check_header_policy(&header), Ok(()));
    assert_eq!((header.number, header.timestamp, header.gas_used), (0, 0, 0));
}

// ---------------------------------------------------------------- принудительные транзакции

#[test]
fn revm_refusals_are_classified_by_a_closed_list() {
    use revm::context_interface::result::InvalidTransaction as Refusal;

    use crate::{execute::classify_invalid, InvalidReason};

    // Причины пропуска: достижимы для транзакции, годной по форме.
    let skipped: Vec<(Refusal, InvalidReason)> = vec![
        (Refusal::NonceTooLow { tx: 0, state: 1 }, InvalidReason::NonceTooLow),
        (Refusal::NonceTooHigh { tx: 2, state: 1 }, InvalidReason::NonceTooHigh),
        (Refusal::NonceOverflowInTransaction, InvalidReason::NonceOverflow),
        (
            Refusal::LackOfFundForMaxFee { fee: Box::new(U256::from(2u8)), balance: Box::new(U256::from(1u8)) },
            InvalidReason::LackOfFunds,
        ),
        (Refusal::OverflowPaymentInTransaction, InvalidReason::PaymentOverflow),
        (Refusal::RejectCallerWithCode, InvalidReason::SenderHasCode),
        (Refusal::GasPriceLessThanBasefee, InvalidReason::GasPriceBelowBaseFee),
        (Refusal::PriorityFeeGreaterThanMaxFee, InvalidReason::PriorityFeeAboveMaxFee),
        (Refusal::CallGasCostMoreThanGasLimit { initial_gas: 2, gas_limit: 1 }, InvalidReason::IntrinsicGas),
    ];
    for (refusal, reason) in skipped {
        assert_eq!(classify_invalid(&refusal), Some(reason), "{refusal:?}");
    }
    // Всё остальное — ошибка батча: после проверок формы недостижимо, и молчаливый пропуск
    // скрыл бы расхождение программы с узлом.
    let batch_errors = vec![
        Refusal::TxGasLimitGreaterThanCap { gas_limit: 2, cap: 1 },
        Refusal::CallerGasLimitMoreThanBlock,
        Refusal::GasFloorMoreThanGasLimit { gas_floor: 2, gas_limit: 1 },
        Refusal::InvalidChainId,
        Refusal::MissingChainId,
        Refusal::CreateInitCodeSizeLimit,
        Refusal::AccessListNotSupported,
        Refusal::Eip2930NotSupported,
        Refusal::Eip1559NotSupported,
        Refusal::Eip4844NotSupported,
        Refusal::Eip7702NotSupported,
        Refusal::BlobVersionedHashesNotSupported,
        Refusal::MaxFeePerBlobGasNotSupported,
        Refusal::EmptyBlobs,
        Refusal::BlobCreateTransaction,
        Refusal::BlobVersionNotSupported,
        Refusal::TooManyBlobs { max: 1, have: 2 },
        Refusal::BlobGasPriceGreaterThanMax { block_blob_gas_price: 2, tx_max_fee_per_blob_gas: 1 },
        Refusal::AuthorizationListNotSupported,
        Refusal::AuthorizationListInvalidFields,
        Refusal::EmptyAuthorizationList,
        Refusal::Str("другое".into()),
    ];
    for refusal in batch_errors {
        assert_eq!(classify_invalid(&refusal), None, "{refusal:?}");
    }
}

/// Вход батча из фикстуры сценария Reth.
fn reth_batch(block: u64) -> crate::EvmBatchInput {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../fixtures/evm_batches/reth/block-{block}.bin"));
    bincode::deserialize(&fs::read(path).expect("нет фикстуры: запустите zkvm-evm/scenario/reth-scenario.mjs")).unwrap()
}

/// Вызов моста с заданным лимитом газа, подписанный тестовым ключом (счёта в цепочке нет).
fn signed_bridge_call(gas_limit: u64) -> Vec<u8> {
    use alloy_consensus::{SignableTransaction, TxEip1559};
    use alloy_eips::eip2718::Encodable2718;
    use alloy_primitives::{Signature, TxKind};
    use reth_ethereum_primitives::TransactionSigned;

    let transaction = TxEip1559 {
        chain_id: 362107787851,
        nonce: 0,
        gas_limit,
        max_fee_per_gas: 2_000_000_000,
        max_priority_fee_per_gas: 1_000_000_000,
        to: TxKind::Call(BRIDGE_ADDRESS),
        value: U256::ZERO,
        input: Bytes::copy_from_slice(&[0x5a; 32]),
        access_list: Default::default(),
    };
    let key = k256::ecdsa::SigningKey::from_slice(&[1u8; 32]).unwrap();
    let (signature, recovery) = key.sign_prehash_recoverable(transaction.signature_hash().as_slice()).unwrap();
    let signature = Signature::new(
        U256::from_be_slice(&signature.r().to_bytes()),
        U256::from_be_slice(&signature.s().to_bytes()),
        recovery.is_y_odd(),
    );
    let signed: TransactionSigned = transaction.into_signed(signature).into();
    signed.encoded_2718()
}

#[test]
fn forced_transaction_that_does_not_fit_the_block_is_a_batch_error() {
    use crate::{process_evm_batch, process_with_gas_cap, ForcedOutcome, SkipReason};

    // С пределом протокола ошибка недостижима (предел × отрезок ≤ лимита блока), поэтому предел
    // здесь снят. Блок 6 сценария пуст; в очередь встаёт вызов моста с лимитом газа больше
    // лимита блока. Не пропуск: секвенсор обязан был закончить отрезок раньше.
    let mut input = reth_batch(6);
    assert!(input.block.current_block.body.transactions.is_empty() && input.queue_items.is_empty());
    input.queue_items = vec![QueueItem::ForcedTransaction(signed_bridge_call(GAS_LIMIT + 1))];
    assert_eq!(
        process_with_gas_cap(input.clone(), u64::MAX).map(|outcome| outcome.forced),
        Err(EvmBatchError::ForcedTransactionDoesNotFit(0))
    );
    // С пределом протокола тот же элемент — пропуск по форме, и батч годен.
    let outcome = process_evm_batch(input).unwrap();
    assert_eq!(outcome.forced, [ForcedOutcome::Skipped(SkipReason::GasLimitAboveCap)]);
}
