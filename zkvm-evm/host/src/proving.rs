//! Режимы пруфа хоста. Тяжёлая работа: на этом маке — только через host/prove-guarded.sh, на
//! арендованном сервере — через host/remote/measure.sh.
//!
//!   `--compressed`        пробный сжатый пруф: построить, проверить, никуда не писать;
//!   `--prove`             пруф Groth16 для контракта → `--proof-out` (JSON для импортёра);
//!   `--prove-compressed`  сжатый пруф → `--proof-out` (bincode SDK): первый шаг двухшагового пути;
//!   `--wrap-groth16 <f>`  сжатый пруф из файла → Groth16 на ПРОЦЕССОРЕ → `--proof-out` (тот же
//!                         JSON, что у `--prove`): второй шаг, когда видеопамяти на обёртку мало.
//!
//! Прувер — из `SP1_PROVER`: `cpu` (по умолчанию) или `cuda` (сборка с `--features cuda`).
//! Иное — отказ: с `mock` «пруф» — пустышка, а его проверка всегда успешна. `--wrap-groth16`
//! работает только на процессоре.
use std::{fs, path::Path, time::Instant};

use sp1_sdk::{
    blocking::{EnvProver, ProveRequest, Prover, ProverClient},
    HashableKey, ProvingKey, SP1Proof, SP1ProofWithPublicValues, SP1Stdin,
};

use crate::program::{assert_matches_program_keys, Program};

/// Нонс пруфа — пятый публичный вход верификатора SP1. В ключе контракта он свёрнут как ноль.
const PROOF_NONCE: [u32; 4] = [0; 4];

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode<'a> {
    Compressed,
    Groth16,
    ProveCompressed,
    WrapGroth16(&'a Path),
}

impl Mode<'_> {
    pub fn name(&self) -> &'static str {
        match self {
            Mode::Compressed => "compressed",
            Mode::Groth16 => "groth16",
            Mode::ProveCompressed => "prove-compressed",
            Mode::WrapGroth16(_) => "wrap-groth16",
        }
    }
}

/// Что вызывающий знает о батче и сборке.
pub struct Job<'a> {
    pub program: &'a Program,
    pub keys_file: &'a Path,
    pub built_from_sources: &'a str,
    pub encoded_input: &'a [u8],
    pub native_public_values: &'a [u8],
    pub block_number: u64,
    pub proof_out: Option<&'a Path>,
}

/// Итог для отчёта хоста.
pub struct Outcome {
    pub prover: String,
    pub vkey: String,
    pub setup_seconds: f64,
    pub proof_seconds: f64,
}

/// Файл пруфа Groth16 — тот же формат, что пишет zkvm/script: его читает zk/import-sp1-fixture.mjs.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofFixture {
    subject: String,
    vkey: String,
    public_values: String,
    proof: String,
    sources_sha256: String,
    elf_sha256: String,
}

fn refuse(message: String) -> ! {
    eprintln!("{message}");
    std::process::exit(2);
}

/// Прувер из окружения: только настоящий.
fn prover_kind(mode: Mode) -> String {
    let prover = std::env::var("SP1_PROVER").unwrap_or_else(|_| "cpu".into());
    let allowed: &[&str] = match mode {
        Mode::WrapGroth16(_) => &["cpu"],
        _ if cfg!(feature = "cuda") => &["cpu", "cuda"],
        _ => &["cpu"],
    };
    if !allowed.contains(&prover.as_str()) {
        let note = match mode {
            Mode::WrapGroth16(_) => "обёртка идёт на процессоре",
            _ => "cuda — только в сборке с --features cuda",
        };
        refuse(format!("Режим {} работает только с SP1_PROVER={} (сейчас «{prover}»; {note}).", mode.name(), allowed.join(" или ")));
    }
    prover
}

