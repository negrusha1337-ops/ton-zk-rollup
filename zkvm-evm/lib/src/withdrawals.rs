//! Дерево выводов с дозаписью: фронтир и счётчик (`PROTOCOL-V2.md`, раздел 4 и правка 0.4).
//!
//! Дерево — разреженное двоичное дерево Меркла глубины 32; листья стоят подряд с нуля, пустой
//! лист — 32 нулевых байта, узел — sha256(левый ‖ правый). Программа не пересчитывает его
//! целиком: во входе — «фронтир» (по одному хешу на уровень) и число листьев. `frontier[h]` —
//! корень полного левого поддерева высоты h, если бит h счётчика единичный; на нулевых битах
//! элемент обязан быть нулевым (канонический вид входа — гигиена, а не защита).
//!
//! Что связывает вход с деревом, принятым на L1. Корень из фронтира и счётчика программа
//! коммитит как `prevWithdrawalsRoot`, счётчик — как `prevWithdrawalsCount`; контракт подставляет
//! в дайджест оба значения из своего хранилища. Одного корня мало: он связывает только элементы
//! фронтира на единичных битах счётчика. При настоящем счётчике 2 вход «счётчик 2^i, на месте i
//! — корень левого поддерева» дал бы тот же корень; так секвенсор прыжками довёл бы счётчик до
//! предела и навсегда закрыл выводы. Поэтому счётчик — отдельное слово публичных значений.
use crate::protocol::{sha256, withdrawal_leaf_hash, Hash, WithdrawalLeaf};

/// Глубина дерева выводов — как WITHDRAWAL_TREE_DEPTH в контракте.
pub const WITHDRAWAL_TREE_DEPTH: usize = 32;
/// Наибольшее число листьев: номер листа в контракте — uint32, а переход счётчика к 2^32
/// запрещён (корень полного дерева считался бы как у пустого).
pub const MAX_WITHDRAWALS: u64 = (1 << WITHDRAWAL_TREE_DEPTH) - 1;

pub type Frontier = [Hash; WITHDRAWAL_TREE_DEPTH];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontierError {
    /// Счётчик больше MAX_WITHDRAWALS.
    CountOutOfRange,
    /// Ненулевой элемент фронтира на нулевом бите счётчика.
    NonCanonical(usize),
    /// Дерево заполнено: листу нет места.
    TreeFull,
}

/// Дерево выводов в виде, достаточном для дозаписи.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WithdrawalTree {
    frontier: Frontier,
    count: u64,
}

impl WithdrawalTree {
    /// Пустое дерево.
    pub fn empty() -> Self {
        Self { frontier: [[0u8; 32]; WITHDRAWAL_TREE_DEPTH], count: 0 }
    }

    /// Дерево из входа: счётчик в пределах, фронтир в каноническом виде.
    pub fn from_input(frontier: Frontier, count: u64) -> Result<Self, FrontierError> {
        if count > MAX_WITHDRAWALS {
            return Err(FrontierError::CountOutOfRange);
        }
        for (height, node) in frontier.iter().enumerate() {
            if (count >> height) & 1 == 0 && *node != [0u8; 32] {
                return Err(FrontierError::NonCanonical(height));
            }
        }
        Ok(Self { frontier, count })
    }

    pub fn count(&self) -> u64 {
        self.count
    }

    pub fn frontier(&self) -> &Frontier {
        &self.frontier
    }

    /// Корень дерева. Без листьев — ноль, а не хеш пустого дерева: так его хранит контракт.
    pub fn root(&self) -> Hash {
        if self.count == 0 {
            return [0u8; 32];
        }
        let mut node = [0u8; 32];
        let mut empty = [0u8; 32];
        for height in 0..WITHDRAWAL_TREE_DEPTH {
            node = if (self.count >> height) & 1 == 1 {
                sha256(&[&self.frontier[height], &node])
            } else {
                sha256(&[&node, &empty])
            };
            empty = sha256(&[&empty, &empty]);
        }
        node
    }

    /// Дозапись листа: его номер — прежний счётчик. Правило (правка 0.4): `node = лист`; по h —
    /// бит счётчика нулевой → `frontier[h] = node`, стоп; иначе `node = H(frontier[h], node)`,
    /// `frontier[h] = 0`.
    pub fn append(&mut self, leaf: &WithdrawalLeaf) -> Result<(), FrontierError> {
        if self.count >= MAX_WITHDRAWALS {
            return Err(FrontierError::TreeFull);
        }
        let mut node = withdrawal_leaf_hash(self.count as u32, leaf);
        for height in 0..WITHDRAWAL_TREE_DEPTH {
            if (self.count >> height) & 1 == 0 {
                self.frontier[height] = node;
                break;
            }
            node = sha256(&[&self.frontier[height], &node]);
            self.frontier[height] = [0u8; 32];
        }
        self.count += 1;
        Ok(())
    }
}
