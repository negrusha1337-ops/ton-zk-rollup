//! Гостевая программа SP1: доказывает, что батч применён по правилам rollup-stf.
//! Публичные значения — ровно 224 байта в формате, который проверяет контракт на TON.
#![no_main]
sp1_zkvm::entrypoint!(main);

use rollup_stf::{apply_batch_with_data_hash, batch_data_hash, BatchInput};

pub fn main() {
    let input = sp1_zkvm::io::read::<BatchInput>();
    // Привязка к данным, опубликованным в TON: хеш порций в том виде, в каком его копит
    // контракт. Метки cycle-tracker позволяют хосту отдельно увидеть цену этой привязки.
    println!("cycle-tracker-report-start: data-hash");
    let batch_hash = batch_data_hash(&input.data_chunks).expect("некорректные данные батча");
    println!("cycle-tracker-report-end: data-hash");
    // Некорректный батч — паника: пруфа для него не существует. Здесь же проверяются
    // подписи: транзакция без подписи владельца счёта делает батч некорректным.
    println!("cycle-tracker-report-start: state-transition");
    let (public_values, _, _) = apply_batch_with_data_hash(&input, batch_hash).expect("некорректный батч");
    println!("cycle-tracker-report-end: state-transition");
    sp1_zkvm::io::commit_slice(&public_values.to_bytes());
}
