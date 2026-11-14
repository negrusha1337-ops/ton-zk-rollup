//! Хост батча EVM.
//!
//!   rollup-evm-host --vkeys                                  # ключ программы → fixtures/evm_batches/program.json
//!   rollup-evm-host --block-input <кэш RSP>/input/<chainId>/<N>.bin --chain-id <chainId> \
//!       [--witness witness.json] [--execute] [--write-input batch.bin] [--report report.json]
//!   rollup-evm-host --batch-input batch.bin --execute         # готовый вход батча (фикстура)
//!   rollup-evm-host --batch-input batch.bin --prove --proof-out proof.json
//!
//! Вход блока готовит штатный `rsp --cache-dir` (он ходит в узел EVM за блоком и доказательствами
//! состояния). Хост добавляет свидетель rollup'а (очередь L1, прежние выводы, порции данных),
//! считает публичные значения нативно и, с `--execute`, исполняет гостевую программу в zkVM
//! БЕЗ пруфа и сверяет её публичные значения с нативными.
//!
//! Работа прувера — только через `host/prove-guarded.sh` и только по отдельной команде:
//!   `--compressed` — пробный СЖАТЫЙ пруф (STARK без обёртки в Groth16): замер времени и памяти,
//!       контракт такой пруф не принимает;
//!   `--prove` — пруф Groth16 для контракта на TON (нужна сборка с `--features native-gnark`).
//!       Нонс SP1 фиксирован нулём: так его ждёт ключ контракта. Перед пруфом хост сверяет, что
//!       собран из нынешних исходников и что program.json описывает именно эту сборку.
use std::{
    fs,
    path::{Path, PathBuf},
};

use alloy_primitives::{Address, B256};
use clap::Parser;
use rollup_evm::{
    apply_evm_batch, block_data_chunks, Deposit, EvmBatchInput, PublicValues, QueueItem, WithdrawalLeaf,
};
use rsp_client_executor::io::EthClientExecutorInput;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};

mod sources;

const EVM_ELF: Elf = include_elf!("rollup-evm-program");
/// Нонс пруфа — пятый публичный вход верификатора SP1. В ключе контракта он свёрнут как ноль.
const PROOF_NONCE: [u32; 4] = [0; 4];
/// Хеш исходников программы на момент сборки этого бинарника (build.rs).
const BUILT_FROM_SOURCES: &str = env!("ROLLUP_EVM_SOURCES_SHA256");
/// Хеш исходников хоста на момент сборки.
const BUILT_FROM_HOST: &str = env!("ROLLUP_EVM_HOST_SHA256");
const SP1_VERSION: &str = env!("ROLLUP_EVM_SP1_SDK");
const GUEST_RUSTC: &str = env!("ROLLUP_EVM_GUEST_RUSTC");
const HOST_CARGO: &str = env!("ROLLUP_EVM_CARGO");

