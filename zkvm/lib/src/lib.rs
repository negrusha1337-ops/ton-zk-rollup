//! Переход состояния игрушечного L2 — та самая функция, выполнение которой
//! доказывает zkVM. Это НЕ EVM: простой реестр балансов без подписей. Его задача —
//! выдавать публичные значения ровно в том формате, который проверяет rollup-контракт
//! на TON (contracts/rollup/logic.tolk):
//!
//!   prevStateRoot ‖ newStateRoot ‖ batchHash ‖ withdrawalsRoot ‖ prevDepositHash ‖ newDepositHash
//!
//! шесть слов по 32 байта. Контракт берёт от них SHA-256, обрезает до 253 бит и
//! подаёт верификатору первым публичным входом — так же считает дайджест SP1.
#![no_std]

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub type Hash = [u8; 32];
pub type L2Address = [u8; 20];

/// Глубина дерева выводов — как WITHDRAWAL_TREE_DEPTH в контракте.
pub const WITHDRAWAL_TREE_DEPTH: usize = 32;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Account {
    pub address: L2Address,
    pub balance: u128,
}

/// Депозит из очереди L1: то, что контракт положил в накопительный хеш.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Deposit {
    pub l2_recipient: L2Address,
    pub amount: u128,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Transaction {
    Transfer { from: L2Address, to: L2Address, amount: u128 },
    /// Вывод на L1: списывает баланс и добавляет лист в дерево выводов.
    Withdraw { from: L2Address, l1_recipient_hash: Hash, amount: u128 },
}

/// Уже существующий лист дерева выводов (дерево накопительное).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WithdrawalLeaf {
    pub recipient_hash: Hash,
    pub amount: u128,
}

/// Всё, что нужно для одного батча. Для zkVM это приватный вход.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchInput {
    /// Состояние до батча, отсортированное по адресу.
    pub accounts: Vec<Account>,
    /// Накопительный хеш очереди депозитов на момент предыдущего батча.
    pub prev_deposit_hash: Hash,
    /// Депозиты, которые батч обязан обработать, в порядке очереди.
    pub deposits: Vec<Deposit>,
    pub transactions: Vec<Transaction>,
    /// Все выводы предыдущих батчей, по порядку номеров листьев.
    pub prior_withdrawals: Vec<WithdrawalLeaf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicValues {
    pub prev_state_root: Hash,
    pub new_state_root: Hash,
    pub batch_hash: Hash,
    pub withdrawals_root: Hash,
    pub prev_deposit_hash: Hash,
    pub new_deposit_hash: Hash,
}

impl PublicValues {
    /// 192 байта в порядке, зафиксированном протоколом.
    pub fn to_bytes(&self) -> [u8; 192] {
        let mut out = [0u8; 192];
        let words = [
            &self.prev_state_root,
            &self.new_state_root,
            &self.batch_hash,
            &self.withdrawals_root,
            &self.prev_deposit_hash,
            &self.new_deposit_hash,
        ];
        for (i, word) in words.iter().enumerate() {
            out[i * 32..(i + 1) * 32].copy_from_slice(*word);
        }
        out
    }

