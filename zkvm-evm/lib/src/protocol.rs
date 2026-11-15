//! Типы и хеш-функции протокола rollup'а (версия 2, `PROTOCOL-V2.md`): то, что обязано совпадать
//! с контрактом на TON (`contracts/rollup/logic.tolk`) и с `wrappers/rollupMath.ts`.
//!
//! Перенесено из `zkvm/lib` (игрушечный реестр, заморожен): хеш очереди депозитов, хеш порции
//! данных, шаг накопительного хеша данных, хеш листа дерева выводов, порядок вариантов
//! `QueueItem`. Своё здесь: одиннадцать слов публичных значений и хеш элемента очереди для
//! принудительной транзакции (keccak-256 байтов вместо хеша ячейки). Совпадение перенесённого
//! с `zkvm/lib` и значения для сверки с TypeScript закрепляет `tests.rs` (тесты-сторожа).
use alloy_primitives::keccak256;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub type Hash = [u8; 32];
pub type L2Address = [u8; 20];

/// Число слов публичных значений и их размер в байтах.
pub const PUBLIC_VALUE_WORDS: usize = 11;
pub const PUBLIC_VALUES_BYTES: usize = PUBLIC_VALUE_WORDS * 32;

/// Раскладка порции данных в ячейки TON — как `dataChunkCell` в wrappers/rollupMath.ts.
pub const DATA_CELL_BYTES: usize = 127;
pub const DATA_CELL_REFS: usize = 4;
pub const MAX_DATA_CHUNK_BYTES: usize = 60_000;

/// Депозит из очереди L1: то, что контракт положил в накопительный хеш.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Deposit {
    pub l2_recipient: L2Address,
    /// Сумма в нанотонах. Контракт принимает только суммы меньше 2^64.
    pub amount: u128,
}

/// Элемент очереди L1→L2. Порядок вариантов — как в `zkvm/lib` (часть формата входа).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum QueueItem {
    Deposit(Deposit),
    /// Байты, которые пользователь поставил в очередь на L1 сам, в обход секвенсора. Контракт
    /// их не разбирает: здесь может быть что угодно. По замыслу — подписанная транзакция EVM в
    /// кодировке EIP-2718; всё прочее программа пропускает (`forced.rs`).
    ForcedTransaction(Vec<u8>),
}

/// Метка принудительной транзакции в накопительном хеше очереди: стоит на месте получателя
/// депозита, а получатель депозита — 160 бит, так что спутать их нельзя. То же значение —
/// FORCED_TRANSACTION_MARKER в contracts/rollup/logic.tolk и wrappers/rollupMath.ts.
pub const FORCED_TRANSACTION_MARKER: Hash = {
    let mut marker = [0u8; 32];
    marker[0] = 0x80;
    marker
};

/// Лист дерева выводов: кому в TON и сколько нанотонов.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WithdrawalLeaf {
    pub recipient_hash: Hash,
    pub amount: u128,
}

/// Публичные значения батча: одиннадцать 32-байтовых слов в порядке, закреплённом протоколом.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicValues {
    pub chain_id: u64,
    /// Хеш заголовка родителя.
    pub prev_state_root: Hash,
    /// Хеш заголовка блока.
    pub new_state_root: Hash,
    pub batch_hash: Hash,
    /// Корень дерева выводов до батча: контракт подставляет свой, поэтому фронтир прежнего
    /// дерева (приватный вход программы) обязан быть от дерева, уже принятого на L1.
    pub prev_withdrawals_root: Hash,
    pub withdrawals_root: Hash,
    pub prev_deposit_hash: Hash,
    pub new_deposit_hash: Hash,
    /// Число листьев дерева выводов до батча. Корень счётчик не связывает (`withdrawals.rs`),
    /// поэтому он — отдельное слово, и контракт подставляет свой.
    pub prev_withdrawals_count: u64,
    pub withdrawals_count: u64,
    /// Время блока L2, секунды: контракт сверяет его со временем L1.
    pub block_timestamp: u64,
}

