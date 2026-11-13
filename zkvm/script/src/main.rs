//! Исполнение и доказательство программ rollup'а в SP1.
//!
//!   cargo run --release -- --batch 1 --execute     # исполнить в zkVM, без пруфа
//!   cargo run --release -- --batch 3 --transfers 1000 --execute   # нагрузочный батч: цена данных в циклах
//!   cargo run --release -- --batch 1 --compressed  # сжатый STARK-пруф: проверка, что машина тянет доказательство
//!   cargo run --release -- --batch 1 --prove       # Groth16-пруф для отправки в TON
//!   cargo run --release -- --exit alice --prove    # пруф аварийного выхода счёта из сценария
//!
//! В режиме --prove пишет фикстуру с полями vkey, publicValues и proof — в том же виде,
//! что фикстура шаблона Succinct, чтобы её можно было импортировать скриптом
//! zk/import-sp1-fixture.mjs: fixtures/zkvm_batches/proof-batch<N>.json для батча,
//! fixtures/zkvm_exit/proof-<имя>.json для выхода.
//!
//! Сборке нужен protoc (переменная PROTOC), режиму --prove — Docker либо Go
//! (feature native-gnark) и ~6 ГБ артефактов схемы. Подробности — PROVING.md.
use std::path::PathBuf;

use clap::Parser;
use rollup_exit::prove_exit;
use rollup_native::{Scenario, EXIT_NAMES};
use rollup_stf::{apply_batch, Account, BatchInput, WithdrawalLeaf};
use serde::Serialize;
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};

const ROLLUP_ELF: Elf = include_elf!("rollup-program");
const EXIT_ELF: Elf = include_elf!("rollup-exit-program");

/// Нонс пруфа, отправляемого в TON (см. комментарий у вызова `with_proof_nonce`).
const PROOF_NONCE: [u32; 4] = [0; 4];

#[derive(Parser, Debug)]
struct Args {
    /// Номер батча сценария: 1 или 2; 3 — нагрузочный батч для замеров (только --execute).
    #[arg(long)]
    batch: Option<u8>,
    /// Аварийный выход счёта сценария (alice или bob) из состояния после батча 2.
    #[arg(long)]
    exit: Option<String>,
    /// Число переводов в нагрузочном батче.
    #[arg(long, default_value_t = 1000)]
    transfers: usize,
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
    subject: String,
    vkey: String,
    public_values: String,
    proof: String,
}

/// Одно задание пруверу: программа, её вход и то, что она обязана выдать.
struct Job {
    /// Что доказываем — для сообщений и для фикстуры.
    subject: String,
    elf: Elf,
    stdin: SP1Stdin,
    /// Публичные значения по нативному запуску той же логики.
    expected: Vec<u8>,
    /// Куда писать пруф, относительно fixtures/.
    fixture: PathBuf,
    /// Байт и порций данных батча (у выхода данных нет).
    data: Option<(usize, usize)>,
}

/// Вход батча 2 сценария и состояние с выводами после него.
fn state_after_batch2(scenario: &Scenario) -> (BatchInput, Vec<Account>, Vec<WithdrawalLeaf>) {
    let (_, accounts, withdrawals) = apply_batch(&scenario.batch1()).expect("батч 1 сценария некорректен");
    let second = scenario.batch2(accounts, withdrawals);
    let (_, accounts, withdrawals) = apply_batch(&second).expect("батч 2 сценария некорректен");
    (second, accounts, withdrawals)
}

fn batch_job(batch: u8, transfers: usize) -> Job {
    let scenario = Scenario::new();
    let input = match batch {
        1 => scenario.batch1(),
        2 => state_after_batch2(&scenario).0,
        3 => {
            let (_, accounts, withdrawals) = state_after_batch2(&scenario);
            scenario.load_batch(accounts, withdrawals, transfers)
        }
        other => panic!("в сценарии нет батча {other}: допустимы 1, 2 и 3"),
    };
    let (expected, _, _) = apply_batch(&input).expect("батч сценария некорректен");
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);
    Job {
        subject: format!("батч {batch}"),
        elf: ROLLUP_ELF,
        stdin,
        expected: expected.to_bytes().to_vec(),
        fixture: PathBuf::from("zkvm_batches").join(format!("proof-batch{batch}.json")),
        data: Some((input.data_chunks.iter().map(Vec::len).sum(), input.data_chunks.len())),
    }
}

