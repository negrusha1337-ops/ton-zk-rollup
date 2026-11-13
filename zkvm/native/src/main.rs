//! Нативный запуск программы перехода состояния: без zkVM и без пруфа.
//! Пишет fixtures/zkvm_batches/batches.json и fixtures/zkvm_exit/claims.json — по ним тесты
//! сверяют публичные значения программ с тем, что ожидает rollup-контракт.
//!
//!   cargo run -p rollup-native            (из каталога zkvm/)
use std::{fs, path::PathBuf};

use rollup_native::fixtures;

fn main() {
    let built = fixtures::build();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    for (directory, file, value) in
        [("zkvm_batches", "batches.json", &built.batches), ("zkvm_exit", "claims.json", &built.exits)]
    {
        let dir = root.join(directory);
        fs::create_dir_all(&dir).expect("не удалось создать каталог фикстур");
        fs::write(dir.join(file), fixtures::render(value)).expect("не удалось записать фикстуру");
        println!("Записано: fixtures/{directory}/{file}");
    }
    for (index, digest) in built.batch_digests.iter().enumerate() {
        println!("Дайджест батча {}: {digest}", index + 1);
    }
}