/// Карта для `SP1_PROVER=cuda` — из `SP1_CUDA_DEVICE` (номер в порядке CUDA). `CUDA_VISIBLE_DEVICES`
/// здесь не работает: SDK (sp1-cuda 6.10.0, server.rs) сам ставит серверу GPU
/// `CUDA_VISIBLE_DEVICES=<номер>`, по умолчанию 0, и без этой переменной все пруфы идут на карту 0.
#[cfg(feature = "cuda")]
fn cuda_on_device(prover: &str) -> Option<EnvProver> {
    let raw = std::env::var("SP1_CUDA_DEVICE").ok()?;
    if prover != "cuda" {
        refuse(format!("SP1_CUDA_DEVICE задан, а прувер «{prover}»: номер карты — только для SP1_PROVER=cuda."));
    }
    let id: u32 = raw.parse().unwrap_or_else(|_| refuse(format!("SP1_CUDA_DEVICE «{raw}»: нужен номер карты")));
    Some(EnvProver::Cuda(ProverClient::builder().cuda().with_device_id(id).build()))
}

#[cfg(not(feature = "cuda"))]
fn cuda_on_device(_prover: &str) -> Option<EnvProver> {
    if std::env::var_os("SP1_CUDA_DEVICE").is_some() {
        refuse("SP1_CUDA_DEVICE — только в сборке с --features cuda.".into());
    }
    None
}

/// Через временный файл: прерванная запись не оставит обрезанного пруфа под настоящим именем.
fn write_atomically(path: &Path, write: impl FnOnce(&Path) -> anyhow::Result<()>) {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = Path::new(&temporary);
    write(temporary).unwrap_or_else(|error| refuse(format!("{} не записан: {error}", path.display())));
    fs::rename(temporary, path).unwrap_or_else(|error| refuse(format!("{} не переименован: {error}", path.display())));
}

fn check_public_values(proof: &SP1ProofWithPublicValues, native: &[u8], what: &str) {
    if proof.public_values.as_slice() != native {
        refuse(format!("{what}: публичные значения пруфа и нативного расчёта разошлись."));
    }
}

fn write_groth16_fixture(job: &Job, vkey: &str, proof: &SP1ProofWithPublicValues) {
    let fixture = ProofFixture {
        subject: format!("EVM batch: block {}", job.block_number),
        vkey: vkey.to_string(),
        public_values: format!("0x{}", crate::program::plain_hex(proof.public_values.as_slice())),
        proof: format!("0x{}", crate::program::plain_hex(&proof.bytes())),
        sources_sha256: job.built_from_sources.to_string(),
        elf_sha256: job.program.sha256.clone(),
    };
    let file = job.proof_out.expect("clap требует --proof-out");
    let text = serde_json::to_string_pretty(&fixture).expect("JSON") + "\n";
    write_atomically(file, |temporary| Ok(fs::write(temporary, text)?));
    println!("Пруф записан: {}", file.display());
}

