//! Хост спайка агрегации (измерение, не протокол).
//!
//!   spike-aggregate-host --evm-elf <ELF EVM> --agg-elf <ELF агрегатора> \
//!       --program-json fixtures/evm_batches/program.json \
//!       --proof block-1.bin --proof block-2.bin … --out-dir <каталог> [--no-groth16]
//!
//! Сжатые пруфы блоков (`--proof`, bincode SDK) строит уже существующий хост EVM
//! (`rollup-evm-host --prove-compressed`). Здесь: ключ программы EVM из ELF сверяется с
//! program.json, каждый пруф блока — проверка под этим ключом и сцепка публичных значений, затем
//! агрегатор исполняется (циклы), доказывается сжатым пруфом и пруфом Groth16; оба проверяются
//! локально, их публичные значения сверяются с расчётом здесь же. Итог — `<каталог>/result.json`
//! (время каждого этапа), `aggregate-compressed.bin`, `aggregate-groth16.json` (тот же формат,
//! что у пруфов хоста EVM: subject, vkey, publicValues, proof).
//!
//! Второй вид — «тёплый» конвейер в одном процессе: `--block-input block-N.bin …` (вход блока EVM,
//! bincode, как у `rollup-evm-host --batch-input`) — сжатые пруфы блоков строятся здесь же тем же
//! клиентом и ключом (сервер GPU и ключ подняты один раз), сохраняются в `<каталог>/block-K.bin`
//! (K — порядковый номер во входе); с `--blocks-only` на этом всё, иначе дальше агрегат, как с
//! `--proof`. `GROTH16_REPEAT=2` — Groth16 агрегата дважды в одном процессе: второй — «тёплый»
//! (схема gnark уже прочитана); в файл идёт последний.
//!
//! Прувер — `SP1_PROVER` (`cpu` или `cuda` в сборке с `--features cuda`), карта —
//! `SP1_CUDA_DEVICE`, как у хоста EVM (zkvm-evm/host/src/proving.rs).
use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use clap::Parser;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{EnvProver, ProveRequest, Prover, ProverClient},
    Elf, HashableKey, ProvingKey, SP1Proof, SP1ProofWithPublicValues, SP1Stdin,
};

/// Нонс — ноль, как у пруфов блоков и в ключе контракта.
const PROOF_NONCE: [u32; 4] = [0; 4];
/// Та же константа, что в program/src/main.rs (`EVM_PROGRAM_VKEY`).
const EVM_PROGRAM_VKEY: [u32; 8] =
    [573122128, 1916503089, 32984431, 822869928, 1576904526, 629969851, 1875121723, 842651981];
