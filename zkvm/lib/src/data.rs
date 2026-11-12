//! Данные батча, опубликованные в TON (data availability, DA.md): хеш порции в том
//! виде, в каком его видит контракт, и накопительный хеш порций.
use alloc::vec::Vec;
use sha2::{Digest, Sha256};

use crate::{sha256, BatchError, Hash};

/// Раскладка порции данных в ячейки TON — как `dataChunkCell` в wrappers/rollupMath.ts.
pub const DATA_CELL_BYTES: usize = 127;
pub const DATA_CELL_REFS: usize = 4;
pub const MAX_DATA_CHUNK_BYTES: usize = 60_000;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
