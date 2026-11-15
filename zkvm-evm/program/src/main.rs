//! Гостевая программа SP1: доказывает, что блок EVM исполнен по правилам rollup-evm.
//! Публичные значения — 352 байта (одиннадцать слов протокола версии 2), их проверяет контракт на TON.
#![no_main]
sp1_zkvm::entrypoint!(main);

use rollup_evm::{apply_evm_batch, EvmBatchInput};

pub fn main() {
    // Вход — один элемент в кодировке bincode: формат входа блока RSP совместим только с ней.
    let bytes = sp1_zkvm::io::read_vec();
    let input: EvmBatchInput = bincode::deserialize(&bytes).expect("вход батча не разобран");
    // Любая ошибка — паника: пруфа для некорректного батча не существует.
    let public_values = apply_evm_batch(input).expect("некорректный батч");
    sp1_zkvm::io::commit_slice(&public_values.to_bytes());
}
