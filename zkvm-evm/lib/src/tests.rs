//! Тесты чистых функций батча EVM. Тесты на настоящих блоках — в `tests/blocks.rs`
//! (им нужны фикстуры из `fixtures/evm_batches/`).
use alloy_eips::eip4895::Withdrawal;
use alloy_primitives::Address;
use rollup_stf::deposit_hash;

use crate::{check_block_data, check_deposits, Deposit, EvmBatchError, QueueItem};

fn deposit(recipient: u8, amount: u128) -> Deposit {
    Deposit { l2_recipient: [recipient; 20], amount }
}

fn credit(index: u64, recipient: u8, amount: u64) -> Withdrawal {
    Withdrawal { index, validator_index: 0, address: Address::from([recipient; 20]), amount }
}

fn queue(deposits: &[Deposit]) -> Vec<QueueItem> {
    deposits.iter().cloned().map(QueueItem::Deposit).collect()
}

/// Ненулевой прежний хеш: с нулевым не видно, что он участвует в цепочке.
const PREVIOUS: [u8; 32] = [7u8; 32];

#[test]
fn deposits_matching_the_queue_extend_its_hash() {
    let deposits = [deposit(1, 1_000_000_000), deposit(2, 500_000_000)];
    let credits = [credit(0, 1, 1_000_000_000), credit(1, 2, 500_000_000)];
    let expected = deposit_hash(&deposit_hash(&PREVIOUS, &deposits[0]), &deposits[1]);
    assert_eq!(check_deposits(&credits, &queue(&deposits), &PREVIOUS), Ok(expected));
    // Без депозитов хеш очереди не меняется.
    assert_eq!(check_deposits(&[], &[], &PREVIOUS), Ok(PREVIOUS));
}

#[test]
fn extra_or_missing_credit_is_rejected() {
    let deposits = [deposit(1, 100)];
    // Лишнее зачисление — монеты из воздуха.
    let extra = [credit(0, 1, 100), credit(1, 9, 1_000_000)];
    assert_eq!(
        check_deposits(&extra, &queue(&deposits), &PREVIOUS),
        Err(EvmBatchError::DepositCountMismatch { block: 2, queue: 1 })
    );
    // Пропущенное — депозит из очереди не зачислен.
    assert_eq!(
        check_deposits(&[], &queue(&deposits), &PREVIOUS),
        Err(EvmBatchError::DepositCountMismatch { block: 0, queue: 1 })
    );
}

#[test]
fn credit_must_equal_the_deposit_field_by_field() {
    let deposits = [deposit(1, 100), deposit(2, 200)];
    let items = queue(&deposits);
    let honest = [credit(0, 1, 100), credit(1, 2, 200)];
    assert!(check_deposits(&honest, &items, &PREVIOUS).is_ok());

    let mut other_recipient = honest.clone();
    other_recipient[1].address = Address::from([3u8; 20]);
    assert_eq!(check_deposits(&other_recipient, &items, &PREVIOUS), Err(EvmBatchError::DepositMismatch(1)));

    let mut other_amount = honest.clone();
    other_amount[0].amount = 101;
    assert_eq!(check_deposits(&other_amount, &items, &PREVIOUS), Err(EvmBatchError::DepositMismatch(0)));

    let mut other_index = honest.clone();
    other_index[1].index = 5;
    assert_eq!(check_deposits(&other_index, &items, &PREVIOUS), Err(EvmBatchError::DepositMismatch(1)));

    let mut other_validator = honest.clone();
    other_validator[0].validator_index = 1;
    assert_eq!(check_deposits(&other_validator, &items, &PREVIOUS), Err(EvmBatchError::DepositMismatch(0)));

    // Те же депозиты в другом порядке — другая очередь.
    let swapped = [credit(0, 2, 200), credit(1, 1, 100)];
    assert_eq!(check_deposits(&swapped, &items, &PREVIOUS), Err(EvmBatchError::DepositMismatch(0)));
}

#[test]
fn deposit_beyond_64_bits_and_forced_transaction_are_rejected() {
    let huge = [deposit(1, u64::MAX as u128 + 1)];
    assert_eq!(
        check_deposits(&[credit(0, 1, 0)], &queue(&huge), &PREVIOUS),
        Err(EvmBatchError::DepositTooLarge(0))
    );
    let forced = [QueueItem::ForcedTransaction(vec![1, 2, 3])];
    assert_eq!(
        check_deposits(&[credit(0, 1, 0)], &forced, &PREVIOUS),
        Err(EvmBatchError::ForcedTransactionsNotSupported)
    );
}

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
