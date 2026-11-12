//! Переход состояния игрушечного L2 — та самая функция, выполнение которой
//! доказывает zkVM. Это НЕ EVM: простой реестр балансов. Его задача — выдавать публичные
//! значения ровно в том формате, который проверяет rollup-контракт на TON
//! (contracts/rollup/logic.tolk):
//!
//!   chainId ‖ prevStateRoot ‖ newStateRoot ‖ batchHash ‖ withdrawalsRoot ‖ prevDepositHash ‖ newDepositHash
//!
//! семь слов по 32 байта. Контракт берёт от них SHA-256, обрезает до 253 бит и
//! подаёт верификатору первым публичным входом — так же считает дайджест SP1.
//!
//! Что именно доказывает пруф:
//!   - идентификатор rollup'а (chainId) — тот, под который подписаны транзакции; контракт
//!     подставляет свой, поэтому пруф одного rollup'а не подойдёт другому;
//!   - транзакции взяты из данных, опубликованных в TON (модуль `data`, DA.md);
//!   - каждая транзакция подписана владельцем счёта и идёт по порядку его nonce (модуль `tx`);
//!   - депозиты обработаны строго по очереди L1, выводы добавлены в дерево выводов.
#![no_std]

extern crate alloc;

pub mod data;
pub mod tx;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use data::{batch_data_hash, data_chunk_hash, data_hash_step, MAX_DATA_CHUNK_BYTES};
pub use tx::{
    address_of, decode_transactions, encode_transactions, recover_sender, sign_transaction, signing_hash,
    SignedTransaction, Transaction,
};

pub type Hash = [u8; 32];
pub type L2Address = [u8; 20];

/// Глубина дерева выводов — как WITHDRAWAL_TREE_DEPTH в контракте.
pub const WITHDRAWAL_TREE_DEPTH: usize = 32;
/// Число слов публичных значений и их размер в байтах.
pub const PUBLIC_VALUE_WORDS: usize = 7;
pub const PUBLIC_VALUES_BYTES: usize = PUBLIC_VALUE_WORDS * 32;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Account {
    pub address: L2Address,
    pub balance: u128,
    /// Сколько транзакций счёт уже отправил; следующая обязана нести этот номер.
    pub nonce: u64,
}

/// Депозит из очереди L1: то, что контракт положил в накопительный хеш.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Deposit {
    pub l2_recipient: L2Address,
    pub amount: u128,
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
    /// Идентификатор rollup'а: попадает в публичные значения и в подпись каждой транзакции.
    pub chain_id: u64,
    /// Состояние до батча, отсортированное по адресу.
    pub accounts: Vec<Account>,
    /// Накопительный хеш очереди депозитов на момент предыдущего батча.
    pub prev_deposit_hash: Hash,
    /// Депозиты, которые батч обязан обработать, в порядке очереди.
    pub deposits: Vec<Deposit>,
    /// Порции данных батча в том виде и порядке, в каком они опубликованы в TON.
    /// Транзакции — это их склейка в кодировке `encode_transactions`.
    pub data_chunks: Vec<Vec<u8>>,
    /// Все выводы предыдущих батчей, по порядку номеров листьев.
    pub prior_withdrawals: Vec<WithdrawalLeaf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicValues {
    pub chain_id: u64,
    pub prev_state_root: Hash,
    pub new_state_root: Hash,
    pub batch_hash: Hash,
    pub withdrawals_root: Hash,
    pub prev_deposit_hash: Hash,
    pub new_deposit_hash: Hash,
}

