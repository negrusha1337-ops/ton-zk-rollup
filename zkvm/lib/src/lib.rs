//! Переход состояния игрушечного L2 — та самая функция, выполнение которой
//! доказывает zkVM. Это НЕ EVM: простой реестр балансов без подписей. Его задача —
//! выдавать публичные значения ровно в том формате, который проверяет rollup-контракт
//! на TON (contracts/rollup/logic.tolk):
//!
//!   prevStateRoot ‖ newStateRoot ‖ batchHash ‖ withdrawalsRoot ‖ prevDepositHash ‖ newDepositHash
//!
//! шесть слов по 32 байта. Контракт берёт от них SHA-256, обрезает до 253 бит и
//! подаёт верификатору первым публичным входом — так же считает дайджест SP1.
//!
//! Транзакции батча программа берёт не из произвольного входа, а из данных,
//! опубликованных в TON (data availability, DA.md): секвенсор шлёт их порциями в
//! rollup-контракт, контракт копит хеш порций, а программа считает тот же хеш и кладёт
//! его в batchHash. Пруф для данных, которых в TON не было, не сойдётся с контрактом.
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

/// Раскладка порции данных в ячейки TON — как `dataChunkCell` в wrappers/rollupMath.ts.
pub const DATA_CELL_BYTES: usize = 127;
pub const DATA_CELL_REFS: usize = 4;
pub const MAX_DATA_CHUNK_BYTES: usize = 60_000;

/// Размеры транзакций в данных батча: тег, отправитель, получатель, сумма (u128, big-endian).
const TRANSFER_BYTES: usize = 1 + 20 + 20 + 16;
const WITHDRAW_BYTES: usize = 1 + 20 + 32 + 16;
const TAG_TRANSFER: u8 = 0;
const TAG_WITHDRAW: u8 = 1;

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
    /// Порции данных батча в том виде и порядке, в каком они опубликованы в TON.
    /// Транзакции — это их склейка в кодировке `encode_transactions`.
    pub data_chunks: Vec<Vec<u8>>,
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

/// Хеш порции данных — хеш представления корневой ячейки TON для раскладки «куча»:
/// данные режутся на куски по DATA_CELL_BYTES байт, кусок i лежит в ячейке i, её ссылки —
/// ячейки 4i+1 … 4i+4. Это тот самый хеш, который контракт получает от сети готовым
/// (`msg.data.hash()`), поэтому считать его здесь нужно бит в бит по правилам TON:
///
///   sha256(d1 ‖ d2 ‖ данные ‖ глубины ссылок по 2 байта ‖ хеши ссылок),
///
/// где d1 — число ссылок (ячейки обычные, уровня 0), d2 — удвоенное число байт данных
/// (данные всегда выровнены по байту), глубина ячейки — 1 + наибольшая глубина ссылок.
pub fn data_chunk_hash(data: &[u8]) -> Hash {
    let cell_count = core::cmp::max(1, data.len().div_ceil(DATA_CELL_BYTES));
    let mut hashes: Vec<Hash> = alloc::vec![[0u8; 32]; cell_count];
    let mut depths: Vec<u16> = alloc::vec![0u16; cell_count];
    for index in (0..cell_count).rev() {
        let start = index * DATA_CELL_BYTES;
        let piece = &data[core::cmp::min(start, data.len())..core::cmp::min(start + DATA_CELL_BYTES, data.len())];
        let first_child = DATA_CELL_REFS * index + 1;
        let last_child = core::cmp::min(first_child + DATA_CELL_REFS, cell_count);
        let children = if first_child < cell_count { first_child..last_child } else { 0..0 };

        let mut hasher = Sha256::new();
        hasher.update([children.len() as u8, (piece.len() * 2) as u8]);
        hasher.update(piece);
        let mut depth = 0u16;
        for child in children.clone() {
            hasher.update(depths[child].to_be_bytes());
            depth = core::cmp::max(depth, depths[child] + 1);
        }
        for child in children {
            hasher.update(hashes[child]);
        }
        hashes[index] = hasher.finalize().into();
        depths[index] = depth;
    }
    hashes[0]
}

/// Шаг накопительного хеша данных батча — как dataHashStep в контракте.
pub fn data_hash_step(previous: &Hash, chunk_hash: &Hash) -> Hash {
    sha256(&[previous, chunk_hash])
}

/// Обязательство на данные батча: накопительный хеш порций в порядке публикации.
/// Ноль, если данных нет, — так же считает контракт.
pub fn batch_data_hash(chunks: &[Vec<u8>]) -> Result<Hash, BatchError> {
    let mut hash = [0u8; 32];
    for chunk in chunks {
        if chunk.len() > MAX_DATA_CHUNK_BYTES {
            return Err(BatchError::DataChunkTooLarge);
        }
        hash = data_hash_step(&hash, &data_chunk_hash(chunk));
    }
    Ok(hash)
}

/// Кодировка транзакций в данных батча. Ей пользуется секвенсор; программа делает обратное.
pub fn encode_transactions(transactions: &[Transaction]) -> Vec<u8> {
    let mut out = Vec::new();
    for transaction in transactions {
        match transaction {
            Transaction::Transfer { from, to, amount } => {
                out.push(TAG_TRANSFER);
                out.extend_from_slice(from);
                out.extend_from_slice(to);
                out.extend_from_slice(&amount.to_be_bytes());
            }
            Transaction::Withdraw { from, l1_recipient_hash, amount } => {
                out.push(TAG_WITHDRAW);
                out.extend_from_slice(from);
                out.extend_from_slice(l1_recipient_hash);
                out.extend_from_slice(&amount.to_be_bytes());
            }
        }
    }
    out
}