const WORD: usize = 32;
const PUBLIC_VALUES_BYTES: usize = 11 * WORD;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    evm_elf: PathBuf,
    #[arg(long)]
    agg_elf: PathBuf,
    #[arg(long)]
    program_json: PathBuf,
    /// Сжатые пруфы блоков по порядку цепочки.
    #[arg(long = "proof", required_unless_present = "block_inputs", conflicts_with = "block_inputs")]
    proofs: Vec<PathBuf>,
    /// Входы блоков EVM (bincode) по порядку цепочки: сжатые пруфы строятся в этом процессе.
    #[arg(long = "block-input")]
    block_inputs: Vec<PathBuf>,
    /// Только сжатые пруфы блоков из --block-input, без агрегата.
    #[arg(long, requires = "block_inputs")]
    blocks_only: bool,
    #[arg(long)]
    out_dir: PathBuf,
    /// Только исполнение и сжатый агрегат.
    #[arg(long)]
    no_groth16: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Report {
    blocks: usize,
    prover: String,
    cuda_device: Option<String>,
    evm_program_vkey: String,
    aggregate_vkey: String,
    aggregate_elf_sha256: String,
    aggregate_public_values: String,
    aggregate_cycles: u64,
    seconds: Stages,
    /// Сжатые пруфы блоков в этом процессе (--block-input): секунды на каждый, по порядку.
    block_compressed_seconds: Vec<f64>,
    /// Groth16 агрегата при GROTH16_REPEAT > 1: секунды каждого запуска.
    groth16_repeat_seconds: Vec<f64>,
    compressed_proof_bytes: u64,
    groth16_proof_bytes: usize,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Stages {
    client: f64,
    evm_setup: f64,
    block_proofs_verify: f64,
    aggregate_setup: f64,
    execute: f64,
    compressed: f64,
    compressed_verify: f64,
    groth16: Option<f64>,
    groth16_verify: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofFixture {
    subject: String,
    vkey: String,
    public_values: String,
    proof: String,
    elf_sha256: String,
}

fn refuse(message: String) -> ! {
    eprintln!("{message}");
    std::process::exit(2);
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn word(values: &[u8], index: usize) -> &[u8] {
    &values[index * WORD..(index + 1) * WORD]
}

/// Тот же расчёт, что в госте: сцепка и 11 слов «от первого prev до последнего new».
fn expected_aggregate(blocks: &[Vec<u8>]) -> Vec<u8> {
    for (index, pair) in blocks.windows(2).enumerate() {
        let (prev, next) = (&pair[0], &pair[1]);
        for (left, right, name) in [(0, 0, "chainId"), (2, 1, "состояние"), (5, 4, "корень выводов"), (7, 6, "очередь"), (9, 8, "счётчик выводов")] {
            if word(prev, left) != word(next, right) {
                refuse(format!("пруфы {} и {} не сцепляются: {name}", index + 1, index + 2));
            }
        }
        if word(next, 10) < word(prev, 10) {
            refuse(format!("пруф {}: время убывает", index + 2));
        }
    }
    let (first, last) = (&blocks[0], &blocks[blocks.len() - 1]);
    let mut hasher = Sha256::new();
    for block in blocks {
        hasher.update(word(block, 3));
    }
    let batch_hash: [u8; 32] = hasher.finalize().into();
    let mut out = Vec::with_capacity(PUBLIC_VALUES_BYTES);
    for part in [word(first, 0), word(first, 1), word(last, 2), &batch_hash, word(first, 4), word(last, 5), word(first, 6), word(last, 7), word(first, 8), word(last, 9), word(last, 10)] {
        out.extend_from_slice(part);
    }
    out
}

fn json_field(file: &Path, field: &str) -> String {
    let text = fs::read_to_string(file).unwrap_or_else(|error| refuse(format!("{}: {error}", file.display())));
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|error| refuse(format!("{}: {error}", file.display())));
    value[field].as_str().unwrap_or_else(|| refuse(format!("{}: нет поля {field}", file.display()))).to_string()
}

fn client_from_env() -> (EnvProver, String, Option<String>) {
    let prover = std::env::var("SP1_PROVER").unwrap_or_else(|_| "cpu".into());
    let device = std::env::var("SP1_CUDA_DEVICE").ok();
    match prover.as_str() {
        "cpu" => (EnvProver::Cpu(ProverClient::builder().cpu().build()), prover, None),
        #[cfg(feature = "cuda")]
        "cuda" => {
            let id: u32 = device.as_deref().map(|raw| raw.parse().unwrap_or_else(|_| refuse(format!("SP1_CUDA_DEVICE «{raw}»")))).unwrap_or(0);
            remove_stale_gpu_socket(id);
            (EnvProver::Cuda(ProverClient::builder().cuda().with_device_id(id).build()), prover, device)
        }
        _ => refuse(format!("SP1_PROVER «{prover}»: только cpu или cuda (cuda — в сборке с --features cuda)")),
    }
}

/// Как в zkvm-evm/host/src/proving.rs: сокет сервера GPU, оставшийся от убитого сервера.
#[cfg(feature = "cuda")]
fn remove_stale_gpu_socket(id: u32) {
    let socket = PathBuf::from(format!("/tmp/sp1-cuda-{id}.sock"));
    if socket.exists() {
        if let Err(error) = std::os::unix::net::UnixStream::connect(&socket) {
            if error.kind() == std::io::ErrorKind::ConnectionRefused {
                eprintln!("Сокет {} без сервера — удаляю.", socket.display());
                let _ = fs::remove_file(&socket);
            }
        }
    }
}

fn stage<T>(name: &str, slot: &mut f64, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let result = work();
    *slot = started.elapsed().as_secs_f64();
    println!("[этап] {name}: {:.1} с", *slot);
    result
}

fn main() {
    let args = Args::parse();
    fs::create_dir_all(&args.out_dir).unwrap_or_else(|error| refuse(format!("{}: {error}", args.out_dir.display())));
    let blocks = args.proofs.len().max(args.block_inputs.len());
    let mut report = Report { blocks, ..Default::default() };
    let mut seconds = Stages::default();

    let evm_bytes = fs::read(&args.evm_elf).unwrap_or_else(|error| refuse(format!("{}: {error}", args.evm_elf.display())));
    let recorded_elf = json_field(&args.program_json, "programElfSha256");
    if hex(&Sha256::digest(&evm_bytes)) != recorded_elf {
        refuse(format!("ELF программы EVM — не тот, что в program.json ({recorded_elf})"));
    }
    let agg_bytes = fs::read(&args.agg_elf).unwrap_or_else(|error| refuse(format!("{}: {error}", args.agg_elf.display())));
    report.aggregate_elf_sha256 = hex(&Sha256::digest(&agg_bytes));
    let agg_elf = Elf::from(agg_bytes);

    let (client, prover, device) = stage("клиент прувера", &mut seconds.client, client_from_env);
    report.prover = prover;
    report.cuda_device = device;

    let evm_pk = stage("ключ программы EVM", &mut seconds.evm_setup, || client.setup(Elf::from(evm_bytes)).expect("setup EVM"));
    let evm_vk = evm_pk.verifying_key().clone();
    report.evm_program_vkey = evm_vk.bytes32();
    let recorded_vkey = json_field(&args.program_json, "programVKey");
    if report.evm_program_vkey != recorded_vkey {
        refuse(format!("ключ программы EVM {} ≠ program.json {recorded_vkey}", report.evm_program_vkey));
    }
    if evm_vk.hash_u32() != EVM_PROGRAM_VKEY {
        refuse(format!("hash_u32 ключа EVM {:?} ≠ константа агрегатора", evm_vk.hash_u32()));
    }

    let mut proof_files = args.proofs.clone();
    for (index, input) in args.block_inputs.iter().enumerate() {
        let bytes = fs::read(input).unwrap_or_else(|error| refuse(format!("{}: {error}", input.display())));
        let mut block_stdin = SP1Stdin::new();
        block_stdin.write_vec(bytes);
        let started = Instant::now();
        let proof = client
            .prove(&evm_pk, block_stdin)
            .compressed()
            .with_proof_nonce(PROOF_NONCE)
            .run()
            .unwrap_or_else(|error| refuse(format!("{}: сжатый пруф не построен: {error}", input.display())));
        let elapsed = started.elapsed().as_secs_f64();
        println!("[этап] сжатый пруф блока {} ({}): {elapsed:.1} с", index + 1, input.display());
        report.block_compressed_seconds.push(elapsed);
        let file = args.out_dir.join(format!("block-{}.bin", index + 1));
        proof.save(&file).expect("запись сжатого пруфа блока");
        proof_files.push(file);
    }
    if args.blocks_only {
        report.seconds = seconds;
        fs::write(args.out_dir.join("result.json"), serde_json::to_string_pretty(&report).unwrap() + "\n").expect("запись result.json");
        println!("Готово (только блоки): {}", args.out_dir.join("result.json").display());
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio");
        let _context = runtime.enter();
        drop(evm_pk);
        drop(client);
        return;
    }

    let mut public_values = Vec::new();
    let mut stdin = SP1Stdin::new();
    stdin.write(&EVM_PROGRAM_VKEY);
    stdin.write(&(proof_files.len() as u32));
    let mut inner = Vec::new();
    stage("проверка сжатых пруфов блоков", &mut seconds.block_proofs_verify, || {
        for path in &proof_files {
            let proof = SP1ProofWithPublicValues::load(path).unwrap_or_else(|error| refuse(format!("{}: {error}", path.display())));
            client.verify(&proof, &evm_vk, None).unwrap_or_else(|error| refuse(format!("{}: не прошёл проверку: {error}", path.display())));
            let values = proof.public_values.to_vec();
            if values.len() != PUBLIC_VALUES_BYTES {
                refuse(format!("{}: публичные значения не 352 байта", path.display()));
            }
            match proof.proof {
                SP1Proof::Compressed(inner_proof) => inner.push(*inner_proof),
                _ => refuse(format!("{}: не сжатый пруф", path.display())),
            }
            public_values.push(values);
        }
    });
    let expected = expected_aggregate(&public_values);
    for values in &public_values {
        stdin.write_vec(values.clone());
    }
    for proof in inner {
        stdin.write_proof(proof, evm_vk.vk.clone());
    }

    let agg_pk = stage("ключ агрегатора", &mut seconds.aggregate_setup, || client.setup(agg_elf.clone()).expect("setup агрегатора"));
    report.aggregate_vkey = agg_pk.verifying_key().bytes32();
    println!("Ключ агрегатора: {}", report.aggregate_vkey);

    let (values, execution) = stage("исполнение агрегатора", &mut seconds.execute, || {
        client.execute(agg_elf.clone(), stdin.clone()).run().expect("исполнение агрегатора")
    });
    report.aggregate_cycles = execution.total_instruction_count();
    println!("Циклы агрегатора: {}", report.aggregate_cycles);
    if values.to_vec() != expected {
        refuse("исполнение: публичные значения агрегатора ≠ расчёт хоста".into());
    }
    report.aggregate_public_values = format!("0x{}", hex(&expected));

    let compressed = stage("сжатый агрегат", &mut seconds.compressed, || {
        client.prove(&agg_pk, stdin.clone()).compressed().with_proof_nonce(PROOF_NONCE).run().expect("сжатый агрегат")
    });
    stage("проверка сжатого агрегата", &mut seconds.compressed_verify, || {
        client.verify(&compressed, agg_pk.verifying_key(), None).expect("сжатый агрегат не прошёл проверку")
    });
    if compressed.public_values.to_vec() != expected {
        refuse("сжатый агрегат: публичные значения ≠ расчёт хоста".into());
    }
    let compressed_file = args.out_dir.join("aggregate-compressed.bin");
    compressed.save(&compressed_file).expect("запись сжатого агрегата");
    report.compressed_proof_bytes = fs::metadata(&compressed_file).map(|meta| meta.len()).unwrap_or(0);

    if !args.no_groth16 {
        let repeats: u32 = std::env::var("GROTH16_REPEAT").ok().and_then(|raw| raw.parse().ok()).unwrap_or(1).max(1);
        let mut groth16_seconds = 0.0;
        let mut groth16 = None;
        for round in 1..=repeats {
            groth16 = Some(stage(&format!("Groth16 агрегата (с нуля, одним запросом), запуск {round} из {repeats}"), &mut groth16_seconds, || {
                client.prove(&agg_pk, stdin.clone()).groth16().with_proof_nonce(PROOF_NONCE).run().expect("Groth16 агрегата")
            }));
            report.groth16_repeat_seconds.push(groth16_seconds);
        }
        let groth16 = groth16.expect("хотя бы один запуск");
        seconds.groth16 = Some(report.groth16_repeat_seconds[0]);
        let mut verify_seconds = 0.0;
        stage("проверка Groth16 агрегата", &mut verify_seconds, || {
            client.verify(&groth16, agg_pk.verifying_key(), None).expect("Groth16 агрегата не прошёл проверку")
        });
        seconds.groth16_verify = Some(verify_seconds);
        if groth16.public_values.to_vec() != expected {
            refuse("Groth16 агрегата: публичные значения ≠ расчёт хоста".into());
        }
        let bytes = groth16.bytes();
        report.groth16_proof_bytes = bytes.len();
        let fixture = ProofFixture {
            subject: format!("spike: aggregate of {} EVM blocks", public_values.len()),
            vkey: report.aggregate_vkey.clone(),
            public_values: format!("0x{}", hex(groth16.public_values.as_slice())),
            proof: format!("0x{}", hex(&bytes)),
            elf_sha256: report.aggregate_elf_sha256.clone(),
        };
        fs::write(args.out_dir.join("aggregate-groth16.json"), serde_json::to_string_pretty(&fixture).unwrap() + "\n").expect("запись Groth16");
    }

    report.seconds = seconds;
    fs::write(args.out_dir.join("result.json"), serde_json::to_string_pretty(&report).unwrap() + "\n").expect("запись result.json");
    println!("Готово: {}", args.out_dir.join("result.json").display());
    // Как в хосте EVM: ключи на GPU закрывают сессию через tokio::spawn в Drop.
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio");
    let _context = runtime.enter();
    drop(agg_pk);
    drop(evm_pk);
    drop(client);
}