impl PublicValues {
    /// 352 байта в порядке, закреплённом протоколом.
    pub fn to_bytes(&self) -> [u8; PUBLIC_VALUES_BYTES] {
        let words = [
            word(self.chain_id as u128),
            self.prev_state_root,
            self.new_state_root,
            self.batch_hash,
            self.prev_withdrawals_root,
            self.withdrawals_root,
            self.prev_deposit_hash,
            self.new_deposit_hash,
            word(self.prev_withdrawals_count as u128),
            word(self.withdrawals_count as u128),
            word(self.block_timestamp as u128),
        ];
        let mut out = [0u8; PUBLIC_VALUES_BYTES];
        for (index, value) in words.iter().enumerate() {
            out[index * 32..(index + 1) * 32].copy_from_slice(value);
        }
        out
    }

    /// Первый публичный вход верификатора: SHA-256, обрезанный до 253 бит (`batchDigest`).
    pub fn digest(&self) -> Hash {
        let mut digest = sha256(&[&self.to_bytes()]);
        digest[0] &= 0x1f;
        digest
    }
}

pub fn sha256(parts: &[&[u8]]) -> Hash {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// Число как 32-байтовое слово (big-endian) — так его хеширует контракт.
pub fn word(value: u128) -> Hash {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&value.to_be_bytes());
    out
}

fn address_word(address: &L2Address) -> Hash {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(address);
    out
}

/// Шаг накопительного хеша очереди для депозита — как pushQueueItem в контракте.
pub fn deposit_hash(previous: &Hash, deposit: &Deposit) -> Hash {
    sha256(&[previous, &address_word(&deposit.l2_recipient), &word(deposit.amount)])
}

/// Шаг накопительного хеша очереди для принудительной транзакции — как handleForceTransaction
/// в контракте: вместо получателя — метка, вместо суммы — keccak-256 байтов из очереди (для
/// транзакции EVM это её хеш). Контракт считает keccak из прочитанных битов «змейки» ячеек,
/// поэтому нарезка на ячейки на хеш не влияет.
pub fn forced_transaction_hash(previous: &Hash, transaction_bytes: &[u8]) -> Hash {
    sha256(&[previous, &FORCED_TRANSACTION_MARKER, &keccak256(transaction_bytes).0])
}

/// Шаг накопительного хеша очереди для любого элемента.
pub fn queue_item_hash(previous: &Hash, item: &QueueItem) -> Hash {
    match item {
        QueueItem::Deposit(deposit) => deposit_hash(previous, deposit),
        QueueItem::ForcedTransaction(bytes) => forced_transaction_hash(previous, bytes),
    }
}

/// Хеш листа дерева выводов: номер листа, получатель, сумма — по слову.
pub fn withdrawal_leaf_hash(leaf_index: u32, leaf: &WithdrawalLeaf) -> Hash {
    sha256(&[&word(leaf_index as u128), &leaf.recipient_hash, &word(leaf.amount)])
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
    let mut hashes: Vec<Hash> = vec![[0u8; 32]; cell_count];
    let mut depths: Vec<u16> = vec![0u16; cell_count];
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

/// Порция данных длиннее MAX_DATA_CHUNK_BYTES.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DataChunkTooLarge;

/// Обязательство на данные батча: накопительный хеш порций в порядке публикации.
/// Ноль, если данных нет, — так же считает контракт.
pub fn batch_data_hash(chunks: &[Vec<u8>]) -> Result<Hash, DataChunkTooLarge> {
    let mut hash = [0u8; 32];
    for chunk in chunks {
        if chunk.len() > MAX_DATA_CHUNK_BYTES {
            return Err(DataChunkTooLarge);
        }
        hash = data_hash_step(&hash, &data_chunk_hash(chunk));
    }
    Ok(hash)
}