fn amount_from(bytes: &[u8]) -> u128 {
    let mut raw = [0u8; 16];
    raw.copy_from_slice(bytes);
    u128::from_be_bytes(raw)
}

/// Разбор данных батча: порции склеиваются, транзакция может пересекать границу порций.
/// Любой хвост, который не разбирается целиком, — ошибка: пруфа для таких данных нет.
pub fn decode_transactions(chunks: &[Vec<u8>]) -> Result<Vec<Transaction>, BatchError> {
    let data: Vec<u8> = chunks.iter().flat_map(|chunk| chunk.iter().copied()).collect();
    let mut transactions = Vec::new();
    let mut rest = data.as_slice();
    while let Some(&tag) = rest.first() {
        let size = match tag {
            TAG_TRANSFER => TRANSFER_BYTES,
            TAG_WITHDRAW => WITHDRAW_BYTES,
            _ => return Err(BatchError::MalformedData),
        };
        if rest.len() < size {
            return Err(BatchError::MalformedData);
        }
        let (body, tail) = rest.split_at(size);
        let mut from = [0u8; 20];
        from.copy_from_slice(&body[1..21]);
        let amount = amount_from(&body[size - 16..]);
        transactions.push(if tag == TAG_TRANSFER {
            let mut to = [0u8; 20];
            to.copy_from_slice(&body[21..41]);
            Transaction::Transfer { from, to, amount }
        } else {
            let mut l1_recipient_hash = [0u8; 32];
            l1_recipient_hash.copy_from_slice(&body[21..53]);
            Transaction::Withdraw { from, l1_recipient_hash, amount }
        });
        rest = tail;
    }
    Ok(transactions)
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
    for transaction in &decode_transactions(&input.data_chunks)? {
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
        batch_hash,
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
            data_chunks: alloc::vec![encode_transactions(&[
                Transaction::Transfer { from: address(1), to: address(2), amount: 300 },
                Transaction::Withdraw { from: address(2), l1_recipient_hash: [7u8; 32], amount: 100 },
            ])],
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
            data_chunks: alloc::vec![encode_transactions(&[Transaction::Transfer {
                from: address(1),
                to: address(2),
                amount: 11,
            }])],
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
            data_chunks: Vec::new(),
            prior_withdrawals: Vec::new(),
        };
        assert_eq!(apply_batch(&input).unwrap_err(), BatchError::AccountsNotSorted);
    }

    #[test]
    fn transactions_survive_encoding_and_chunk_boundaries() {
        let transactions = alloc::vec![
            Transaction::Transfer { from: address(1), to: address(2), amount: u128::MAX },
            Transaction::Withdraw { from: address(2), l1_recipient_hash: [9u8; 32], amount: 1 },
            Transaction::Transfer { from: address(3), to: address(4), amount: 0 },
        ];
        let data = encode_transactions(&transactions);
        // Граница порций посреди транзакции: разбор идёт по склейке.
        let (head, tail) = data.split_at(70);
        let decoded = decode_transactions(&[head.to_vec(), tail.to_vec()]).unwrap();
        assert_eq!(encode_transactions(&decoded), data);
        assert_eq!(decoded.len(), 3);
    }

    #[test]
    fn malformed_data_is_rejected() {
        assert_eq!(decode_transactions(&[alloc::vec![7u8]]).unwrap_err(), BatchError::MalformedData);
        let mut truncated = encode_transactions(&[Transaction::Transfer { from: address(1), to: address(2), amount: 5 }]);
        truncated.pop();
        assert_eq!(decode_transactions(&[truncated]).unwrap_err(), BatchError::MalformedData);
    }

    #[test]
    fn data_hash_is_zero_without_data_and_depends_on_order() {
        assert_eq!(batch_data_hash(&[]).unwrap(), [0u8; 32]);
        let a = alloc::vec![1u8; 10];
        let b = alloc::vec![2u8; 300];
        assert_ne!(batch_data_hash(&[a.clone(), b.clone()]).unwrap(), batch_data_hash(&[b, a]).unwrap());
        let oversized = alloc::vec![0u8; MAX_DATA_CHUNK_BYTES + 1];
        assert_eq!(batch_data_hash(&[oversized]).unwrap_err(), BatchError::DataChunkTooLarge);
    }

    #[test]
    fn empty_chunk_hash_matches_ton_empty_cell() {
        // Хеш пустой ячейки TON — известная константа: sha256 от двух нулевых байт описателей.
        let expected = [
            0x96, 0xa2, 0x96, 0xd2, 0x24, 0xf2, 0x85, 0xc6, 0x7b, 0xee, 0x93, 0xc3, 0x0f, 0x8a, 0x30, 0x91, 0x57, 0xf0,
            0xda, 0xa3, 0x5d, 0xc5, 0xb8, 0x7e, 0x41, 0x0b, 0x78, 0x63, 0x0a, 0x09, 0xcf, 0xc7,
        ];
        assert_eq!(data_chunk_hash(&[]), expected);
    }

    #[test]
    fn empty_withdrawal_tree_root_is_zero() {
        assert_eq!(withdrawals_root(&[]), [0u8; 32]);
    }
}
