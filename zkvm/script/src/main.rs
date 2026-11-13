//! Исполнение и доказательство программ rollup'а в SP1.
//!
//!   cargo run --release -- --batch 1 --execute     # исполнить в zkVM, без пруфа
//!   cargo run --release -- --load --transfers 1000 --execute   # нагрузочный батч: цена данных в циклах
//!   cargo run --release -- --batch 1 --compressed  # сжатый STARK-пруф: проверка, что машина тянет доказательство
//!   cargo run --release -- --batch 1 --prove       # Groth16-пруф для отправки в TON
//!   cargo run --release -- --exit alice --prove    # пруф аварийного выхода счёта из сценария
//!   cargo run --release -- --vkeys                 # ключи обеих программ → fixtures/zkvm_batches/program.json
//!
//! В режиме --prove пишет фикстуру с полями vkey, publicValues и proof — в том же виде,
//! что фикстура шаблона Succinct, чтобы её можно было импортировать скриптом
//! zk/import-sp1-fixture.mjs: fixtures/zkvm_batches/proof-batch<N>.json для батча,
//! fixtures/zkvm_exit/proof-<имя>.json для выхода.
//!
//! Привязка пруфов к исходникам (src/sources.rs). Порядок после любого изменения программ:
//!   1) собрать скрипт; 2) --vkeys — записать ключи программ и хеш исходников в program.json;
//!   3) --prove. Прувер отказывается работать, если бинарник собран из других исходников,
//!   чем лежат на диске, или если ключ программы не совпал с program.json. Так пруф от
//!   прежней версии программы нельзя ни построить по ошибке, ни выдать за нынешний.
//!
//! Сборке нужен protoc (переменная PROTOC), режиму --prove — Docker либо Go
//! (feature native-gnark) и ~6 ГБ артефактов схемы. Подробности — PROVING.md.
use std::path::{Path, PathBuf};

use clap::Parser;
use rollup_exit::prove_exit;
use rollup_native::{Scenario, EXIT_NAMES};
use rollup_stf::{apply_batch, Account, BatchInput, WithdrawalLeaf};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{ProveRequest, Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};

mod sources;

const ROLLUP_ELF: Elf = include_elf!("rollup-program");
const EXIT_ELF: Elf = include_elf!("rollup-exit-program");

/// Нонс пруфа, отправляемого в TON (см. комментарий у вызова `with_proof_nonce`).
const PROOF_NONCE: [u32; 4] = [0; 4];
/// Хеш исходников программ на момент сборки этого бинарника (build.rs).
const BUILT_FROM_SOURCES: &str = env!("ROLLUP_SOURCES_SHA256");
/// Хеш исходников хоста (сценарий zkvm/native и сам скрипт) на момент сборки.
const BUILT_FROM_HOST: &str = env!("ROLLUP_HOST_SHA256");
/// Версия sp1-sdk, с которой собран скрипт: из script/Cargo.lock (build.rs), не от руки.
const SP1_VERSION: &str = env!("ROLLUP_SP1_SDK");
const GUEST_RUSTC: &str = env!("ROLLUP_GUEST_RUSTC");
const HOST_CARGO: &str = env!("ROLLUP_CARGO");