pub fn run(mode: Mode, job: &Job) -> Outcome {
    let prover = prover_kind(mode);
    let started = Instant::now();
    // --wrap-groth16 — всегда процессор: SDK здесь только выводит ключ и проверяет пруфы.
    let client = match mode {
        Mode::WrapGroth16(_) => EnvProver::Cpu(ProverClient::builder().cpu().build()),
        _ => cuda_on_device(&prover).unwrap_or_else(ProverClient::from_env),
    };
    let pk = client.setup(job.program.elf.clone()).expect("не удалось подготовить ключ программы");
    let vkey = pk.verifying_key().bytes32().to_string();
    // До пруфа: ключ, который выдал САМ прувер (на GPU — сервер sp1-gpu-server), — из program.json.
    assert_matches_program_keys(job.keys_file, job.built_from_sources, job.program, &vkey);
    let setup_seconds = started.elapsed().as_secs_f64();
    println!("Ключ программы: {vkey} (прувер {prover}, подготовка {setup_seconds:.0} с)");

    let started = Instant::now();
    let mut stdin = SP1Stdin::new();
    stdin.write_vec(job.encoded_input.to_vec());
    match mode {
        Mode::Compressed | Mode::ProveCompressed => {
            // Нонс — ноль явно: из сжатого пруфа он переходит в Groth16 (`--wrap-groth16`).
            let proof = client
                .prove(&pk, stdin)
                .compressed()
                .with_proof_nonce(PROOF_NONCE)
                .run()
                .expect("не удалось построить сжатый пруф");
            check_public_values(&proof, job.native_public_values, "сжатый пруф");
            client.verify(&proof, pk.verifying_key(), None).expect("сжатый пруф не прошёл локальную проверку");
            println!("[этап] сжатый пруф построен и проверен за {:.0} с", started.elapsed().as_secs_f64());
            if mode == Mode::ProveCompressed {
                let file = job.proof_out.expect("clap требует --proof-out");
                write_atomically(file, |temporary| proof.save(temporary));
                println!("Сжатый пруф записан: {}", file.display());
            }
        }
        Mode::Groth16 => {
            let proof = client
                .prove(&pk, stdin)
                .groth16()
                .with_proof_nonce(PROOF_NONCE)
                .run()
                .expect("не удалось построить пруф");
            check_public_values(&proof, job.native_public_values, "пруф");
            client.verify(&proof, pk.verifying_key(), None).expect("пруф не прошёл локальную проверку");
            println!("[этап] пруф Groth16 построен и проверен за {:.0} с", started.elapsed().as_secs_f64());
            write_groth16_fixture(job, &vkey, &proof);
        }
        Mode::WrapGroth16(path) => {
            let compressed = SP1ProofWithPublicValues::load(path)
                .unwrap_or_else(|error| refuse(format!("сжатый пруф {} не читается: {error}", path.display())));
            check_public_values(&compressed, job.native_public_values, "сжатый пруф из файла");
            // Сжатый пруф проверяется под ключом ЭТОГО ELF: пруф другой программы дальше не пойдёт.
            client
                .verify(&compressed, pk.verifying_key(), None)
                .unwrap_or_else(|error| refuse(format!("сжатый пруф из файла не прошёл проверку под ключом программы: {error}")));
            println!("Сжатый пруф из файла проверен под ключом программы.");
            let groth16 = crate::wrap::groth16_from_compressed(&compressed.proof)
                .unwrap_or_else(|error| refuse(format!("обёртка Groth16 не удалась: {error:#}")));
            let proof =
                SP1ProofWithPublicValues::new(SP1Proof::Groth16(groth16), compressed.public_values.clone(), compressed.sp1_version.clone());
            // Нонс в сжатом пруфе задал первый шаг; контракт принимает только ноль.
            if proof.bytes().get(68..100).is_none_or(|nonce| nonce.iter().any(|byte| *byte != 0)) {
                refuse("нонс пруфа не ноль: сжатый пруф строился не нашим хостом".into());
            }
            client.verify(&proof, pk.verifying_key(), None).expect("пруф Groth16 не прошёл локальную проверку");
            println!("[этап] обёртка Groth16 построена и проверена за {:.0} с", started.elapsed().as_secs_f64());
            write_groth16_fixture(job, &vkey, &proof);
        }
    }
    let outcome = Outcome { prover, vkey, setup_seconds, proof_seconds: started.elapsed().as_secs_f64() };
    // Ключ программы на GPU (`sp1-cuda`, `SessionKey`) в своём `Drop` зовёт `tokio::spawn`, чтобы
    // закрыть сессию на сервере GPU, а блокирующий клиент SDK рантайма снаружи не держит: без него
    // хост падал (код 134) уже ПОСЛЕ записи пруфа, и успешный пруф выглядел сбоем. Ключ и клиент
    // уничтожаются внутри рантайма; сессию сервер закрывает и сам, когда процесс выходит.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("рантайм tokio для завершения прувера");
    let _context = runtime.enter();
    drop(pk);
    drop(client);
    outcome
}
