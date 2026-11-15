//! Хеши исходников программы батча EVM и самого хоста — как `zkvm/script/src/sources.rs` у
//! нынешних программ, с другим набором корней.
//!
//! Ключ программы SP1 определяется её ELF, а ELF — исходниками. Чтобы пруф и ключ контракта
//! нельзя было по забывчивости оставить от прежней версии программы, хеш исходников:
//!   - зашивается в бинарник хоста при сборке (build.rs) вместе с ELF;
//!   - пишется в fixtures/evm_batches/program.json режимом --vkeys;
//!   - сверяется перед пруфом: бинарник отказывается работать, если исходники уже другие;
//!   - пересчитывается на JavaScript (zk/evm-binding.mjs) при выводе ключа контракта и в тестах.
//! Это защита от забытого шага, а не от подделки; что ELF собран из этих исходников,
//! показывает чистая пересборка: zkvm-evm/host/verify-elf.sh.
//!
//! Алгоритм (его повторяет zk/evm-binding.mjs — менять только вместе):
//!   файлы *.rs, *.toml, *.lock из корней; каталог target непосредственно внутри корня
//!   пропускается; пути относительно корня РЕПОЗИТОРИЯ через «/», сортировка по байтам пути;
//!   sha256( для каждого файла: путь ‖ 0x00 ‖ длина (u64, big-endian) ‖ содержимое ).
//!
//! Файл подключается и из build.rs, и из main.rs.
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Всё, из чего собирается гостевая программа: она сама, библиотека батча и копия дерева
/// состояния вместе с манифестами, задающими их зависимости. Библиотека игрушечного реестра
/// (zkvm/lib) в программу больше не входит: она осталась зависимостью тестов.
pub const SOURCE_ROOTS: [&str; 5] = [
    "zkvm-evm/Cargo.toml",
    "zkvm-evm/lib/Cargo.toml",
    "zkvm-evm/lib/src",
    "zkvm-evm/program",
    "zkvm-evm/vendor/rsp-mpt",
];
/// Сам хост: от него ELF не зависит, но зависит то, что подаётся программе на вход.
pub const HOST_ROOTS: [&str; 4] =
    ["zkvm-evm/host/src", "zkvm-evm/host/build.rs", "zkvm-evm/host/Cargo.toml", "zkvm-evm/Cargo.lock"];
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
            // Каталог сборки cargo лежит прямо в корне крейта; target глубже — обычные исходники.
            if is_root && name == "target" && entry.path().is_dir() {
                continue;
            }
            collect(&entry.path(), format!("{relative}/{name}"), false, out);
        }
    } else if is_source(path) {
        out.push((relative, path.to_path_buf()));
    }
}

fn hash_of(repository: &Path, roots: &[&str]) -> String {
    let mut files = Vec::new();
    for root in roots {
        let path = repository.join(root);
        assert!(path.exists(), "нет {}: хеш исходников считать не из чего", path.display());
        collect(&path, root.to_string(), true, &mut files);
    }
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
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

/// Список файлов, от которых зависит пересборка (для cargo:rerun-if-changed).
#[allow(dead_code)] // нужен только build.rs
pub fn watched(repository: &Path) -> Vec<PathBuf> {
    // У гостевой программы следим за исходниками и манифестами, а не за каталогом целиком:
    // в нём лежит её target, куда пишет сама сборка, — иначе хост перелинковывался бы каждый раз.
    SOURCE_ROOTS
        .iter()
        .chain(HOST_ROOTS.iter())
        .flat_map(|root| match *root {
            "zkvm-evm/program" => vec!["zkvm-evm/program/src", "zkvm-evm/program/Cargo.toml", "zkvm-evm/program/Cargo.lock"],
            other => vec![other],
        })
        .map(|root| repository.join(root))
        .collect()
}

/// Хеш исходников программы в шестнадцатеричной записи.
pub fn sources_sha256(repository: &Path) -> String {
    hash_of(repository, &SOURCE_ROOTS)
}

/// Хеш исходников хоста в шестнадцатеричной записи.
pub fn host_sha256(repository: &Path) -> String {
    hash_of(repository, &HOST_ROOTS)
}
