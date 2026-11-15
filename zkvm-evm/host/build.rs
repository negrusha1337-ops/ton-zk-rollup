use std::path::Path;
use std::process::Command;

use sp1_build::{build_program_with_args, BuildArgs};

#[path = "src/sources.rs"]
mod sources;

/// Метка вместо хеша исходников в сборке, где гостевая программа не собиралась: бинарник с
/// ней откажется работать в любом режиме.
const NOT_BUILT: &str = "гостевая-программа-не-собиралась";

fn tool_version(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "неизвестно".to_string())
}

/// Версия пакета из Cargo.lock рабочего пространства.
fn locked_version(repository: &Path, package: &str) -> String {
    let lock = std::fs::read_to_string(repository.join("zkvm-evm/Cargo.lock")).expect("у хоста есть Cargo.lock");
    let header = format!("name = \"{package}\"");
    let mut lines = lock.lines();
    while let Some(line) = lines.next() {
        if line == header {
            let version = lines.next().and_then(|next| next.strip_prefix("version = \""));
            return version.and_then(|v| v.strip_suffix('"')).expect("за именем пакета идёт версия").to_string();
        }
    }
    panic!("в Cargo.lock нет пакета {package}");
}

fn main() {
    println!("cargo:rerun-if-env-changed=SP1_SKIP_PROGRAM_BUILD");
    println!("cargo:rerun-if-env-changed=RUSTC_WORKSPACE_WRAPPER");
    // С этой переменной sp1-build не собирает гостевую программу, а берёт ELF прежней сборки:
    // хост исполнял бы не тот код, что лежит в исходниках (то же правило, что в zkvm/script).
    if std::env::var("SP1_SKIP_PROGRAM_BUILD").is_ok_and(|value| value.eq_ignore_ascii_case("true")) {
        panic!("SP1_SKIP_PROGRAM_BUILD отключает сборку гостевой программы. Уберите переменную.");
    }
    // Под clippy (rust-analyzer) sp1-build гостя тоже не собирает и отдаёт путь к прежнему ELF.
    // Сборку не ломаем — её результат не запускают, — но хеш исходников такой сборке не выдаём.
    let guest_skipped =
        std::env::var("RUSTC_WORKSPACE_WRAPPER").is_ok_and(|value| value.contains("clippy-driver"));

    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("корень репозитория существует");
    // Хеш исходников — ДО сборки и ещё раз ПОСЛЕ: если файл изменился, пока собиралась
    // программа, в бинарнике оказался бы хеш новых исходников и ELF старых.
    let sources_before = sources::sources_sha256(&repository);

    // `locked` — сборка строго по zkvm-evm/program/Cargo.lock. `--remap-path-prefix` убирает из
    // ELF пути этой машины (места паник): каталог cargo и корень репозитория — исходники
    // zkvm-evm/lib и копия rsp-mpt лежат вне рабочего пространства гостя и попадают в ELF полным
    // путём. Те же флаги обязаны стоять в verify-elf.sh.
    let cargo_home = std::env::var("CARGO_HOME").expect("cargo задаёт CARGO_HOME сборочным скриптам");
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

    let sources_after = sources::sources_sha256(&repository);
    if sources_before != sources_after {
        panic!("Исходники программы изменились во время сборки: соберите заново.");
    }
    // sp1-build следит только за path-зависимостями гостя; копия дерева состояния подключена
    // через [patch], а хеши в бинарнике зависят от всех корней — следим за ними сами.
    for path in sources::watched(&repository) {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    let sources_hash = if guest_skipped { NOT_BUILT.to_string() } else { sources_after };
    println!("cargo:rustc-env=ROLLUP_EVM_SOURCES_SHA256={sources_hash}");
    println!("cargo:rustc-env=ROLLUP_EVM_HOST_SHA256={}", sources::host_sha256(&repository));
    println!("cargo:rustc-env=ROLLUP_EVM_SP1_SDK={}", locked_version(&repository, "sp1-sdk"));
    println!("cargo:rustc-env=ROLLUP_EVM_GUEST_RUSTC={}", tool_version("rustc", &["+succinct", "--version"]));
    println!("cargo:rustc-env=ROLLUP_EVM_CARGO={}", tool_version("cargo", &["--version"]));
}
