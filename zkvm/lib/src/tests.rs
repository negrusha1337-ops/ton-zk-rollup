//! Тесты перехода состояния: что батч делает и, главное, чего он сделать не даёт.
use alloc::vec::Vec;
use k256::ecdsa::SigningKey;

use super::*;

const CHAIN: u64 = 77;

fn key(byte: u8) -> SigningKey {
    SigningKey::from_slice(&[byte; 32]).unwrap()
}

fn address(byte: u8) -> L2Address {
    address_of(key(byte).verifying_key())
}

/// Счета, отсортированные по адресу, как требует вход батча.
fn accounts(list: &[(u8, u128, u64)]) -> Vec<Account> {
    let mut out: Vec<Account> =
        list.iter().map(|&(who, balance, nonce)| Account { address: address(who), balance, nonce }).collect();
    out.sort_by_key(|account| account.address);
    out
}

fn batch(state: Vec<Account>, transactions: &[SignedTransaction]) -> BatchInput {
    BatchInput {
        chain_id: CHAIN,
        accounts: state,
        prev_deposit_hash: [0u8; 32],
        deposits: Vec::new(),
        data_chunks: alloc::vec![encode_transactions(transactions)],
        prior_withdrawals: Vec::new(),
    }
}

fn transfer(from: u8, nonce: u64, to: u8, amount: u128) -> SignedTransaction {
    sign_transaction(&key(from), CHAIN, nonce, Transaction::Transfer { to: address(to), amount })
}

fn balance_of(state: &[Account], who: u8) -> Option<u128> {
    state.iter().find(|account| account.address == address(who)).map(|account| account.balance)
}

#[test]
fn deposit_then_transfer_and_withdraw() {
    let withdraw =
        sign_transaction(&key(2), CHAIN, 0, Transaction::Withdraw { l1_recipient_hash: [7u8; 32], amount: 100 });
    let mut input = batch(Vec::new(), &[transfer(1, 0, 2, 300), withdraw]);
    input.deposits = alloc::vec![Deposit { l2_recipient: address(1), amount: 1000 }];

    let (values, state, withdrawals) = apply_batch(&input).unwrap();
    assert_eq!(balance_of(&state, 1), Some(700));
    assert_eq!(balance_of(&state, 2), Some(200));
    assert!(state.iter().all(|account| account.nonce == 1));
    assert_eq!(withdrawals.len(), 1);
    assert_eq!(values.chain_id, CHAIN);
    assert_eq!(values.prev_state_root, state_root(&[]));
    assert_eq!(values.new_state_root, state_root(&state));
    assert_ne!(values.new_deposit_hash, [0u8; 32]);
    assert_eq!(values.to_bytes().len(), PUBLIC_VALUES_BYTES);
    assert_eq!(values.digest()[0] & 0xe0, 0);
}

#[test]
fn nobody_can_spend_from_someone_elses_account() {
    // У жертвы (1) есть деньги. Злоумышленник (9) подписывает «перевод» своим ключом:
    // отправитель восстанавливается из подписи, поэтому списать можно только с себя.
    let state = accounts(&[(1, 1000, 0)]);
    let stolen = transfer(9, 0, 9, 1000);
    assert_eq!(apply_batch(&batch(state.clone(), &[stolen])).unwrap_err(), BatchError::UnknownSender);

    // Даже со счётом и деньгами злоумышленник тратит только свои.
    let state = accounts(&[(1, 1000, 0), (9, 50, 0)]);
    let (_, after, _) = apply_batch(&batch(state, &[transfer(9, 0, 2, 50)])).unwrap();
    assert_eq!(balance_of(&after, 1), Some(1000));
    assert_eq!(balance_of(&after, 9), Some(0));
}

#[test]
fn altered_transaction_does_not_touch_the_signer() {
    // Секвенсор берёт настоящую подпись жертвы и меняет сумму или получателя.
    let state = accounts(&[(1, 1000, 0)]);
    let mut bigger = transfer(1, 0, 2, 10);
    bigger.transaction = Transaction::Transfer { to: address(2), amount: 1000 };
    let mut redirected = transfer(1, 0, 2, 10);
    redirected.transaction = Transaction::Transfer { to: address(9), amount: 10 };
    for forged in [bigger, redirected] {
        // Подпись «принадлежит» уже другому адресу, у которого счёта нет.
        assert!(matches!(
            apply_batch(&batch(state.clone(), &[forged])).unwrap_err(),
            BatchError::UnknownSender | BatchError::BadSignature
        ));
    }
}

#[test]
fn transaction_cannot_be_replayed_or_reordered() {
    let state = accounts(&[(1, 1000, 0)]);
    let first = transfer(1, 0, 2, 10);
    // Повтор в том же батче.
    assert_eq!(apply_batch(&batch(state.clone(), &[first.clone(), first.clone()])).unwrap_err(), BatchError::BadNonce);
    // Повтор в следующем батче: nonce счёта уже сдвинут.
    let (_, after, _) = apply_batch(&batch(state.clone(), &[first.clone()])).unwrap();
    assert_eq!(apply_batch(&batch(after, &[first])).unwrap_err(), BatchError::BadNonce);
    // Транзакция с номером из будущего.
    assert_eq!(apply_batch(&batch(state, &[transfer(1, 1, 2, 10)])).unwrap_err(), BatchError::BadNonce);
}

#[test]
fn transaction_signed_for_another_rollup_is_rejected() {
    let state = accounts(&[(1, 1000, 0)]);
    let elsewhere = sign_transaction(&key(1), CHAIN + 1, 0, Transaction::Transfer { to: address(2), amount: 10 });
    assert!(matches!(
        apply_batch(&batch(state, &[elsewhere])).unwrap_err(),
        BatchError::UnknownSender | BatchError::BadSignature
    ));
}

#[test]
fn chain_id_is_part_of_the_proven_statement() {
    let state = accounts(&[(1, 1000, 0)]);
    let (here, _, _) = apply_batch(&batch(state.clone(), &[])).unwrap();
    let mut other = batch(state, &[]);
    other.chain_id = CHAIN + 1;
    let (there, _, _) = apply_batch(&other).unwrap();
    assert_ne!(here.digest(), there.digest());
}

#[test]
fn overdraft_is_rejected() {
    let state = accounts(&[(1, 10, 0)]);
    assert_eq!(apply_batch(&batch(state, &[transfer(1, 0, 2, 11)])).unwrap_err(), BatchError::InsufficientBalance);
}

#[test]
fn unsorted_accounts_are_rejected() {
    let mut state = accounts(&[(1, 1, 0), (2, 1, 0)]);
    state.reverse();
    assert_eq!(apply_batch(&batch(state, &[])).unwrap_err(), BatchError::AccountsNotSorted);
}

#[test]
fn empty_withdrawal_tree_root_is_zero() {
    assert_eq!(withdrawals_root(&[]), [0u8; 32]);
}
