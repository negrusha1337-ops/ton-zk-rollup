use std::path::Path;

use sp1_build::{build_program_with_args, BuildArgs};

/// Метка вместо признака настоящей сборки: бинарник с ней откажется работать.
const NOT_BUILT: &str = "гостевая-программа-не-собиралась";

fn main() {
    println!("cargo:rerun-if-env-changed=SP1_SKIP_PROGRAM_BUILD");
    println!("cargo:rerun-if-env-changed=RUSTC_WORKSPACE_WRAPPER");
    // Копия дерева состояния подключена через [patch]: sp1-build её изменений не видит, и после
    // правки одного vendor/rsp-mpt в бинарнике остался бы прежний ELF.
    println!("cargo:rerun-if-changed=../vendor/rsp-mpt/src");
    println!("cargo:rerun-if-changed=../vendor/rsp-mpt/Cargo.toml");
    // С этой переменной sp1-build не собирает гостевую программу, а берёт ELF прежней сборки:
    // хост исполнял бы не тот код, что лежит в исходниках (то же правило, что в zkvm/script).
    if std::env::var("SP1_SKIP_PROGRAM_BUILD").is_ok_and(|value| value.eq_ignore_ascii_case("true")) {
        panic!("SP1_SKIP_PROGRAM_BUILD отключает сборку гостевой программы. Уберите переменную.");
    }
    // Под clippy (rust-analyzer) sp1-build гостя тоже не собирает и отдаёт путь к прежнему ELF.
    // Сборку не ломаем — её результат не запускают, — но бинарник помечаем негодным.
    let guest_skipped =
        std::env::var("RUSTC_WORKSPACE_WRAPPER").is_ok_and(|value| value.contains("clippy-driver"));
    println!(
        "cargo:rustc-env=ROLLUP_EVM_GUEST_BUILD={}",
        if guest_skipped { NOT_BUILT } else { "собрана" }
    );

    // `locked` — сборка строго по zkvm-evm/program/Cargo.lock. `--remap-path-prefix` убирает из
    // ELF пути этой машины (места паник): каталог cargo и корень репозитория — исходники
    // zkvm-evm/lib и zkvm/lib лежат вне рабочего пространства гостя и попадают в ELF полным путём.
    let cargo_home = std::env::var("CARGO_HOME").expect("cargo задаёт CARGO_HOME сборочным скриптам");
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("корень репозитория существует");
    build_program_with_args(
        "../program",
        BuildArgs {
            locked: true,
            rustflags: vec![
                format!("--remap-path-prefix={cargo_home}=/cargo-home"),
                format!("--remap-path-prefix={}=/ton-zk-rollup", repository.display()),
            ],
            ..Default::default()
        },
    );
}