#[derive(Parser, Debug)]
struct Args {
    /// Номер батча сценария: 1, 2 или 3.
    #[arg(long)]
    batch: Option<u8>,
    /// Нагрузочный батч для замеров циклов (только --execute); в контракт не отправляется.
    #[arg(long)]
    load: bool,
    /// Аварийный выход счёта сценария (alice или bob) из состояния после батча 3.
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
    /// Посчитать ключи обеих программ и записать fixtures/zkvm_batches/program.json.
    #[arg(long)]
    vkeys: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofFixture {
    subject: String,
    vkey: String,
    public_values: String,
    proof: String,
    /// Из каких исходников и какого ELF получен пруф (см. src/sources.rs).
    sources_sha256: String,
    elf_sha256: String,
}

/// Ключи программ и то, из чего они получены. Пишется режимом --vkeys.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgramKeys {
    source: &'static str,
    note: &'static str,
    sp1_version: &'static str,
    /// Компилятор гостевых программ и cargo, которыми собраны ELF: от них ELF тоже зависит.
    guest_rustc: &'static str,
    cargo: &'static str,
    /// Хеш исходников программ: zkvm/script/src/sources.rs, повтор — zk/program-binding.mjs.
    sources_sha256: String,
    #[serde(rename = "programVKey")]
    program_vkey: String,
    #[serde(rename = "exitProgramVKey")]
    exit_program_vkey: String,
    program_elf_sha256: String,
    exit_program_elf_sha256: String,
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

fn program_keys_file() -> PathBuf {
    fixtures_dir().join("zkvm_batches/program.json")
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Бинарник обязан быть собран из тех исходников программ, что лежат на диске: иначе ELF
/// внутри него — от прежней версии, и пруф докажет не ту программу.
fn assert_binary_is_fresh() {
    let zkvm_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let on_disk = sources::sources_sha256(&zkvm_dir);
    if on_disk != BUILT_FROM_SOURCES {
        eprintln!(
            "Исходники программ изменились после сборки этого бинарника.\n  собран из: {BUILT_FROM_SOURCES}\n  на диске:  {on_disk}\nПересоберите скрипт (cargo build --release) и повторите --vkeys."
        );
        std::process::exit(2);
    }
    // Сценарий и сам скрипт: от них ELF не зависит, но зависит вход программ. Готовый бинарник
    // после правки сценария доказал бы ПРЕЖНИЙ сценарий — на это ушло бы четверть часа.
    let host_on_disk = sources::host_sha256(&zkvm_dir);
    if host_on_disk != BUILT_FROM_HOST {
        eprintln!(
            "Сценарий (zkvm/native) или сам скрипт изменились после сборки этого бинарника.\n  собран из: {BUILT_FROM_HOST}\n  на диске:  {host_on_disk}\nПересоберите скрипт (cargo build --release)."
        );
        std::process::exit(2);
    }
}

/// Режим --vkeys: ключи обеих программ, хеши их ELF и хеш исходников → program.json.
fn write_program_keys(client: &impl Prover) {
    let vkey = |elf: Elf| {
        client.setup(elf).expect("не удалось подготовить ключ программы").verifying_key().bytes32().to_string()
    };
    let keys = ProgramKeys {
        source: "Сгенерировано zkvm/script (--vkeys); не редактировать вручную",
        note: "Ключ программы — первый публичный вход верификатора SP1; зависит от точного ELF, то есть от исходников (sourcesSha256), версии SP1, компилятора и зависимостей. Сборка не побайтно воспроизводима: на другой машине ELF и ключ могут отличаться — см. PROVING.md",
        sp1_version: SP1_VERSION,
        guest_rustc: GUEST_RUSTC,
        cargo: HOST_CARGO,
        sources_sha256: BUILT_FROM_SOURCES.to_string(),
        program_vkey: vkey(ROLLUP_ELF),
        exit_program_vkey: vkey(EXIT_ELF),
        program_elf_sha256: sha256_hex(&ROLLUP_ELF),
        exit_program_elf_sha256: sha256_hex(&EXIT_ELF),
    };
    std::fs::write(program_keys_file(), serde_json::to_string_pretty(&keys).expect("JSON") + "\n")
        .expect("не удалось записать program.json");
    println!("Ключ программы батчей: {}", keys.program_vkey);
    println!("Ключ программы выхода: {}", keys.exit_program_vkey);
    println!("Хеш исходников:        {}", keys.sources_sha256);
    println!("Записано: fixtures/zkvm_batches/program.json");
}

/// Перед доказательством: program.json обязан описывать именно эту сборку. Сверяются хеш
/// исходников, хеш ELF и ключ программы — пруф под ключ, которого нет в program.json,
/// контракт всё равно не примет, а мак занят на четверть часа.
fn assert_matches_program_keys(job: &Job, vkey: &str) {
    let file = program_keys_file();
    let recorded: serde_json::Value = std::fs::read_to_string(&file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| panic!("нет или не читается {}: сначала --vkeys", file.display()));
    let field = |name: &str| recorded[name].as_str().unwrap_or_default().to_string();
    let (vkey_field, elf_field) = match job.program {
        Program::Batch => ("programVKey", "programElfSha256"),
        Program::Exit => ("exitProgramVKey", "exitProgramElfSha256"),
    };
    let checks = [
        ("sourcesSha256", field("sourcesSha256"), BUILT_FROM_SOURCES.to_string()),
        (elf_field, field(elf_field), sha256_hex(&job.elf)),
        (vkey_field, field(vkey_field), vkey.to_string()),
    ];
    for (name, recorded, actual) in checks {
        if recorded != actual {
            eprintln!(
                "program.json не соответствует этой сборке: {name}\n  в файле:  {recorded}\n  в сборке: {actual}\nЗапустите --vkeys и проверьте изменения перед доказательством."
            );
            std::process::exit(2);
        }
    }
}

#[derive(Clone, Copy)]
enum Program {
    Batch,
    Exit,
}

/// Публичные значения, которые закоммиченные фикстуры сценария обещают для этого задания
/// (hex): для батча — из batches.json, для выхода — из claims.json. `None` — задания в
/// фикстурах нет (нагрузочный батч).
fn committed_public_values(job: &Job) -> Option<String> {
    let read = |file: &str| -> serde_json::Value {
        let path = fixtures_dir().join(file);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    };
    match &job.scenario {
        ScenarioRef::Batch(number) => read("zkvm_batches/batches.json")["batches"]
            .get(usize::from(*number) - 1)
            .and_then(|batch| batch["publicValuesHex"].as_str().map(str::to_string)),
        ScenarioRef::Exit(name) => read("zkvm_exit/claims.json")["claims"]
            .as_array()
            .and_then(|claims| claims.iter().find(|claim| claim["name"] == name.as_str()))
            .and_then(|claim| claim["publicValuesHex"].as_str().map(str::to_string)),
        ScenarioRef::Load => None,
    }
}

/// Перед доказательством: то, что программа выдаст, обязано совпасть с тем, под что написаны
/// тесты и скрипт testnet (фикстуры сценария). Иначе расхождение всплыло бы только при
/// импорте пруфа — через четверть часа работы прувера.
fn assert_matches_scenario_fixtures(job: &Job) {
    let expected = hex::encode(&job.expected);
    match committed_public_values(job) {
        Some(committed) if committed == expected => {}
        Some(_) => {
            eprintln!(
                "{}: публичные значения не те, что в фикстурах сценария. Запустите cargo run -p rollup-native и пересоберите скрипт.",
                job.subject
            );
            std::process::exit(2);
        }
        None => {
            eprintln!("{}: в фикстурах сценария такого задания нет — доказывать его незачем.", job.subject);
            std::process::exit(2);
        }
    }
}

/// К чему в фикстурах сценария относится задание.
enum ScenarioRef {
    Batch(u8),
    Exit(String),
    Load,
}

/// Одно задание пруверу: программа, её вход и то, что она обязана выдать.
struct Job {
    /// Что доказываем — для сообщений и для фикстуры.
    subject: String,
    scenario: ScenarioRef,
    program: Program,
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

/// Батч сценария по номеру; `None` — нагрузочный батч из `transfers` переводов.
fn batch_job(batch: Option<u8>, transfers: usize) -> Job {
    let scenario = Scenario::new();
    let after_batch2 = || {
        let (_, accounts, withdrawals) = state_after_batch2(&scenario);
        (accounts, withdrawals)
    };
    let input = match batch {
        Some(1) => scenario.batch1(),
        Some(2) => state_after_batch2(&scenario).0,
        Some(3) => {
            let (accounts, withdrawals) = after_batch2();
            scenario.batch3(accounts, withdrawals)
        }
        Some(other) => panic!("в сценарии нет батча {other}: допустимы 1, 2 и 3"),
        None => {
            let (accounts, withdrawals) = after_batch2();
            scenario.load_batch(accounts, withdrawals, transfers)
        }
    };
    let name = batch.map_or("load".to_string(), |number| number.to_string());
    let (expected, _, _) = apply_batch(&input).expect("батч сценария некорректен");
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);
    Job {
        subject: format!("батч {name}"),
        scenario: batch.map_or(ScenarioRef::Load, ScenarioRef::Batch),
        program: Program::Batch,
        elf: ROLLUP_ELF,
        stdin,
        expected: expected.to_bytes().to_vec(),
        fixture: PathBuf::from("zkvm_batches").join(format!("proof-batch{name}.json")),
        data: Some((input.data_chunks.iter().map(Vec::len).sum(), input.data_chunks.len())),
    }
}

fn exit_job(name: &str) -> Job {
    if !EXIT_NAMES.contains(&name) {
        panic!("в сценарии нет счёта {name}: допустимы {EXIT_NAMES:?}");
    }
    let scenario = Scenario::new();
    // Rollup замораживается после батча 3: выход — из состояния после него.
    let (_, accounts, withdrawals) = state_after_batch2(&scenario);
    let (_, accounts, _) = apply_batch(&scenario.batch3(accounts, withdrawals)).expect("батч 3 сценария некорректен");
    let input = scenario.exit_input(name, accounts);
    let expected = prove_exit(&input).expect("заявка на выход некорректна");
    let mut stdin = SP1Stdin::new();
    stdin.write(&input);
    Job {
        subject: format!("выход {name}"),
        scenario: ScenarioRef::Exit(name.to_string()),
        program: Program::Exit,
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
    if [args.execute, args.compressed, args.prove, args.vkeys].iter().filter(|&&mode| mode).count() != 1 {
        eprintln!("Укажите ровно один режим: --execute, --compressed, --prove или --vkeys");
        std::process::exit(1);
    }
    // Любой режим имеет смысл только для нынешних исходников программ.
    assert_binary_is_fresh();
    if args.vkeys {
        write_program_keys(&ProverClient::from_env());
        return;
    }
    let job = match (args.batch, args.exit.as_deref(), args.load) {
        (None, None, true) if !args.execute => {
            eprintln!("Нагрузочный батч — только для замеров: допустим один режим --execute");
            std::process::exit(1);
        }
        (None, None, true) => batch_job(None, args.transfers),
        (Some(batch), None, false) => batch_job(Some(batch), args.transfers),
        (None, Some(name), false) => exit_job(name),
        _ => {
            eprintln!("Укажите ровно одно: --batch <номер>, --exit <имя счёта> или --load");
            std::process::exit(1);
        }
    };

    let client = ProverClient::from_env();
    if args.execute {
        execute(&client, job);
        return;
    }

    let pk = client.setup(job.elf.clone()).expect("не удалось подготовить ключ программы");
    let vkey = pk.verifying_key().bytes32().to_string();
    println!("Ключ программы: {vkey}");
    if args.prove {
        assert_matches_program_keys(&job, &vkey);
        assert_matches_scenario_fixtures(&job);
    }

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
        vkey,
        public_values: format!("0x{}", hex::encode(proof.public_values.as_slice())),
        proof: format!("0x{}", hex::encode(proof.bytes())),
        sources_sha256: BUILT_FROM_SOURCES.to_string(),
        elf_sha256: sha256_hex(&job.elf),
    };
    let file = fixtures_dir().join(&job.fixture);
    std::fs::create_dir_all(file.parent().expect("у пути фикстуры есть каталог"))
        .expect("не удалось создать каталог фикстур");
    std::fs::write(&file, serde_json::to_string_pretty(&fixture).expect("JSON") + "\n")
        .expect("не удалось записать фикстуру");
    println!("Пруф записан: fixtures/{}", job.fixture.display());
}