    /// Первый публичный вход верификатора: SHA-256, обрезанный до 253 бит.
    pub fn digest(&self) -> Hash {
        let mut digest = sha256(&[&self.to_bytes()]);
        digest[0] &= 0x1f;
        digest
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum BatchError {
    AccountsNotSorted,
    InsufficientBalance,
    BalanceOverflow,
    UnknownSender,
}

pub fn sha256(parts: &[&[u8]]) -> Hash {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// Число как 32-байтовое слово (big-endian) — так его хеширует контракт.
fn word(value: u128) -> Hash {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&value.to_be_bytes());
    out
}

fn address_word(address: &L2Address) -> Hash {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(address);
    out
}

/// Корень состояния: хеш отсортированного списка (адрес, баланс). Для игрушечного
/// реестра этого достаточно; у настоящего L2 здесь будет дерево состояния EVM.
pub fn state_root(accounts: &BTreeMap<L2Address, u128>) -> Hash {
    let mut hasher = Sha256::new();
    hasher.update((accounts.len() as u64).to_be_bytes());
    for (address, balance) in accounts {
        hasher.update(address);
        hasher.update(balance.to_be_bytes());
    }
    hasher.finalize().into()
}

/// Шаг накопительного хеша очереди депозитов — как handleDeposit в контракте.
pub fn deposit_hash(previous: &Hash, deposit: &Deposit) -> Hash {
    sha256(&[previous, &address_word(&deposit.l2_recipient), &word(deposit.amount)])
}

pub fn withdrawal_leaf_hash(leaf_index: u32, leaf: &WithdrawalLeaf) -> Hash {
    sha256(&[&word(leaf_index as u128), &leaf.recipient_hash, &word(leaf.amount)])
}

/// Корень дерева выводов: листья стоят подряд с нуля, остальное — пустые поддеревья
/// (пустой лист — 32 нулевых байта, узел — sha256(левый ‖ правый)). Корень дерева
/// без листьев контракт хранит как ноль.
pub fn withdrawals_root(leaves: &[WithdrawalLeaf]) -> Hash {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    let mut level: Vec<Hash> = leaves
        .iter()
        .enumerate()
        .map(|(index, leaf)| withdrawal_leaf_hash(index as u32, leaf))
        .collect();
    let mut empty = [0u8; 32];
    for _ in 0..WITHDRAWAL_TREE_DEPTH {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            let right = if pair.len() == 2 { &pair[1] } else { &empty };
            next.push(sha256(&[&pair[0], right]));
        }
        empty = sha256(&[&empty, &empty]);
        level = next;
    }
    level[0]
}

/// Обязательство на данные батча: хеш депозитов и транзакций в каноническом виде.
pub fn batch_hash(deposits: &[Deposit], transactions: &[Transaction]) -> Hash {
    let mut hasher = Sha256::new();
    hasher.update((deposits.len() as u64).to_be_bytes());
    for deposit in deposits {
        hasher.update(deposit.l2_recipient);
        hasher.update(deposit.amount.to_be_bytes());
    }
    hasher.update((transactions.len() as u64).to_be_bytes());
    for transaction in transactions {
        match transaction {
            Transaction::Transfer { from, to, amount } => {
                hasher.update([0u8]);
                hasher.update(from);
                hasher.update(to);
                hasher.update(amount.to_be_bytes());
            }
            Transaction::Withdraw { from, l1_recipient_hash, amount } => {
                hasher.update([1u8]);
                hasher.update(from);
                hasher.update(l1_recipient_hash);
                hasher.update(amount.to_be_bytes());
            }
        }
    }
    hasher.finalize().into()
}

fn debit(accounts: &mut BTreeMap<L2Address, u128>, from: &L2Address, amount: u128) -> Result<(), BatchError> {
    let balance = accounts.get_mut(from).ok_or(BatchError::UnknownSender)?;
    *balance = balance.checked_sub(amount).ok_or(BatchError::InsufficientBalance)?;
    Ok(())
}

fn credit(accounts: &mut BTreeMap<L2Address, u128>, to: &L2Address, amount: u128) -> Result<(), BatchError> {
    let balance = accounts.entry(*to).or_insert(0);
    *balance = balance.checked_add(amount).ok_or(BatchError::BalanceOverflow)?;
    Ok(())
}

/// Применяет батч и возвращает публичные значения и новое состояние.
/// Любая ошибка означает, что батч некорректен и пруфа для него быть не должно.
pub fn apply_batch(input: &BatchInput) -> Result<(PublicValues, Vec<Account>, Vec<WithdrawalLeaf>), BatchError> {
    if input.accounts.windows(2).any(|pair| pair[0].address >= pair[1].address) {
        return Err(BatchError::AccountsNotSorted);
    }
    let mut accounts: BTreeMap<L2Address, u128> =
        input.accounts.iter().map(|account| (account.address, account.balance)).collect();
    let prev_state_root = state_root(&accounts);

    // Депозиты из очереди L1 — строго по порядку, с тем же накопительным хешем, что в контракте.
    let mut new_deposit_hash = input.prev_deposit_hash;
    for deposit in &input.deposits {
        new_deposit_hash = deposit_hash(&new_deposit_hash, deposit);
        credit(&mut accounts, &deposit.l2_recipient, deposit.amount)?;
    }

    let mut withdrawals = input.prior_withdrawals.clone();
    for transaction in &input.transactions {
        match transaction {
            Transaction::Transfer { from, to, amount } => {
                debit(&mut accounts, from, *amount)?;
                credit(&mut accounts, to, *amount)?;
            }
            Transaction::Withdraw { from, l1_recipient_hash, amount } => {
                debit(&mut accounts, from, *amount)?;
                withdrawals.push(WithdrawalLeaf { recipient_hash: *l1_recipient_hash, amount: *amount });
            }
        }
    }

    let public_values = PublicValues {
        prev_state_root,
        new_state_root: state_root(&accounts),
        batch_hash: batch_hash(&input.deposits, &input.transactions),
        withdrawals_root: withdrawals_root(&withdrawals),
        prev_deposit_hash: input.prev_deposit_hash,
        new_deposit_hash,
    };
    let new_accounts = accounts.into_iter().map(|(address, balance)| Account { address, balance }).collect();
    Ok((public_values, new_accounts, withdrawals))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(byte: u8) -> L2Address {
        [byte; 20]
    }

    #[test]
    fn deposit_then_transfer_and_withdraw() {
        let input = BatchInput {
            accounts: Vec::new(),
            prev_deposit_hash: [0u8; 32],
            deposits: alloc::vec![Deposit { l2_recipient: address(1), amount: 1000 }],
            transactions: alloc::vec![
                Transaction::Transfer { from: address(1), to: address(2), amount: 300 },
                Transaction::Withdraw { from: address(2), l1_recipient_hash: [7u8; 32], amount: 100 },
            ],
            prior_withdrawals: Vec::new(),
        };
        let (values, accounts, withdrawals) = apply_batch(&input).unwrap();
        assert_eq!(accounts, alloc::vec![
            Account { address: address(1), balance: 700 },
            Account { address: address(2), balance: 200 },
        ]);
        assert_eq!(withdrawals.len(), 1);
        assert_eq!(values.prev_state_root, state_root(&BTreeMap::new()));
        assert_ne!(values.new_state_root, values.prev_state_root);
        assert_ne!(values.new_deposit_hash, [0u8; 32]);
        assert_eq!(values.to_bytes().len(), 192);
        assert_eq!(values.digest()[0] & 0xe0, 0);
    }

    #[test]
    fn overdraft_is_rejected() {
        let input = BatchInput {
            accounts: alloc::vec![Account { address: address(1), balance: 10 }],
            prev_deposit_hash: [0u8; 32],
            deposits: Vec::new(),
            transactions: alloc::vec![Transaction::Transfer { from: address(1), to: address(2), amount: 11 }],
            prior_withdrawals: Vec::new(),
        };
        assert_eq!(apply_batch(&input).unwrap_err(), BatchError::InsufficientBalance);
    }

    #[test]
    fn unsorted_accounts_are_rejected() {
        let input = BatchInput {
            accounts: alloc::vec![
                Account { address: address(2), balance: 1 },
                Account { address: address(1), balance: 1 },
            ],
            prev_deposit_hash: [0u8; 32],
            deposits: Vec::new(),
            transactions: Vec::new(),
            prior_withdrawals: Vec::new(),
        };
        assert_eq!(apply_batch(&input).unwrap_err(), BatchError::AccountsNotSorted);
    }

    #[test]
    fn empty_withdrawal_tree_root_is_zero() {
        assert_eq!(withdrawals_root(&[]), [0u8; 32]);
    }
}
