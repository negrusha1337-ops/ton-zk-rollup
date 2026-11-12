//! Исполнение и доказательство программы перехода состояния в SP1.
//!
//!   cargo run --release -- --batch 1 --execute     # исполнить в zkVM, без пруфа
//!   cargo run --release -- --batch 1 --compressed  # сжатый STARK-пруф: проверка, что машина тянет доказательство
//!   cargo run --release -- --batch 1 --prove       # Groth16-пруф для отправки в TON
//!
//! В режиме --prove пишет fixtures/zkvm_batches/proof-batch<N>.json с полями
//! vkey, publicValues и proof — в том же виде, что фикстура шаблона Succinct, чтобы
//! её можно было импортировать скриптом zk/import-sp1-fixture.mjs.
//!
//! Сборке нужен protoc (переменная PROTOC), режиму --prove — Docker либо Go
//! (feature native-gnark) и ~6 ГБ артефактов схемы. Подробности — PROVING.md.
use std::path::PathBuf;

use clap::Parser;
use rollup_native::Scenario;
use rollup_stf::{apply_batch, BatchInput};
use serde::Serialize;
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};

const ROLLUP_ELF: Elf = include_elf!("rollup-program");

/// Нонс пруфа, отправляемого в TON (см. комментарий у вызова `with_proof_nonce`).
const PROOF_NONCE: [u32; 4] = [0; 4];

#[derive(Parser, Debug)]
struct Args {
    /// Номер батча сценария: 1 или 2.
    #[arg(long)]
    batch: u8,
    #[arg(long)]
    execute: bool,
    /// Сжатый STARK-пруф без Groth16-обёртки: в TON не отправляется, только диагностика.
    #[arg(long)]
    compressed: bool,
    #[arg(long)]
    prove: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofFixture {
    batch: u8,
    vkey: String,
    public_values: String,
    proof: String,
}

/// Вход батча из общего сценария; батч 2 продолжает состояние после батча 1.
fn batch_input(batch: u8) -> BatchInput {
    let scenario = Scenario::new();
    let first = scenario.batch1();
    match batch {
        1 => first,
        2 => {
            let (_, accounts, withdrawals) = apply_batch(&first).expect("батч 1 сценария некорректен");
            scenario.batch2(accounts, withdrawals)
        }
        other => panic!("в сценарии нет батча {other}: допустимы 1 и 2"),
    }
}

fn main() {
    sp1_sdk::utils::setup_logger();
    let args = Args::parse();
    if [args.execute, args.compressed, args.prove].iter().filter(|&&mode| mode).count() != 1 {
        eprintln!("Укажите ровно один режим: --execute, --compressed или --prove");
        std::process::exit(1);
    }

    let input = batch_input(args.batch);
    let (expected, _, _) = apply_batch(&input).expect("батч сценария некорректен");
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);

    let client = ProverClient::from_env();

    if args.execute {
        let (output, report) = client.execute(ROLLUP_ELF, stdin).run().expect("исполнение в zkVM не удалось");
        assert_eq!(output.as_slice(), expected.to_bytes().as_slice(), "zkVM и нативный запуск разошлись");
        println!("Публичные значения совпали с нативным запуском.");
        println!("Циклов zkVM: {}", report.total_instruction_count());
        return;
    }

    let pk = client.setup(ROLLUP_ELF).expect("не удалось подготовить ключ программы");
    println!("Ключ программы: {}", pk.verifying_key().bytes32());

    if args.compressed {
        let started = std::time::Instant::now();
        let proof = client.prove(&pk, stdin).compressed().run().expect("не удалось построить сжатый пруф");
        assert_eq!(proof.public_values.as_slice(), expected.to_bytes().as_slice(), "пруф и нативный запуск разошлись");
        client.verify(&proof, pk.verifying_key(), None).expect("сжатый пруф не прошёл локальную проверку");
        println!("Сжатый пруф построен и проверен за {:.0} с.", started.elapsed().as_secs_f64());
        return;
    }

    // Нонс — пятый публичный вход Groth16-верификатора SP1; его задаёт доказывающий (128 бит).
    // Нулевой нонс не добавляет в TON ни одного сложения точек, поэтому фиксируем его явно:
    // от значения по умолчанию в SDK зависеть нельзя — запас по газу у верификатора ~5%.
    let proof = client
        .prove(&pk, stdin)
        .groth16()
        .with_proof_nonce(PROOF_NONCE)
        .run()
        .expect("не удалось построить пруф");
    assert_eq!(proof.public_values.as_slice(), expected.to_bytes().as_slice(), "пруф и нативный запуск разошлись");
    client.verify(&proof, pk.verifying_key(), None).expect("пруф не прошёл локальную проверку");

    let fixture = ProofFixture {
        batch: args.batch,
        vkey: pk.verifying_key().bytes32().to_string(),
        public_values: format!("0x{}", hex::encode(proof.public_values.as_slice())),
        proof: format!("0x{}", hex::encode(proof.bytes())),
    };
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/zkvm_batches");
    std::fs::create_dir_all(&dir).expect("не удалось создать каталог фикстур");
    let file = dir.join(format!("proof-batch{}.json", args.batch));
    std::fs::write(&file, serde_json::to_string_pretty(&fixture).expect("JSON") + "\n")
        .expect("не удалось записать фикстуру");
    println!("Пруф записан: fixtures/zkvm_batches/proof-batch{}.json", args.batch);
}
