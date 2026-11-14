//! Хост батча EVM.
//!
//!   rollup-evm-host --block-input <кэш RSP>/input/<chainId>/<N>.bin --chain-id <chainId> \
//!       [--witness witness.json] [--execute] [--write-input batch.bin] [--report report.json]
//!
//! Вход блока готовит штатный `rsp --cache-dir` (он ходит в узел EVM за блоком и доказательствами
//! состояния). Хост добавляет свидетель rollup'а (очередь L1, прежние выводы, порции данных),
//! считает публичные значения нативно и, с `--execute`, исполняет гостевую программу в zkVM
//! БЕЗ пруфа и сверяет её публичные значения с нативными. Пруфов этот хост не строит.
use std::{fs, path::PathBuf};

use alloy_primitives::{Address, B256};
use clap::Parser;
use rollup_evm::{
    apply_evm_batch, block_data_chunks, Deposit, EvmBatchInput, PublicValues, QueueItem, WithdrawalLeaf,
};
use rsp_client_executor::io::EthClientExecutorInput;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{Prover, ProverClient},
    include_elf, Elf, SP1Stdin,
};

const EVM_ELF: Elf = include_elf!("rollup-evm-program");

#[derive(Parser)]
struct Args {
    /// Вход блока в формате кэша RSP: <cache-dir>/input/<chainId>/<номер блока>.bin
    #[arg(long)]
    block_input: PathBuf,
    /// Идентификатор rollup'а: первое слово публичных значений.
    #[arg(long)]
    chain_id: u64,
    /// JSON со свидетелем rollup'а: очередь L1 и прежние выводы. Без него — пустые.
    #[arg(long)]
    witness: Option<PathBuf>,
    /// Исполнить гостевую программу в zkVM (без пруфа) и сверить с нативным расчётом.
    #[arg(long)]
    execute: bool,
    /// Записать вход батча (bincode) — фикстура для тестов.
    #[arg(long)]
    write_input: Option<PathBuf>,
    /// Записать итог (JSON): восемь слов и, с --execute, число циклов.
    #[arg(long)]
    report: Option<PathBuf>,
}

/// Свидетель rollup'а: то, что в настоящей системе секвенсор берёт у контракта на TON.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WitnessFile {
    #[serde(default)]
    prev_deposit_hash: B256,
    #[serde(default)]
    deposits: Vec<DepositEntry>,
    #[serde(default)]
    prior_withdrawals: Vec<WithdrawalEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DepositEntry {
    l2_recipient: Address,
    /// Сумма в нанотонах, десятичной строкой.
    amount: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WithdrawalEntry {
    recipient_hash: B256,
    /// Сумма в нанотонах, десятичной строкой.
    amount: String,
}

fn amount(text: &str) -> u128 {
    text.parse().unwrap_or_else(|_| panic!("сумма «{text}» — не целое число нанотонов"))
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>())
}

fn words(values: &PublicValues) -> serde_json::Value {
    serde_json::json!({
        "chainId": values.chain_id.to_string(),
        "prevStateRoot": hex(&values.prev_state_root),
        "newStateRoot": hex(&values.new_state_root),
        "batchHash": hex(&values.batch_hash),
        "prevWithdrawalsRoot": hex(&values.prev_withdrawals_root),
        "withdrawalsRoot": hex(&values.withdrawals_root),
        "prevDepositHash": hex(&values.prev_deposit_hash),
        "newDepositHash": hex(&values.new_deposit_hash),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn main() {
    // Сборка под clippy гостевую программу не собирает: в бинарнике был бы прежний ELF.
    assert_eq!(
        env!("ROLLUP_EVM_GUEST_BUILD"),
        "собрана",
        "этот бинарник собран без гостевой программы (clippy): пересоберите обычной сборкой"
    );
    sp1_sdk::utils::setup_logger();
    let args = Args::parse();

    let block: EthClientExecutorInput = bincode::deserialize(
        &fs::read(&args.block_input).expect("файл входа блока не читается"),
    )
    .expect("вход блока не разобран: ожидается файл кэша RSP");
    let witness: WitnessFile = match &args.witness {
        Some(path) => serde_json::from_str(&fs::read_to_string(path).expect("файл свидетеля не читается"))
            .expect("свидетель не разобран"),
        None => WitnessFile::default(),
    };

    let data_chunks = block_data_chunks(&block.current_block);
    let data_bytes: usize = data_chunks.iter().map(Vec::len).sum();
    let transactions = block.current_block.body.transactions.len();
    let block_number = block.current_block.header.number;
    let input = EvmBatchInput {
        chain_id: args.chain_id,
        block,
        prev_deposit_hash: witness.prev_deposit_hash.0,
        queue_items: witness
            .deposits
            .iter()
            .map(|entry| {
                QueueItem::Deposit(Deposit { l2_recipient: entry.l2_recipient.into_array(), amount: amount(&entry.amount) })
            })
            .collect(),
        data_chunks,
        prior_withdrawals: witness
            .prior_withdrawals
            .iter()
            .map(|entry| WithdrawalLeaf { recipient_hash: entry.recipient_hash.0, amount: amount(&entry.amount) })
            .collect(),
    };
    let encoded = bincode::serialize(&input).expect("вход батча не сериализуется");

    // Сначала проверка, потом запись: фикстура отвергнутого батча не появляется.
    let native = apply_evm_batch(input).expect("нативный расчёт отверг батч");
    if let Some(path) = &args.write_input {
        fs::write(path, &encoded).expect("вход батча не записан");
        println!("Вход батча: {} ({} байт)", path.display(), encoded.len());
    }
    println!("Блок {block_number}: транзакций {transactions}, данных батча {data_bytes} байт");
    println!("{}", serde_json::to_string_pretty(&words(&native)).unwrap());

    let mut cycles = None;
    if args.execute {
        let mut stdin = SP1Stdin::new();
        stdin.write_vec(encoded);
        let client = ProverClient::from_env();
        let (output, report) = client.execute(EVM_ELF, stdin).run().expect("исполнение в zkVM не удалось");
        assert_eq!(output.as_slice(), native.to_bytes().as_slice(), "zkVM и нативный запуск разошлись");
        println!("Публичные значения zkVM совпали с нативным расчётом.");
        println!("Циклов zkVM: {}", report.total_instruction_count());
        cycles = Some(report.total_instruction_count());
    }

    if let Some(path) = &args.report {
        let report = serde_json::json!({
            "blockNumber": block_number,
            "transactions": transactions,
            "dataBytes": data_bytes,
            "publicValues": words(&native),
            "publicValuesBytes": hex(&native.to_bytes()),
            "zkvmCycles": cycles,
            "programElfSha256": sha256_hex(&EVM_ELF),
        });
        fs::write(path, serde_json::to_string_pretty(&report).unwrap() + "\n").expect("отчёт не записан");
    }
}
