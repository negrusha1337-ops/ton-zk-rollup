//! Какой ELF программы идёт в zkVM и как он сверяется с fixtures/evm_batches/program.json.
//!
//! Обычно — ELF, вшитый в хост при сборке (`include_elf!`, его собирает build.rs). С `--elf` —
//! ELF из файла: на арендованном сервере программу НЕ пересобирают (сборка побайтно не
//! воспроизводима, другой ELF — другой ключ программы, и пруф не подошёл бы ключу контракта),
//! а везут ELF, собранный там, где считался program.json.
//!
//! Файловый ELF принимается только целиком сверенным: sha256 — с `programElfSha256`, ключ,
//! который SDK выводит из него, — с `programVKey`. Сверка идёт до любой работы с входом. Записать
//! program.json из файлового ELF нельзя (`--vkeys` с `--elf` не сочетается): program.json
//! описывает только сборку из исходников.
use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sp1_sdk::{
    blocking::{Prover, ProverClient},
    Elf, HashableKey, ProvingKey,
};

/// Ключ программы и то, из чего он получен. Пишется режимом --vkeys.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramKeys {
    pub source: String,
    pub note: String,
    pub sp1_version: String,
    pub guest_rustc: String,
    pub cargo: String,
    /// Хеш исходников программы: host/src/sources.rs, повтор — zk/evm-binding.mjs.
    pub sources_sha256: String,
    #[serde(rename = "programVKey")]
    pub program_vkey: String,
    pub program_elf_sha256: String,
}

/// ELF, который пойдёт в zkVM, и откуда он.
pub struct Program {
    pub elf: Elf,
    pub sha256: String,
    /// Путь к файлу, если ELF не вшитый.
    pub file: Option<String>,
}

pub fn plain_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    plain_hex(&Sha256::digest(bytes))
}

fn refuse(message: String) -> ! {
    eprintln!("{message}");
    std::process::exit(2);
}

pub fn read_program_keys(file: &Path) -> ProgramKeys {
    let text = fs::read_to_string(file)
        .unwrap_or_else(|error| refuse(format!("нет {} ({error}): сначала --vkeys", file.display())));
    serde_json::from_str(&text).unwrap_or_else(|error| refuse(format!("{} не разобран: {error}", file.display())))
}

impl Program {
    pub fn embedded(elf: Elf) -> Self {
        let sha256 = sha256_hex(&elf);
        Self { elf, sha256, file: None }
    }

    /// ELF из файла — только если его sha256 записан в program.json. Ключ сверяется отдельно
    /// (`assert_vkey_from_file`): для него нужен прувер SDK.
    pub fn from_file(path: &Path, keys_file: &Path) -> Self {
        let bytes = fs::read(path).unwrap_or_else(|error| refuse(format!("ELF {} не читается: {error}", path.display())));
        let sha256 = sha256_hex(&bytes);
        let recorded = read_program_keys(keys_file).program_elf_sha256;
        if sha256 != recorded {
            refuse(format!(
                "ELF {} — не тот, для которого выведен ключ контракта.\n  sha256 файла:      {sha256}\n  в program.json:    {recorded}\n\
                 Везите ELF той сборки, что записана в program.json; на этой машине программу не пересобирать.",
                path.display()
            ));
        }
        println!("ELF из файла {}: sha256 совпал с program.json ({sha256})", path.display());
        Self { elf: Elf::from(bytes), sha256, file: Some(path.display().to_string()) }
    }
}

/// Ключ файлового ELF, выведенный SDK на процессоре, обязан совпасть с program.json — до входа
/// и прувера. (Прувер на GPU выводит ключ ещё раз сам; его сверяет `assert_matches_program_keys`.)
pub fn assert_vkey_from_file(program: &Program, keys_file: &Path) {
    if program.file.is_none() {
        return;
    }
    let started = std::time::Instant::now();
    let client = ProverClient::builder().cpu().build();
    let vkey = client
        .setup(program.elf.clone())
        .unwrap_or_else(|error| refuse(format!("ключ программы из ELF не выведен: {error}")))
        .verifying_key()
        .bytes32()
        .to_string();
    let recorded = read_program_keys(keys_file).program_vkey;
    if vkey != recorded {
        refuse(format!("Ключ программы из ELF {vkey} не совпал с program.json ({recorded})."));
    }
    println!("Ключ программы из ELF совпал с program.json: {vkey} ({:.0} с)", started.elapsed().as_secs_f64());
}

/// program.json обязан описывать и эту сборку хоста (исходники), и ELF, и ключ, с которым
/// прувер сейчас работает: иначе ключ контракта выведен для другой программы.
pub fn assert_matches_program_keys(keys_file: &Path, built_from_sources: &str, program: &Program, vkey: &str) {
    let recorded = read_program_keys(keys_file);
    for (name, recorded, actual) in [
        ("sourcesSha256", recorded.sources_sha256, built_from_sources.to_string()),
        ("programElfSha256", recorded.program_elf_sha256, program.sha256.clone()),
        ("programVKey", recorded.program_vkey, vkey.to_string()),
    ] {
        if recorded != actual {
            refuse(format!(
                "program.json не соответствует этой сборке: {name}\n  в файле:  {recorded}\n  в сборке: {actual}\n\
                 Запустите rollup-evm-host --vkeys и выведите ключ контракта заново."
            ));
        }
    }
}