#[derive(Parser)]
struct Args {
    /// Посчитать ключ программы и записать fixtures/evm_batches/program.json.
    #[arg(long, conflicts_with_all = ["block_input", "batch_input", "execute", "compressed", "prove"])]
    vkeys: bool,
    /// Вход блока в формате кэша RSP: <cache-dir>/input/<chainId>/<номер блока>.bin
    #[arg(long, requires = "chain_id", conflicts_with = "batch_input")]
    block_input: Option<PathBuf>,
    /// Идентификатор rollup'а: первое слово публичных значений (с --block-input).
    #[arg(long, conflicts_with = "batch_input")]
    chain_id: Option<u64>,
    /// JSON со свидетелем rollup'а: очередь L1 и прежние выводы. Без него — пустые.
    #[arg(long, requires = "block_input")]
    witness: Option<PathBuf>,
    /// Готовый вход батча (bincode), записанный раньше через --write-input.
    #[arg(long)]
    batch_input: Option<PathBuf>,
    /// Исполнить гостевую программу в zkVM (без пруфа) и сверить с нативным расчётом.
    #[arg(long)]
    execute: bool,
    /// Построить и проверить сжатый пруф (без Groth16): замер времени и памяти. Тяжёлая работа.
    #[arg(long, conflicts_with_all = ["execute", "prove"])]
    compressed: bool,
    /// Построить пруф Groth16 для контракта и записать его в --proof-out. Тяжёлая работа.
    #[arg(long, conflicts_with = "execute", requires = "proof_out")]
    prove: bool,
    /// Куда записать пруф Groth16 (JSON в формате zk/import-sp1-fixture.mjs).
    #[arg(long, requires = "prove")]
    proof_out: Option<PathBuf>,
    /// Записать вход батча (bincode) — фикстура для тестов.
    #[arg(long)]
    write_input: Option<PathBuf>,
    /// Записать итог (JSON): восемь слов, данные батча и, с --execute, число циклов.
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

/// Ключ программы и то, из чего он получен. Пишется режимом --vkeys.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgramKeys {
    source: String,
    note: String,
    sp1_version: String,
    guest_rustc: String,
    cargo: String,
    /// Хеш исходников программы: host/src/sources.rs, повтор — zk/evm-binding.mjs.
    sources_sha256: String,
    #[serde(rename = "programVKey")]
    program_vkey: String,
    program_elf_sha256: String,
}

/// Файл пруфа Groth16 — тот же формат, что пишет zkvm/script: его читает zk/import-sp1-fixture.mjs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofFixture {
    subject: String,
    vkey: String,
    public_values: String,
    proof: String,
    sources_sha256: String,
    elf_sha256: String,
}

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn program_keys_file() -> PathBuf {
    repository().join("fixtures/evm_batches/program.json")
}

fn amount(text: &str) -> u128 {
    text.parse().unwrap_or_else(|_| panic!("сумма «{text}» — не целое число нанотонов"))
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", plain_hex(bytes))
}

