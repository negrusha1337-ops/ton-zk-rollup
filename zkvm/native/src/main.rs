//! Нативный запуск программы перехода состояния: без zkVM и без пруфа.
//! Пишет fixtures/zkvm_batches/batches.json — по нему тест сверяет публичные значения
//! программы с тем, что ожидает rollup-контракт.
//!
//!   cargo run -p rollup-native            (из каталога zkvm/)
use std::{fs, path::PathBuf};

use rollup_native::{Scenario, DEPOSIT_VALUE};
use rollup_stf::{apply_batch, data_chunk_hash, BatchInput, PublicValues};
use serde_json::{json, Value};

fn decimal(bytes: &[u8]) -> String {
    // Число из big-endian байтов в десятичной записи (для JSON без потери точности).
    let mut digits = vec![0u8];
    for &byte in bytes {
        let mut carry = byte as u32;
        for digit in digits.iter_mut() {
            let value = (*digit as u32) * 256 + carry;
            *digit = (value % 10) as u8;
            carry = value / 10;
        }
        while carry > 0 {
            digits.push((carry % 10) as u8);
            carry /= 10;
        }
    }
    digits.iter().rev().map(|d| char::from(b'0' + d)).collect()
}

fn describe(values: &PublicValues, input: &BatchInput) -> Value {
    json!({
        // Порции данных батча: их секвенсор публикует в TON сообщениями PublishData.
        "dataChunksHex": input.data_chunks.iter().map(hex::encode).collect::<Vec<_>>(),
        "publicValuesHex": hex::encode(values.to_bytes()),
        "publicInput": decimal(&values.digest()),
        "prevStateRoot": decimal(&values.prev_state_root),
        "roots": {
            "newStateRoot": decimal(&values.new_state_root),
            "batchHash": decimal(&values.batch_hash),
            "withdrawalsRoot": decimal(&values.withdrawals_root),
        },
        "prevDepositHash": decimal(&values.prev_deposit_hash),
        "newDepositHash": decimal(&values.new_deposit_hash),
    })
}

fn run(name: &str, input: &BatchInput) -> (PublicValues, Vec<rollup_stf::Account>, Vec<rollup_stf::WithdrawalLeaf>) {
    apply_batch(input).unwrap_or_else(|error| panic!("{name}: батч отклонён: {error:?}"))
}

/// Эталонные хеши порций разной длины: тест сверяет их с хешем ячеек, которые строит
/// TypeScript (`dataChunkCell`), то есть с тем, что увидит контракт.
fn chunk_hash_vectors() -> Vec<Value> {
    [0usize, 1, 126, 127, 128, 254, 635, 636, 2667, 2668, 60_000]
        .iter()
        .map(|&length| {
            let data: Vec<u8> = (0..length).map(|i| (i * 31 + length * 7 + (i >> 8)) as u8).collect();
            json!({ "length": length, "hash": hex::encode(data_chunk_hash(&data)) })
        })
        .collect()
}

fn main() {
    let scenario = Scenario::new();
    let input1 = scenario.batch1();
    let (values1, accounts1, withdrawals1) = run("батч 1", &input1);
    let input2 = scenario.batch2(accounts1, withdrawals1);
    let (values2, accounts2, _) = run("батч 2", &input2);

    let output = json!({
        "source": "Сгенерировано нативным запуском zkvm/native (cargo run -p rollup-native); не редактировать вручную",
        "note": "Публичные значения программы перехода состояния. Пруфа здесь нет: это сверка формата с контрактом",
        "genesisStateRoot": decimal(&values1.prev_state_root),
        "deposit": {
            "l2Recipient": decimal(&scenario.deposit.l2_recipient),
            "value": DEPOSIT_VALUE.to_string(),
            "amount": scenario.deposit.amount.to_string(),
        },
        "withdrawal": {
            "leafIndex": 0,
            "recipientHash": decimal(&scenario.l1_recipient_hash),
            "amount": scenario.withdrawal_amount.to_string(),
        },
        "finalBalances": accounts2.iter().map(|account| json!({
            "address": hex::encode(account.address),
            "balance": account.balance.to_string(),
        })).collect::<Vec<_>>(),
        "batches": [describe(&values1, &input1), describe(&values2, &input2)],
        "chunkHashVectors": {
            "note": "Байт i порции длины n равен (i·31 + n·7 + (i >> 8)) mod 256",
            "vectors": chunk_hash_vectors(),
        },
    });

    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/zkvm_batches");
    fs::create_dir_all(&dir).expect("не удалось создать каталог фикстур");
    let file = dir.join("batches.json");
    fs::write(&file, serde_json::to_string_pretty(&output).expect("JSON") + "\n").expect("не удалось записать фикстуру");
    println!("Записано: fixtures/zkvm_batches/batches.json");
    println!("Дайджест батча 1: {}", decimal(&values1.digest()));
    println!("Дайджест батча 2: {}", decimal(&values2.digest()));
}