fn exit_job(name: &str) -> Job {
    if !EXIT_NAMES.contains(&name) {
        panic!("в сценарии нет счёта {name}: допустимы {EXIT_NAMES:?}");
    }
    let scenario = Scenario::new();
    let (_, accounts, _) = state_after_batch2(&scenario);
    let input = scenario.exit_input(name, accounts);
    let expected = prove_exit(&input).expect("заявка на выход некорректна");
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);
    Job {
        subject: format!("выход {name}"),
        elf: EXIT_ELF,
        stdin,
        expected: expected.to_bytes().to_vec(),
        fixture: PathBuf::from("zkvm_exit").join(format!("proof-{name}.json")),
        data: None,
    }
}

fn execute(client: &impl Prover, job: Job) {
    let (output, report) = client.execute(job.elf, job.stdin).run().expect("исполнение в zkVM не удалось");
    assert_eq!(output.as_slice(), job.expected.as_slice(), "zkVM и нативный запуск разошлись");
    println!("Публичные значения совпали с нативным запуском.");
    println!("Циклов zkVM: {}", report.total_instruction_count());
    if let Some((bytes, chunks)) = job.data {
        println!("Данных батча: {bytes} байт в {chunks} порциях");
        // Счётчики по меткам заполняются только в сборке с --features profiling.
        for (label, title) in [
            ("data-hash", "Циклов на хеш данных (привязка к TON)"),
            ("state-transition", "Циклов на переход состояния (разбор, подписи, балансы)"),
        ] {
            println!("{title}: {}", report.cycle_tracker.get(label).copied().unwrap_or(0));
        }
    }
}

fn main() {
    sp1_sdk::utils::setup_logger();
    let args = Args::parse();
    if [args.execute, args.compressed, args.prove].iter().filter(|&&mode| mode).count() != 1 {
        eprintln!("Укажите ровно один режим: --execute, --compressed или --prove");
        std::process::exit(1);
    }
    let job = match (args.batch, args.exit.as_deref()) {
        (Some(3), None) if !args.execute => {
            eprintln!("Батч 3 — нагрузочный, только для замеров: допустим один режим --execute");
            std::process::exit(1);
        }
        (Some(batch), None) => batch_job(batch, args.transfers),
        (None, Some(name)) => exit_job(name),
        _ => {
            eprintln!("Укажите ровно одно: --batch <номер> или --exit <имя счёта>");
            std::process::exit(1);
        }
    };

    let client = ProverClient::from_env();
    if args.execute {
        execute(&client, job);
        return;
    }

    let pk = client.setup(job.elf).expect("не удалось подготовить ключ программы");
    println!("Ключ программы: {}", pk.verifying_key().bytes32());

    if args.compressed {
        let started = std::time::Instant::now();
        let proof = client.prove(&pk, job.stdin).compressed().run().expect("не удалось построить сжатый пруф");
        assert_eq!(proof.public_values.as_slice(), job.expected.as_slice(), "пруф и нативный запуск разошлись");
        client.verify(&proof, pk.verifying_key(), None).expect("сжатый пруф не прошёл локальную проверку");
        println!("Сжатый пруф построен и проверен за {:.0} с.", started.elapsed().as_secs_f64());
        return;
    }

    // Нонс — пятый публичный вход Groth16-верификатора SP1; его задаёт доказывающий (128 бит).
    // Нулевой нонс не добавляет в TON ни одного сложения точек, поэтому фиксируем его явно:
    // от значения по умолчанию в SDK зависеть нельзя — запас по газу у верификатора ~5%.
    let proof = client
        .prove(&pk, job.stdin)
        .groth16()
        .with_proof_nonce(PROOF_NONCE)
        .run()
        .expect("не удалось построить пруф");
    assert_eq!(proof.public_values.as_slice(), job.expected.as_slice(), "пруф и нативный запуск разошлись");
    client.verify(&proof, pk.verifying_key(), None).expect("пруф не прошёл локальную проверку");

    let fixture = ProofFixture {
        subject: job.subject,
        vkey: pk.verifying_key().bytes32().to_string(),
        public_values: format!("0x{}", hex::encode(proof.public_values.as_slice())),
        proof: format!("0x{}", hex::encode(proof.bytes())),
    };
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures").join(&job.fixture);
    std::fs::create_dir_all(file.parent().expect("у пути фикстуры есть каталог"))
        .expect("не удалось создать каталог фикстур");
    std::fs::write(&file, serde_json::to_string_pretty(&fixture).expect("JSON") + "\n")
        .expect("не удалось записать фикстуру");
    println!("Пруф записан: fixtures/{}", job.fixture.display());
}