fn plain_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn elf_sha256() -> String {
    plain_hex(&Sha256::digest(&EVM_ELF[..]))
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

/// Бинарник обязан быть собран из тех исходников, что лежат на диске: иначе ELF внутри него —
/// от прежней версии, и пруф докажет не ту программу.
fn assert_binary_is_fresh() {
    let repository = repository();
    for (what, built, on_disk) in [
        ("программы", BUILT_FROM_SOURCES, sources::sources_sha256(&repository)),
        ("хоста", BUILT_FROM_HOST, sources::host_sha256(&repository)),
    ] {
        if built != on_disk {
            eprintln!(
                "Исходники {what} изменились после сборки этого бинарника.\n  собран из: {built}\n  на диске:  {on_disk}\n\
                 Пересоберите: cargo build --release --locked -p rollup-evm-host"
            );
            std::process::exit(2);
        }
    }
}

fn program_vkey(client: &impl Prover) -> String {
    client.setup(EVM_ELF.clone()).expect("не удалось подготовить ключ программы").verifying_key().bytes32().to_string()
}

fn write_program_keys() {
    assert_binary_is_fresh();
    let keys = ProgramKeys {
        source: "Сгенерировано zkvm-evm/host (--vkeys); не редактировать вручную".into(),
        note: "Ключ программы батча EVM — первый публичный вход верификатора SP1; зависит от точного ELF, \
               то есть от исходников (sourcesSha256) и сборочного окружения. Его константа входит в ключ \
               контракта: fixtures/evm_batches/key.json."
            .into(),
        sp1_version: SP1_VERSION.into(),
        guest_rustc: GUEST_RUSTC.into(),
        cargo: HOST_CARGO.into(),
        sources_sha256: BUILT_FROM_SOURCES.into(),
        program_vkey: program_vkey(&ProverClient::from_env()),
        program_elf_sha256: elf_sha256(),
    };
    let file = program_keys_file();
    fs::create_dir_all(file.parent().expect("у файла есть каталог")).expect("каталог фикстур не создан");
    fs::write(&file, serde_json::to_string_pretty(&keys).expect("JSON") + "\n").expect("program.json не записан");
    println!("Ключ программы батча EVM: {}", keys.program_vkey);
    println!("Хеш исходников:           {}", keys.sources_sha256);
    println!("Записано: fixtures/evm_batches/program.json");
}

/// program.json обязан описывать именно эту сборку: иначе ключ контракта выведен для другого ELF.
fn assert_matches_program_keys(vkey: &str) {
    let recorded: ProgramKeys = serde_json::from_str(
        &fs::read_to_string(program_keys_file()).expect("нет fixtures/evm_batches/program.json: сначала --vkeys"),
    )
    .expect("program.json не разобран");
    for (name, recorded, actual) in [
        ("sourcesSha256", recorded.sources_sha256, BUILT_FROM_SOURCES.to_string()),
        ("programElfSha256", recorded.program_elf_sha256, elf_sha256()),
        ("programVKey", recorded.program_vkey, vkey.to_string()),
    ] {
        if recorded != actual {
            eprintln!(
                "program.json не соответствует этой сборке: {name}\n  в файле:  {recorded}\n  в сборке: {actual}\n\
                 Запустите rollup-evm-host --vkeys и выведите ключ контракта заново."
            );
            std::process::exit(2);
        }
    }
}

/// Вход батча: готовый (--batch-input) или собранный из входа блока RSP и свидетеля.
fn load_input(args: &Args) -> EvmBatchInput {
    if let Some(path) = &args.batch_input {
        return bincode::deserialize(&fs::read(path).expect("файл входа батча не читается"))
            .expect("вход батча не разобран");
    }
    let path = args.block_input.as_ref().expect("нужен --block-input или --batch-input");
    let block: EthClientExecutorInput =
        bincode::deserialize(&fs::read(path).expect("файл входа блока не читается"))
            .expect("вход блока не разобран: ожидается файл кэша RSP");
    let witness: WitnessFile = match &args.witness {
        Some(path) => serde_json::from_str(&fs::read_to_string(path).expect("файл свидетеля не читается"))
            .expect("свидетель не разобран"),
        None => WitnessFile::default(),
    };
    EvmBatchInput {
        chain_id: args.chain_id.expect("с --block-input нужен --chain-id"),
        data_chunks: block_data_chunks(&block.current_block),
        block,
        prev_deposit_hash: witness.prev_deposit_hash.0,
        queue_items: witness
            .deposits
            .iter()
            .map(|entry| {
                QueueItem::Deposit(Deposit { l2_recipient: entry.l2_recipient.into_array(), amount: amount(&entry.amount) })
            })
            .collect(),
        prior_withdrawals: witness
            .prior_withdrawals
            .iter()
            .map(|entry| WithdrawalLeaf { recipient_hash: entry.recipient_hash.0, amount: amount(&entry.amount) })
            .collect(),
    }
}

fn main() {
    // Сборка под clippy гостевую программу не собирает: в бинарнике был бы прежний ELF.
    assert!(
        BUILT_FROM_SOURCES.chars().all(|c| c.is_ascii_hexdigit()),
        "этот бинарник собран без гостевой программы (clippy): пересоберите обычной сборкой"
    );
    sp1_sdk::utils::setup_logger();
    let args = Args::parse();
    if args.vkeys {
        return write_program_keys();
    }

    let input = load_input(&args);
    let data_chunks_hex: Vec<String> = input.data_chunks.iter().map(|chunk| plain_hex(chunk)).collect();
    let data_bytes: usize = input.data_chunks.iter().map(Vec::len).sum();
    let transactions = input.block.current_block.body.transactions.len();
    let block_number = input.block.current_block.header.number;
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
        stdin.write_vec(encoded.clone());
        let client = ProverClient::from_env();
        let (output, report) = client.execute(EVM_ELF, stdin).run().expect("исполнение в zkVM не удалось");
        assert_eq!(output.as_slice(), native.to_bytes().as_slice(), "zkVM и нативный запуск разошлись");
        println!("Публичные значения zkVM совпали с нативным расчётом.");
        println!("Циклов zkVM: {}", report.total_instruction_count());
        cycles = Some(report.total_instruction_count());
    }

    let mut proof_seconds = None;
    let mut vkey = None;
    if args.compressed || args.prove {
        // Прувер берётся из окружения. С SP1_PROVER=mock «пруф» — пустышка, а его проверка всегда
        // успешна: в режимах пруфа допустим только настоящий процессорный прувер.
        let prover = std::env::var("SP1_PROVER").unwrap_or_else(|_| "cpu".into());
        if prover != "cpu" {
            eprintln!("Режимы пруфа работают только с SP1_PROVER=cpu (сейчас «{prover}»).");
            std::process::exit(2);
        }
        assert_binary_is_fresh();
        let mut stdin = SP1Stdin::new();
        stdin.write_vec(encoded.clone());
        let client = ProverClient::from_env();
        let pk = client.setup(EVM_ELF.clone()).expect("не удалось подготовить ключ программы");
        let program_vkey = pk.verifying_key().bytes32().to_string();
        println!("Ключ программы: {program_vkey}");
        let started = std::time::Instant::now();
        if args.compressed {
            let proof = client.prove(&pk, stdin).compressed().run().expect("не удалось построить сжатый пруф");
            assert_eq!(proof.public_values.as_slice(), native.to_bytes().as_slice(), "пруф и нативный запуск разошлись");
            client.verify(&proof, pk.verifying_key(), None).expect("сжатый пруф не прошёл локальную проверку");
            println!("Сжатый пруф построен и проверен за {:.0} с.", started.elapsed().as_secs_f64());
        } else {
            assert_matches_program_keys(&program_vkey);
            let proof = client
                .prove(&pk, stdin)
                .groth16()
                .with_proof_nonce(PROOF_NONCE)
                .run()
                .expect("не удалось построить пруф");
            assert_eq!(proof.public_values.as_slice(), native.to_bytes().as_slice(), "пруф и нативный запуск разошлись");
            client.verify(&proof, pk.verifying_key(), None).expect("пруф не прошёл локальную проверку");
            println!("Пруф Groth16 построен и проверен за {:.0} с.", started.elapsed().as_secs_f64());
            let fixture = ProofFixture {
                subject: format!("EVM batch: block {block_number}"),
                vkey: program_vkey.clone(),
                public_values: hex(proof.public_values.as_slice()),
                proof: hex(&proof.bytes()),
                sources_sha256: BUILT_FROM_SOURCES.to_string(),
                elf_sha256: elf_sha256(),
            };
            let file = args.proof_out.as_ref().expect("с --prove нужен --proof-out");
            fs::write(file, serde_json::to_string_pretty(&fixture).expect("JSON") + "\n").expect("пруф не записан");
            println!("Пруф записан: {}", file.display());
        }
        proof_seconds = Some(started.elapsed().as_secs_f64());
        vkey = Some(program_vkey);
    }

    if let Some(path) = &args.report {
        let report = serde_json::json!({
            "blockNumber": block_number,
            "transactions": transactions,
            "dataBytes": data_bytes,
            "dataChunksHex": data_chunks_hex,
            "publicValues": words(&native),
            "publicValuesBytes": hex(&native.to_bytes()),
            "zkvmCycles": cycles,
            "programElfSha256": format!("0x{}", elf_sha256()),
            "proofMode": if args.compressed { Some("compressed") } else if args.prove { Some("groth16") } else { None },
            "proofSeconds": proof_seconds,
            "programVKey": vkey,
        });
        fs::write(path, serde_json::to_string_pretty(&report).unwrap() + "\n").expect("отчёт не записан");
    }
}
