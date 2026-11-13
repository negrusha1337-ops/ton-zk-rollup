use std::path::Path;
use std::process::Command;

use sp1_build::{build_program_with_args, BuildArgs};

#[path = "src/sources.rs"]
mod sources;

/// Переменные окружения, при которых sp1-build НЕ собирает гостевые программы, а берёт
/// ELF, оставшийся от прежней сборки (sp1-build/src/build.rs): SP1_SKIP_PROGRAM_BUILD=true
/// и RUSTC_WORKSPACE_WRAPPER с clippy-driver. С ними бинарник получил бы хеш НЫНЕШНИХ
/// исходников и ELF ПРЕЖНЕЙ программы — и вся цепочка привязки сошлась бы на ключе старой
/// программы (находка третьего круга проверки, REVIEW.md).
const SKIP_BUILD_VARIABLES: [&str; 2] = ["SP1_SKIP_PROGRAM_BUILD", "RUSTC_WORKSPACE_WRAPPER"];
/// Метка вместо хеша исходников в сборке, где гости не собирались: бинарник с ней
/// откажется работать в любом режиме.
const NOT_BUILT: &str = "гостевые-программы-не-собирались";

fn tool_version(program: &str, args: &[&str]) -> String {
    Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "неизвестно".to_string())
}

/// Версия пакета из Cargo.lock самого скрипта.
fn locked_version(package: &str) -> String {
    let lock = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock"))
        .expect("у скрипта есть Cargo.lock");
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
    for variable in SKIP_BUILD_VARIABLES {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    if std::env::var("SP1_SKIP_PROGRAM_BUILD").is_ok_and(|value| value.eq_ignore_ascii_case("true")) {
        panic!(
            "SP1_SKIP_PROGRAM_BUILD отключает сборку гостевых программ: бинарник получил бы прежний ELF \
             под видом нынешнего. Уберите переменную и соберите заново."
        );
    }
    // Под clippy (rust-analyzer) гости тоже не собираются. Сборку не ломаем — её результат
    // не запускают, — но и хеш исходников такой сборке не выдаём.
    let guests_skipped = std::env::var("RUSTC_WORKSPACE_WRAPPER").is_ok_and(|value| value.contains("clippy-driver"));

    let zkvm_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    // Хеш исходников — ДО сборки и ещё раз ПОСЛЕ: если файл изменился, пока собирались
    // гости, в бинарнике оказался бы хеш новых исходников и ELF старых.
    let sources_before = sources::sources_sha256(&zkvm_dir);

    // Две гостевые программы: батчи и аварийный выход. `locked` — сборка строго по
    // zkvm/Cargo.lock: без него cargo может молча взять другие версии зависимостей, а с
    // ними другой ELF и другой ключ программы. Побайтно воспроизводимой между машинами
    // сборку это не делает (для этого у SP1 есть сборка в Docker, здесь он недоступен) —
    // см. PROVING.md.
    //
    // `--remap-path-prefix`: в ELF попадают пути исходников зависимостей (сообщения паник), а
    // они лежат в домашнем каталоге. Без подмены ключ программы зависел бы от имени
    // пользователя, и посторонний не смог бы его воспроизвести. Тот же флаг обязан стоять в
    // verify-elf.sh.
    let cargo_home = std::env::var("CARGO_HOME").expect("cargo задаёт CARGO_HOME сборочным скриптам");
    let args = || BuildArgs {
        locked: true,
        rustflags: vec![format!("--remap-path-prefix={cargo_home}=/cargo-home")],
        ..Default::default()
    };
    build_program_with_args("../program", args());
    build_program_with_args("../exit-program", args());

    let sources_after = sources::sources_sha256(&zkvm_dir);
    if sources_before != sources_after {
        panic!("Исходники программ изменились во время сборки: соберите заново.");
    }

    // Пересборка при изменении любого исходника программ или хоста.
    for root in sources::SOURCE_ROOTS.iter().chain(sources::HOST_ROOTS.iter()) {
        println!("cargo:rerun-if-changed={}", zkvm_dir.join(root).display());
    }
    for (_, path) in sources::source_files(&zkvm_dir).into_iter().chain(sources::host_files(&zkvm_dir)) {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    // Хеши исходников, из которых собран бинарник: по ним прувер узнаёт, что исходники с тех
    // пор изменились (src/sources.rs). И версии инструментов — они тоже определяют ELF.
    let sources_after = if guests_skipped { NOT_BUILT.to_string() } else { sources_after };
    println!("cargo:rustc-env=ROLLUP_SOURCES_SHA256={sources_after}");
    println!("cargo:rustc-env=ROLLUP_HOST_SHA256={}", sources::host_sha256(&zkvm_dir));
    println!("cargo:rustc-env=ROLLUP_SP1_SDK={}", locked_version("sp1-sdk"));
    println!("cargo:rustc-env=ROLLUP_GUEST_RUSTC={}", tool_version("rustc", &["+succinct", "--version"]));
    println!("cargo:rustc-env=ROLLUP_CARGO={}", tool_version("cargo", &["--version"]));
}