impl PublicValues {
    /// 224 байта в порядке, зафиксированном протоколом.
    pub fn to_bytes(&self) -> [u8; PUBLIC_VALUES_BYTES] {
        let mut out = [0u8; PUBLIC_VALUES_BYTES];
        let chain_word = word(self.chain_id as u128);
        let words = [
            &chain_word,
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
    /// У адреса, восстановленного из подписи, нет счёта.
    UnknownSender,
    /// Подпись не разбирается или из неё не восстанавливается ключ.
    BadSignature,
    /// Номер транзакции не совпал с nonce счёта: повтор или пропуск.
    BadNonce,
    /// Данные батча не разбираются как список транзакций.
    MalformedData,
    /// Порция длиннее, чем помещается в одно сообщение TON.
    DataChunkTooLarge,
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

/// Состояние счёта внутри батча.
#[derive(Clone, Copy, Default)]
struct AccountState {
    balance: u128,
    nonce: u64,
}

type Ledger = BTreeMap<L2Address, AccountState>;

/// Корень состояния: хеш отсортированного списка (адрес, баланс, nonce). Для игрушечного
/// реестра этого достаточно; у настоящего L2 здесь будет дерево состояния EVM.
fn ledger_root(ledger: &Ledger) -> Hash {
    let mut hasher = Sha256::new();
    hasher.update((ledger.len() as u64).to_be_bytes());
    for (address, account) in ledger {
        hasher.update(address);
        hasher.update(account.balance.to_be_bytes());
        hasher.update(account.nonce.to_be_bytes());
    }
    hasher.finalize().into()
}

/// Корень состояния для списка счетов, отсортированного по адресу.
pub fn state_root(accounts: &[Account]) -> Hash {
    ledger_root(&accounts.iter().map(|a| (a.address, AccountState { balance: a.balance, nonce: a.nonce })).collect())
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

fn credit(ledger: &mut Ledger, to: &L2Address, amount: u128) -> Result<(), BatchError> {
    let account = ledger.entry(*to).or_default();
    account.balance = account.balance.checked_add(amount).ok_or(BatchError::BalanceOverflow)?;
    Ok(())
}

/// Проверяет подпись и nonce, списывает сумму со счёта отправителя и сдвигает его nonce.
/// Возвращает ничего: всё, что нужно дальше, — в самой транзакции.
fn authorize_and_debit(ledger: &mut Ledger, chain_id: u64, signed: &SignedTransaction) -> Result<(), BatchError> {
    let sender = recover_sender(chain_id, signed)?;
    let account = ledger.get_mut(&sender).ok_or(BatchError::UnknownSender)?;
    if account.nonce != signed.nonce {
        return Err(BatchError::BadNonce);
    }
    let amount = match signed.transaction {
        Transaction::Transfer { amount, .. } | Transaction::Withdraw { amount, .. } => amount,
    };
    account.balance = account.balance.checked_sub(amount).ok_or(BatchError::InsufficientBalance)?;
    account.nonce += 1;
    Ok(())
}

/// Применяет батч и возвращает публичные значения и новое состояние.
/// Любая ошибка означает, что батч некорректен и пруфа для него быть не должно.
pub fn apply_batch(input: &BatchInput) -> Result<(PublicValues, Vec<Account>, Vec<WithdrawalLeaf>), BatchError> {
    let batch_hash = batch_data_hash(&input.data_chunks)?;
    apply_batch_with_data_hash(input, batch_hash)
}

/// То же, но хеш данных уже посчитан вызывающим (`batch_data_hash`). Разделено, чтобы
/// гостевая программа могла отдельно замерить цену привязки к данным.
pub fn apply_batch_with_data_hash(
    input: &BatchInput,
    batch_hash: Hash,
) -> Result<(PublicValues, Vec<Account>, Vec<WithdrawalLeaf>), BatchError> {
    if input.accounts.windows(2).any(|pair| pair[0].address >= pair[1].address) {
        return Err(BatchError::AccountsNotSorted);
    }
    let mut ledger: Ledger = input
        .accounts
        .iter()
        .map(|account| (account.address, AccountState { balance: account.balance, nonce: account.nonce }))
        .collect();
    let prev_state_root = ledger_root(&ledger);

    // Депозиты из очереди L1 — строго по порядку, с тем же накопительным хешем, что в контракте.
    let mut new_deposit_hash = input.prev_deposit_hash;
    for deposit in &input.deposits {
        new_deposit_hash = deposit_hash(&new_deposit_hash, deposit);
        credit(&mut ledger, &deposit.l2_recipient, deposit.amount)?;
    }

    let mut withdrawals = input.prior_withdrawals.clone();
    for signed in &decode_transactions(&input.data_chunks)? {
        authorize_and_debit(&mut ledger, input.chain_id, signed)?;
        match &signed.transaction {
            Transaction::Transfer { to, amount } => credit(&mut ledger, to, *amount)?,
            Transaction::Withdraw { l1_recipient_hash, amount } => {
                withdrawals.push(WithdrawalLeaf { recipient_hash: *l1_recipient_hash, amount: *amount });
            }
        }
    }

    let public_values = PublicValues {
        chain_id: input.chain_id,
        prev_state_root,
        new_state_root: ledger_root(&ledger),
        batch_hash,
        withdrawals_root: withdrawals_root(&withdrawals),
        prev_deposit_hash: input.prev_deposit_hash,
        new_deposit_hash,
    };
    let new_accounts = ledger
        .into_iter()
        .map(|(address, account)| Account { address, balance: account.balance, nonce: account.nonce })
        .collect();
    Ok((public_values, new_accounts, withdrawals))
}

#[cfg(test)]
mod tests;
