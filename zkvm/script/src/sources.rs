//! Хеши исходников: программ zkVM и самого хост-скрипта.
//!
//! Зачем: ключ программы SP1 (programVKey) однозначно определяется ELF, а ELF — исходниками
//! и сборочным окружением. Чтобы пруф и ключ, зашитый в контракт, нельзя было по
//! забывчивости оставить от ПРЕЖНЕЙ версии программы, хеш исходников проходит всю цепочку:
//!   - build.rs зашивает его в бинарник хост-скрипта вместе с ELF;
//!   - режим --vkeys пишет его в fixtures/zkvm_batches/program.json рядом с ключами программ;
//!   - прувер отказывается работать, если исходники на диске уже другие;
//!   - тест (tests/ProgramBinding.spec.ts) пересчитывает тот же хеш на JavaScript.
//!
//! Это защита от забытого шага, а не от подделки: хеш исходников — запись в файле, и тот,
//! кто правит файлы руками, поправит и её. Что ELF действительно собран из этих исходников,
//! показывает только чистая пересборка: zkvm/script/verify-elf.sh.
//!
//! Алгоритм хеша программ (его повторяет zk/program-binding.mjs — менять только вместе):
//!   файлы *.rs, *.toml, *.lock из SOURCE_ROOTS; каталог target непосредственно внутри корня
//!   пропускается; пути относительно zkvm/ через «/», сортировка по байтам пути;
//!   sha256( для каждого файла: путь ‖ 0x00 ‖ длина (u64, big-endian) ‖ содержимое ).
//!
//! Второй хеш — «хоста» (HOST_ROOTS): сценарий (zkvm/native) и сам скрипт. От них ELF не
//! зависит, но зависит то, ЧТО скрипт подаёт на вход программам; готовый бинарник после
//! правки сценария доказал бы прежний сценарий.
//!
//! Файл подключается и из build.rs, и из main.rs.
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub const SOURCE_ROOTS: [&str; 6] = ["Cargo.toml", "Cargo.lock", "lib", "exit-lib", "program", "exit-program"];
/// Исходники хоста: сценарий и скрипт. В хеш программ не входят.
pub const HOST_ROOTS: [&str; 5] =
    ["native", "script/src", "script/build.rs", "script/Cargo.toml", "script/Cargo.lock"];
const SOURCE_EXTENSIONS: [&str; 3] = ["rs", "toml", "lock"];

fn is_source(path: &Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()).is_some_and(|e| SOURCE_EXTENSIONS.contains(&e))
}

fn collect(path: &Path, relative: String, is_root: bool, out: &mut Vec<(String, PathBuf)>) {
    if path.is_dir() {
        let entries = std::fs::read_dir(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        for entry in entries {
            let entry = entry.expect("чтение каталога исходников");
            let name = entry.file_name().into_string().expect("имена исходников — UTF-8");
            // Каталог сборки cargo лежит прямо в корне крейта. Каталог target глубже
            // (например, модуль src/target/) — обычные исходники, их пропускать нельзя.
            if is_root && name == "target" && entry.path().is_dir() {
                continue;
            }
            collect(&entry.path(), format!("{relative}/{name}"), false, out);
        }
    } else if is_source(path) {
        out.push((relative, path.to_path_buf()));
    }
}

fn files_of(zkvm_dir: &Path, roots: &[&str]) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();
    for root in roots {
        let path = zkvm_dir.join(root);
        assert!(path.exists(), "нет {}: хеш исходников считать не из чего", path.display());
        collect(&path, root.to_string(), true, &mut files);
    }
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    files
}

fn hash_of(files: Vec<(String, PathBuf)>) -> String {
    let mut hasher = Sha256::new();
    for (relative, path) in files {
        let content = std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        hasher.update(relative.as_bytes());
        hasher.update([0u8]);
        hasher.update((content.len() as u64).to_be_bytes());
        hasher.update(&content);
    }
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Исходники программ: (путь относительно zkvm/, путь на диске), по порядку хеширования.
pub fn source_files(zkvm_dir: &Path) -> Vec<(String, PathBuf)> {
    files_of(zkvm_dir, &SOURCE_ROOTS)
}

/// Исходники хоста (сценарий и скрипт).
pub fn host_files(zkvm_dir: &Path) -> Vec<(String, PathBuf)> {
    files_of(zkvm_dir, &HOST_ROOTS)
}

/// Хеш исходников программ в шестнадцатеричной записи.
pub fn sources_sha256(zkvm_dir: &Path) -> String {
    hash_of(source_files(zkvm_dir))
}

/// Хеш исходников хоста в шестнадцатеричной записи.
pub fn host_sha256(zkvm_dir: &Path) -> String {
    hash_of(host_files(zkvm_dir))
}
