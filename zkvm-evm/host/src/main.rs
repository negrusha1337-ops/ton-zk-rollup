//! Хост батча EVM.
//!
//!   rollup-evm-host --vkeys                                  # ключ программы → fixtures/evm_batches/program.json
//!   rollup-evm-host --block-input <кэш RSP>/input/<chainId>/<N>.bin --chain-id <chainId> \
//!       [--witness witness.json] [--previous-report block-(N-1).json] [--execute]
//!       [--write-input batch.bin] [--report report.json]
//!   rollup-evm-host --batch-input batch.bin --execute         # готовый вход батча (фикстура)
//!   rollup-evm-host --batch-input batch.bin --prove --proof-out proof.json
//!   rollup-evm-host --elf program.elf --batch-input batch.bin --prove-compressed --proof-out compressed.bin
//!   rollup-evm-host --elf program.elf --batch-input batch.bin --wrap-groth16 compressed.bin --proof-out proof.json
//!   rollup-evm-host --classify-forced items.json --chain-id <chainId> --report verdicts.json
//!   rollup-evm-host --identity                               # хеши ELF и исходников этой сборки (JSON)
//!
//! `--identity` — чем собран этот бинарник: хеш ELF программы, хеши исходников программы и хоста
//! на момент сборки и на диске сейчас. Сборщик блоков сверяет их с fixtures/evm_batches/program.json
//! при старте: устаревший хост — остановка до пересборки.
//!
//! `--classify-forced` — только проверка ФОРМЫ принудительных транзакций той же функцией, что в
//! программе (`decode_forced_transaction`): файл — JSON-массив байтов элементов очереди (hex),
//! ответ — по элементу: годна по форме (и чей это вызов) либо причина пропуска. Состояние здесь
//! не читается: что revm отвергнет на состоянии, решает исполнение блока. Нужно сборщику блоков
//! (`sequencer/`): мусор и негодные подписи отсеиваются до запроса к узлу.
//!
//! Вход блока готовит штатный `rsp --cache-dir` (он берёт у узла EVM блок и свидетель состояния).
//! Хост добавляет свидетель rollup'а (отрезок очереди L1 с принудительными транзакциями, фронтир
//! и счётчик дерева выводов, порции данных), дополняет свидетель состояния доказательствами
//! счетов отправителей принудительных транзакций (`eth_getProof` на родителе — их кладёт в файл
//! свидетеля тот, кто ходит в узел), считает публичные значения нативно и, с `--execute`,
//! исполняет гостевую программу в zkVM БЕЗ пруфа и сверяет её публичные значения с нативными.
//!
//! Прежняя отметка очереди (`queueProcessedFrom`) программе не нужна и в публичные значения не
//! входит, но по ней батч заявляет контракту `queueProcessedUpTo`. Поэтому хост её не берёт из
//! файла свидетеля на веру: ноль допустим только при нулевом прежнем хеше очереди, а ненулевая
//! отметка — только вместе с отчётом предыдущего батча (`--previous-report`), с которым сверяются
//! отметка, хеш очереди, фронтир и счётчик дерева выводов и хеш родителя.
//!
//! Вход батча (`--write-input`) пишется после всех запрошенных проверок — нативной и, с
//! `--execute`, исполнения в zkVM — через временный файл: фикстуры входа, который zkVM не
//! принял, не появляется.
//!
//! Зачем дополнение. Свидетель узла раскрывает только то, что трогал блок. Принудительную
//! транзакцию, которую программа пропускает (nonce, баланс, отправителя нет), блок не содержит,
//! а счёт её отправителя программа обязана прочитать: без раскрытого пути батч недоказуем.
//!
//! Работа прувера — только по отдельной команде: на маке через `host/prove-guarded.sh`, на
//! арендованном сервере через `host/remote/measure.sh`. Режимы — `proving.rs`:
//!   `--compressed` — пробный СЖАТЫЙ пруф (STARK без обёртки в Groth16): замер времени и памяти,
//!       контракт такой пруф не принимает;
//!   `--prove` — пруф Groth16 для контракта на TON (нужна сборка с `--features native-gnark`).
//!       Нонс SP1 фиксирован нулём: так его ждёт ключ контракта. Перед пруфом хост сверяет, что
//!       собран из нынешних исходников и что program.json описывает именно эту сборку;
//!   `--prove-compressed` и `--wrap-groth16 <сжатый пруф>` — тот же пруф в два шага (сжатый на
//!       GPU, обёртка Groth16 на процессоре), когда видеопамяти на обёртку не хватает.
//!
//! `--elf <файл>` — ELF программы из файла вместо вшитого (`program.rs`): на сервере программу не
//! пересобирают. Файл принимается, только если его sha256 и ключ, выведенный SDK, — те, что в
//! program.json; сверка — до любой работы. Прувер на GPU — `SP1_PROVER=cuda` и сборка с
//! `--features cuda`.
use std::{
    fs,
    path::{Path, PathBuf},
};

use alloy_primitives::{keccak256, Address, Bytes, B256};
use clap::Parser;
use revm::state::Bytecode;
use rollup_evm::{
    block_data_chunks,
    forced::decode_forced_transaction,
    process_evm_batch,
    reveal::{account_path_is_revealed, reveal_account_nodes},
    BatchOutcome, Deposit, EvmBatchInput, ForcedOutcome, PublicValues, QueueItem, FORCED_TX_GAS_CAP,
    WITHDRAWAL_TREE_DEPTH,
};
use rsp_client_executor::io::EthClientExecutorInput;
use serde::Deserialize;
use sp1_sdk::{
    blocking::{Prover, ProverClient},
    include_elf, Elf, HashableKey, ProvingKey, SP1Stdin,
};

mod program;
mod proving;
mod sources;
mod wrap;

use program::{plain_hex, Program, ProgramKeys};

const EVM_ELF: Elf = include_elf!("rollup-evm-program");
/// Хеш исходников программы на момент сборки этого бинарника (build.rs).
const BUILT_FROM_SOURCES: &str = env!("ROLLUP_EVM_SOURCES_SHA256");
/// Хеш исходников хоста на момент сборки.
const BUILT_FROM_HOST: &str = env!("ROLLUP_EVM_HOST_SHA256");
const SP1_VERSION: &str = env!("ROLLUP_EVM_SP1_SDK");
const GUEST_RUSTC: &str = env!("ROLLUP_EVM_GUEST_RUSTC");
const HOST_CARGO: &str = env!("ROLLUP_EVM_CARGO");

#[derive(Parser)]
struct Args {
    /// Посчитать ключ программы и записать fixtures/evm_batches/program.json.
    #[arg(long, conflicts_with_all = ["block_input", "batch_input", "execute", "compressed", "prove", "elf"])]
    vkeys: bool,
    /// Напечатать JSON: хеш ELF программы и хеши исходников (на момент сборки и на диске).
    #[arg(long, conflicts_with_all = ["vkeys", "block_input", "batch_input", "execute", "compressed", "prove", "classify_forced", "elf"])]
    identity: bool,
    /// Проверить форму принудительных транзакций: JSON-массив байтов (hex). Ответ — в --report.
    #[arg(
        long,
        requires_all = ["chain_id", "report"],
        conflicts_with_all = ["vkeys", "block_input", "batch_input", "execute", "compressed", "prove", "write_input", "elf"]
    )]
    classify_forced: Option<PathBuf>,
    /// Вход блока в формате кэша RSP: <cache-dir>/input/<chainId>/<номер блока>.bin
    #[arg(long, requires = "chain_id", conflicts_with = "batch_input")]
    block_input: Option<PathBuf>,
    /// Идентификатор rollup'а: первое слово публичных значений (с --block-input) либо цепочка,
    /// под которую проверяется форма (с --classify-forced).
    #[arg(long, conflicts_with = "batch_input")]
    chain_id: Option<u64>,
    /// JSON со свидетелем rollup'а: отрезок очереди L1, фронтир и счётчик дерева выводов,
    /// доказательства счетов отправителей. Без него — пустая очередь и пустое дерево.
    #[arg(long, requires = "block_input")]
    witness: Option<PathBuf>,
    /// Отчёт хоста о предыдущем батче (--report): с ним сверяется прежняя отметка очереди из
    /// свидетеля. Обязателен, если отметка не ноль.
    #[arg(long, requires = "witness")]
    previous_report: Option<PathBuf>,
    /// Готовый вход батча (bincode), записанный раньше через --write-input.
    #[arg(long)]
    batch_input: Option<PathBuf>,
    /// Исполнить гостевую программу в zkVM (без пруфа) и сверить с нативным расчётом.
    #[arg(long)]
    execute: bool,
    /// ELF программы из файла вместо вшитого: принимается, только если его sha256 и ключ — из
    /// program.json. Для сервера, где программу не пересобирают.
    #[arg(long)]
    elf: Option<PathBuf>,
    /// Построить и проверить сжатый пруф (без Groth16): замер времени и памяти. Тяжёлая работа.
    #[arg(long, conflicts_with_all = ["execute", "prove", "prove_compressed", "wrap_groth16"])]
    compressed: bool,
    /// Построить пруф Groth16 для контракта и записать его в --proof-out. Тяжёлая работа.
    #[arg(long, conflicts_with_all = ["execute", "prove_compressed", "wrap_groth16"], requires = "proof_out")]
    prove: bool,
    /// Построить сжатый пруф и записать его в --proof-out (bincode SDK) — шаг 1 из двух.
    #[arg(long, conflicts_with_all = ["execute", "wrap_groth16"], requires = "proof_out")]
    prove_compressed: bool,
    /// Обернуть сжатый пруф из файла в Groth16 на процессоре → --proof-out (как у --prove) — шаг 2.
    #[arg(long, conflicts_with = "execute", requires = "proof_out")]
    wrap_groth16: Option<PathBuf>,
    /// Куда записать пруф: JSON для zk/import-sp1-fixture.mjs (--prove, --wrap-groth16) либо
    /// сжатый пруф (--prove-compressed).
    #[arg(long)]
    proof_out: Option<PathBuf>,
    /// Записать вход батча (bincode) — фикстура для тестов. Пишется после нативной проверки и,
    /// с --execute, после сверки с zkVM.
    #[arg(long)]
    write_input: Option<PathBuf>,
    /// Записать итог (JSON): одиннадцать слов, данные батча, судьба принудительных транзакций,
    /// выводы, фронтир дерева после блока и, с --execute, число циклов.
    #[arg(long)]
    report: Option<PathBuf>,
}

/// Свидетель rollup'а: то, что в настоящей системе секвенсор берёт у контракта на TON и у
/// своего узла L2.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WitnessFile {
    /// Хеш очереди L1 в прежней отметке (`processedHash` контракта).
    #[serde(default)]
    prev_deposit_hash: B256,
    /// Прежняя отметка очереди (`processedCount` контракта): номер последнего обработанного
    /// элемента. Программе не нужна — идёт в отчёт, чтобы батч знал, какую отметку заявить;
    /// сверяется в `checked_queue_mark`. Без поля — ноль.
    #[serde(default)]
    queue_processed_from: u64,
    /// Отрезок очереди, который обрабатывает блок, по порядку.
    #[serde(default)]
    queue: Vec<QueueEntry>,
    /// Фронтир дерева выводов до блока: 32 хеша. Пусто — дерево без листьев.
    #[serde(default)]
    withdrawals_frontier: Vec<B256>,
    /// Число листьев дерева выводов до блока, десятичной строкой.
    #[serde(default)]
    withdrawals_count: Option<String>,
    /// Доказательства счетов (`eth_getProof` на состоянии РОДИТЕЛЯ) отправителей принудительных
    /// транзакций отрезка; `code` — байткод счёта, если он у счёта есть.
    #[serde(default)]
    account_proofs: Vec<AccountProofEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
enum QueueEntry {
    Deposit(DepositEntry),
    /// Байты из очереди как есть.
    ForcedTransaction(Bytes),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DepositEntry {
    l2_recipient: Address,
    /// Сумма в нанотонах, десятичной строкой.
    amount: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountProofEntry {
    address: Address,
    account_proof: Vec<Bytes>,
    #[serde(default)]
    code: Option<Bytes>,
}

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn program_keys_file() -> PathBuf {
    repository().join("fixtures/evm_batches/program.json")
}

fn amount(text: &str) -> u128 {
    text.parse().unwrap_or_else(|_| panic!("сумма «{text}» — не целое число нанотонов"))
}

fn hex(bytes: &[u8]) -> String {
    format!("0x{}", plain_hex(bytes))
}

fn elf_sha256() -> String {
    program::sha256_hex(&EVM_ELF)
}

fn words(values: &PublicValues) -> serde_json::Value {
    serde_json::json!({
        "chainId": values.chain_id.to_string(),
        "prevStateRoot": hex(&values.prev_state_root),
        "newStateRoot": hex(&values.new_state_root),
        "batchHash": hex(&values.batch_hash),
        "prevWithdrawalsRoot": hex(&values.prev_withdrawals_root),
        "withdrawalsRoot": hex(&values.withdrawals_root),
        "prevDepositHash": hex(&values.prev_deposit_hash),
        "newDepositHash": hex(&values.new_deposit_hash),
        "prevWithdrawalsCount": values.prev_withdrawals_count.to_string(),
        "withdrawalsCount": values.withdrawals_count.to_string(),
        "blockTimestamp": values.block_timestamp.to_string(),
    })
}

/// Судьба принудительных транзакций отрезка — для отчёта: место в отрезке (с нуля) и исход.
fn forced_report(queue_items: &[QueueItem], outcome: &BatchOutcome) -> Vec<serde_json::Value> {
    let positions = queue_items
        .iter()
        .enumerate()
        .filter(|(_, item)| matches!(item, QueueItem::ForcedTransaction(_)))
        .map(|(position, _)| position);
    positions
        .zip(&outcome.forced)
        .map(|(position, forced)| match forced {
            ForcedOutcome::Included => serde_json::json!({ "queueIndex": position, "outcome": "included" }),
            ForcedOutcome::Skipped(reason) => {
                serde_json::json!({ "queueIndex": position, "outcome": "skipped", "reason": format!("{reason:?}") })
            }
        })
        .collect()
}

/// Бинарник обязан быть собран из тех исходников, что лежат на диске: иначе ELF внутри него —
/// от прежней версии, и пруф докажет не ту программу.
fn assert_binary_is_fresh() {
    let repository = repository();
    for (what, built, on_disk) in [
        ("программы", BUILT_FROM_SOURCES, sources::sources_sha256(&repository)),
        ("хоста", BUILT_FROM_HOST, sources::host_sha256(&repository)),
    ] {
        if built != on_disk {
            eprintln!(
                "Исходники {what} изменились после сборки этого бинарника.\n  собран из: {built}\n  на диске:  {on_disk}\n\
                 Пересоберите: cargo build --release --locked -p rollup-evm-host"
            );
            std::process::exit(2);
        }
    }
}

/// Чем собран этот бинарник (`--identity`). Ничего не проверяет и не пишет: сверяет вызывающий.
fn print_identity() {
    let repository = repository();
    let identity = serde_json::json!({
        "programElfSha256": format!("0x{}", elf_sha256()),
        "sourcesSha256": BUILT_FROM_SOURCES,
        "sourcesSha256OnDisk": sources::sources_sha256(&repository),
        "hostSha256": BUILT_FROM_HOST,
        "hostSha256OnDisk": sources::host_sha256(&repository),
    });
    println!("{}", serde_json::to_string_pretty(&identity).expect("JSON"));
}

fn program_vkey(client: &impl Prover) -> String {
    client.setup(EVM_ELF.clone()).expect("не удалось подготовить ключ программы").verifying_key().bytes32().to_string()
}

fn write_program_keys() {
    assert_binary_is_fresh();
    let keys = ProgramKeys {
        source: "Сгенерировано zkvm-evm/host (--vkeys); не редактировать вручную".into(),
        note: "Ключ программы батча EVM — первый публичный вход верификатора SP1; зависит от точного ELF, \
               то есть от исходников (sourcesSha256) и сборочного окружения. Его константа входит в ключ \
               контракта: fixtures/evm_batches/key.json."
            .into(),
        sp1_version: SP1_VERSION.into(),
        guest_rustc: GUEST_RUSTC.into(),
        cargo: HOST_CARGO.into(),
        sources_sha256: BUILT_FROM_SOURCES.into(),
        program_vkey: program_vkey(&ProverClient::from_env()),
        program_elf_sha256: elf_sha256(),
    };
    let file = program_keys_file();
    fs::create_dir_all(file.parent().expect("у файла есть каталог")).expect("каталог фикстур не создан");
    fs::write(&file, serde_json::to_string_pretty(&keys).expect("JSON") + "\n").expect("program.json не записан");
    println!("Ключ программы батча EVM: {}", keys.program_vkey);
    println!("Хеш исходников:           {}", keys.sources_sha256);
    println!("Записано: fixtures/evm_batches/program.json");
}

/// Дополняет свидетель состояния доказательствами счетов из файла свидетеля и проверяет, что
/// путь к счёту отправителя каждой годной по форме принудительной транзакции раскрыт.
fn supplement_state(
    block: &mut EthClientExecutorInput,
    chain_id: u64,
    witness: &WitnessFile,
    queue: &[QueueItem],
) -> Vec<serde_json::Value> {
    let mut supplemented = Vec::new();
    for entry in &witness.account_proofs {
        let revealed = reveal_account_nodes(&mut block.parent_state, &entry.account_proof)
            .unwrap_or_else(|error| panic!("доказательство счёта {}: {error}", entry.address));
        let found = account_path_is_revealed(&block.parent_state, keccak256(entry.address));
        assert!(found, "доказательство счёта {} не от состояния родителя этого блока", entry.address);
        println!("Свидетель дополнен счётом {}: раскрыто узлов {revealed}", entry.address);
        supplemented.push(serde_json::json!({ "address": entry.address, "revealedNodes": revealed }));
        if let Some(code) = &entry.code {
            let code = Bytecode::new_raw(code.clone());
            let hash = code.hash_slow();
            if !block.bytecodes.iter().any(|known| known.hash_slow() == hash) {
                block.bytecodes.push(code);
            }
        }
    }
    for item in queue {
        let QueueItem::ForcedTransaction(bytes) = item else { continue };
        let Ok(transaction) = decode_forced_transaction(bytes, chain_id, FORCED_TX_GAS_CAP) else { continue };
        let sender = transaction.signer();
        if !account_path_is_revealed(&block.parent_state, keccak256(sender)) {
            eprintln!(
                "В свидетеле нет пути к счёту отправителя принудительной транзакции {sender}.\n\
                 Добавьте в файл свидетеля accountProofs: eth_getProof этого счёта на блоке-родителе."
            );
            std::process::exit(2);
        }
    }
    supplemented
}

/// Что известно о батче помимо входа программы: прежняя отметка очереди и чем дополнен свидетель.
struct Extra {
    queue_processed_from: Option<u64>,
    /// С чем сверена прежняя отметка очереди — для отчёта.
    queue_mark_checked_against: Option<&'static str>,
    supplemented: Vec<serde_json::Value>,
}

/// Запись файла через временный файл и переименование: прерванная запись не оставит обрезанного
/// файла под настоящим именем (его читает сборщик блоков после перезапуска).
fn write_atomically(path: &Path, contents: &[u8], what: &str) {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    fs::write(&temporary, contents).unwrap_or_else(|error| panic!("{what} не записан: {error}"));
    fs::rename(&temporary, path).unwrap_or_else(|error| panic!("{what} не переименован: {error}"));
}

/// Форма принудительных транзакций — функцией программы, без состояния (`--classify-forced`).
/// Порядок ответа — порядок файла; `signer` — у годных по форме: чей это вызов моста и чьё
/// доказательство счёта понадобится свидетелю.
fn classify_forced(items: &Path, chain_id: u64, report: &Path) {
    let text = fs::read_to_string(items).unwrap_or_else(|error| refuse(format!("Файл {} не читается: {error}", items.display())));
    let items: Vec<Bytes> = serde_json::from_str(&text)
        .unwrap_or_else(|error| refuse(format!("Файл {}: ожидается JSON-массив строк hex ({error})", items.display())));
    let verdicts: Vec<serde_json::Value> = items
        .iter()
        .enumerate()
        .map(|(index, bytes)| match decode_forced_transaction(bytes, chain_id, FORCED_TX_GAS_CAP) {
            Ok(transaction) => serde_json::json!({
                "index": index,
                "form": "valid",
                "signer": hex(transaction.signer().as_slice()),
                "hash": hex(keccak256(bytes).as_slice()),
            }),
            Err(reason) => serde_json::json!({ "index": index, "form": "skipped", "reason": format!("{reason:?}") }),
        })
        .collect();
    let answer = serde_json::json!({ "chainId": chain_id.to_string(), "forcedTxGasCap": FORCED_TX_GAS_CAP, "verdicts": verdicts });
    write_atomically(report, (serde_json::to_string_pretty(&answer).expect("JSON") + "\n").as_bytes(), "ответ о форме");
}

/// Отказ по несогласованному свидетелю: сообщение и код 2 (как у прочих отказов хоста).
fn refuse(message: String) -> ! {
    eprintln!("{message}");
    std::process::exit(2);
}

/// Поле отчёта предыдущего батча строкой.
fn report_text<'a>(report: &'a serde_json::Value, path: &[&str]) -> &'a str {
    let mut value = report;
    for key in path {
        value = &value[*key];
    }
    value.as_str().unwrap_or_else(|| refuse(format!("В отчёте предыдущего батча нет поля {}", path.join("."))))
}

/// Сверяет прежнюю отметку очереди из свидетеля и возвращает, с чем она сверена.
///
/// Отметка — не часть входа программы: программа знает только хеш очереди в прежней точке.
/// Неверная отметка в отчёте дала бы батчу неверное `queueProcessedUpTo`, и контракт отверг бы
/// его уже после пруфа. Ноль — это пустая прежняя очередь, её хеш — ноль, и наоборот. Ненулевая
/// отметка сверяется с отчётом предыдущего батча: там она — `queueProcessedUpTo`, а хеш очереди,
/// дерево выводов и слово состояния этого батча обязаны продолжать тот.
fn checked_queue_mark(
    witness: &WitnessFile,
    previous_report: Option<&Path>,
    block: &EthClientExecutorInput,
) -> &'static str {
    let from = witness.queue_processed_from;
    let hash_is_zero = witness.prev_deposit_hash == B256::ZERO;
    if (from == 0) != hash_is_zero {
        refuse(format!(
            "Прежняя отметка очереди {from} не согласуется с прежним хешем очереди {}: ноль у отметки и у хеша — только вместе.",
            witness.prev_deposit_hash
        ));
    }
    let Some(path) = previous_report else {
        if from != 0 {
            refuse(format!(
                "Прежняя отметка очереди {from} не ноль: её нечем сверить. Передайте отчёт предыдущего батча (--previous-report)."
            ));
        }
        return "empty queue";
    };
    let previous: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).expect("отчёт предыдущего батча не читается"))
            .expect("отчёт предыдущего батча не разобран");
    let up_to = previous["queueProcessedUpTo"].as_u64();
    if up_to != Some(from) {
        refuse(format!(
            "Прежняя отметка очереди в свидетеле — {from}, а предыдущий батч обработал очередь до {up_to:?}."
        ));
    }
    let frontier: Vec<B256> = if witness.withdrawals_frontier.is_empty() {
        vec![B256::ZERO; WITHDRAWAL_TREE_DEPTH]
    } else {
        witness.withdrawals_frontier.clone()
    };
    let previous_frontier: Vec<B256> = previous["withdrawalsFrontierAfter"]
        .as_array()
        .unwrap_or_else(|| refuse("В отчёте предыдущего батча нет поля withdrawalsFrontierAfter".into()))
        .iter()
        .map(|node| node.as_str().and_then(|text| text.parse().ok()).unwrap_or_else(|| refuse("Фронтир в отчёте предыдущего батча не разобран".into())))
        .collect();
    let parse = |path: &[&str]| -> B256 {
        report_text(&previous, path).parse().unwrap_or_else(|_| refuse(format!("Поле {} отчёта предыдущего батча — не хеш", path.join("."))))
    };
    let checks = [
        ("хеш очереди", parse(&["publicValues", "newDepositHash"]) == witness.prev_deposit_hash),
        ("хеш родителя", parse(&["publicValues", "newStateRoot"]) == block.current_block.header.parent_hash),
        ("фронтир дерева выводов", previous_frontier == frontier),
        (
            "счётчик выводов",
            report_text(&previous, &["publicValues", "withdrawalsCount"]) == witness.withdrawals_count.as_deref().unwrap_or("0"),
        ),
    ];
    for (what, equal) in checks {
        if !equal {
            refuse(format!("Свидетель не продолжает предыдущий батч: не совпал {what}."));
        }
    }
    "previous report"
}

/// Режим пруфа из аргументов (clap уже исключил сочетания).
fn proof_mode(args: &Args) -> Option<proving::Mode<'_>> {
    match (&args.wrap_groth16, args.compressed, args.prove, args.prove_compressed) {
        (Some(path), ..) => Some(proving::Mode::WrapGroth16(path)),
        (None, true, ..) => Some(proving::Mode::Compressed),
        (None, _, true, _) => Some(proving::Mode::Groth16),
        (None, _, _, true) => Some(proving::Mode::ProveCompressed),
        _ => None,
    }
}

/// Вход батча и сведения для отчёта: готовый (--batch-input) или собранный
/// из входа блока RSP и свидетеля.
fn load_input(args: &Args) -> (EvmBatchInput, Extra) {
    if let Some(path) = &args.batch_input {
        let input = bincode::deserialize(&fs::read(path).expect("файл входа батча не читается"))
            .expect("вход батча не разобран");
        return (input, Extra { queue_processed_from: None, queue_mark_checked_against: None, supplemented: Vec::new() });
    }
    let path = args.block_input.as_ref().expect("нужен --block-input или --batch-input");
    let mut block: EthClientExecutorInput =
        bincode::deserialize(&fs::read(path).expect("файл входа блока не читается"))
            .expect("вход блока не разобран: ожидается файл кэша RSP");
    let witness: WitnessFile = match &args.witness {
        Some(path) => serde_json::from_str(&fs::read_to_string(path).expect("файл свидетеля не читается"))
            .expect("свидетель не разобран"),
        None => WitnessFile::default(),
    };
    let chain_id = args.chain_id.expect("с --block-input нужен --chain-id");
    let checked_against = checked_queue_mark(&witness, args.previous_report.as_deref(), &block);
    let queue_items: Vec<QueueItem> = witness
        .queue
        .iter()
        .map(|entry| match entry {
            QueueEntry::Deposit(deposit) => QueueItem::Deposit(Deposit {
                l2_recipient: deposit.l2_recipient.into_array(),
                amount: amount(&deposit.amount),
            }),
            QueueEntry::ForcedTransaction(bytes) => QueueItem::ForcedTransaction(bytes.to_vec()),
        })
        .collect();
    let mut withdrawals_frontier = [[0u8; 32]; WITHDRAWAL_TREE_DEPTH];
    if !witness.withdrawals_frontier.is_empty() {
        assert_eq!(witness.withdrawals_frontier.len(), WITHDRAWAL_TREE_DEPTH, "во фронтире дерева выводов не 32 хеша");
        for (slot, node) in withdrawals_frontier.iter_mut().zip(&witness.withdrawals_frontier) {
            *slot = node.0;
        }
    }
    let withdrawals_count = witness.withdrawals_count.as_deref().map_or(0, |text| {
        text.parse().unwrap_or_else(|_| panic!("счётчик выводов «{text}» — не целое число"))
    });
    let supplemented = supplement_state(&mut block, chain_id, &witness, &queue_items);
    let input = EvmBatchInput {
        chain_id,
        data_chunks: block_data_chunks(&block.current_block),
        block,
        prev_deposit_hash: witness.prev_deposit_hash.0,
        queue_items,
        withdrawals_frontier,
        withdrawals_count,
    };
    let extra = Extra {
        queue_processed_from: Some(witness.queue_processed_from),
        queue_mark_checked_against: Some(checked_against),
        supplemented,
    };
    (input, extra)
}

fn main() {
    // Сборка под clippy гостевую программу не собирает: в бинарнике был бы прежний ELF.
    assert!(
        BUILT_FROM_SOURCES.chars().all(|c| c.is_ascii_hexdigit()),
        "этот бинарник собран без гостевой программы (clippy): пересоберите обычной сборкой"
    );
    sp1_sdk::utils::setup_logger();
    let args = Args::parse();
    if args.vkeys {
        return write_program_keys();
    }
    if args.identity {
        return print_identity();
    }
    if let Some(items) = &args.classify_forced {
        let chain_id = args.chain_id.expect("clap требует --chain-id");
        return classify_forced(items, chain_id, args.report.as_ref().expect("clap требует --report"));
    }
    let mode = proof_mode(&args);
    if args.proof_out.is_some() && !matches!(mode, Some(proving::Mode::Groth16 | proving::Mode::ProveCompressed | proving::Mode::WrapGroth16(_))) {
        refuse("--proof-out — только с --prove, --prove-compressed или --wrap-groth16".into());
    }
    // ELF — до любой работы со входом: файловый сверяется с program.json по sha256 и по ключу.
    let program = match &args.elf {
        Some(path) => Program::from_file(path, &program_keys_file()),
        None => Program::embedded(EVM_ELF),
    };
    program::assert_vkey_from_file(&program, &program_keys_file());

    let (input, extra) = load_input(&args);
    let queue_processed_from = extra.queue_processed_from;
    let queue_items = input.queue_items.clone();
    let withdrawals_before = input.withdrawals_count;
    let data_chunks_hex: Vec<String> = input.data_chunks.iter().map(|chunk| plain_hex(chunk)).collect();
    let data_bytes: usize = input.data_chunks.iter().map(Vec::len).sum();
    let transactions = input.block.current_block.body.transactions.len();
    let block_number = input.block.current_block.header.number;
    let encoded = bincode::serialize(&input).expect("вход батча не сериализуется");

    // Сначала проверки, потом запись (ниже): фикстура отвергнутого батча не появляется.
    let outcome = process_evm_batch(input).expect("нативный расчёт отверг батч");
    let native = outcome.values.clone();
    println!(
        "Блок {block_number}: транзакций {transactions}, элементов очереди {}, выводов {}, данных батча {data_bytes} байт",
        queue_items.len(),
        outcome.withdrawals.len()
    );
    println!("{}", serde_json::to_string_pretty(&words(&native)).unwrap());

    let mut cycles = None;
    if args.execute {
        let mut stdin = SP1Stdin::new();
        stdin.write_vec(encoded.clone());
        let client = ProverClient::from_env();
        let (output, report) = client.execute(program.elf.clone(), stdin).run().expect("исполнение в zkVM не удалось");
        assert_eq!(output.as_slice(), native.to_bytes().as_slice(), "zkVM и нативный запуск разошлись");
        println!("Публичные значения zkVM совпали с нативным расчётом.");
        println!("Циклов zkVM: {}", report.total_instruction_count());
        cycles = Some(report.total_instruction_count());
    }
    // Вход батча — после нативной проверки и, если запрошено, после сверки с zkVM: расхождение
    // выше — паника, и до записи дело не доходит. Через временный файл: прерванная запись не
    // оставит обрезанной фикстуры под настоящим именем.
    if let Some(path) = &args.write_input {
        write_atomically(path, &encoded, "вход батча");
        println!("Вход батча: {} ({} байт)", path.display(), encoded.len());
    }

    let proved = mode.map(|mode| {
        assert_binary_is_fresh();
        let keys_file = program_keys_file();
        let native_bytes = native.to_bytes();
        let job = proving::Job {
            program: &program,
            keys_file: &keys_file,
            built_from_sources: BUILT_FROM_SOURCES,
            encoded_input: &encoded,
            native_public_values: &native_bytes,
            block_number,
            proof_out: args.proof_out.as_deref(),
        };
        proving::run(mode, &job)
    });

    if let Some(path) = &args.report {
        let report = serde_json::json!({
            "blockNumber": block_number,
            "transactions": transactions,
            "dataBytes": data_bytes,
            "dataChunksHex": data_chunks_hex,
            "publicValues": words(&native),
            "publicValuesBytes": hex(&native.to_bytes()),
            // Отметки очереди L1: батч заявляет контракту queueProcessedUpTo.
            "queueProcessedFrom": queue_processed_from,
            "queueProcessedUpTo": queue_processed_from.map(|from| from + queue_items.len() as u64),
            // С чем сверена прежняя отметка: «empty queue» — ноль при нулевом хеше очереди,
            // «previous report» — отчёт предыдущего батча.
            "queueMarkCheckedAgainst": extra.queue_mark_checked_against,
            "queueItems": queue_items.len(),
            // Счета, которыми дополнен свидетель узла (eth_getProof на родителе), и сколько узлов
            // каждый раскрыл: ноль — путь уже был в свидетеле.
            "supplementedAccounts": extra.supplemented,
            "forced": forced_report(&queue_items, &outcome),
            // Выводы блока: листья дерева с номерами. Фронтир после блока — вход следующего батча.
            "withdrawals": outcome.withdrawals.iter().enumerate().map(|(index, leaf)| serde_json::json!({
                "leafIndex": withdrawals_before + index as u64,
                "recipientHash": hex(&leaf.recipient_hash),
                "amount": leaf.amount.to_string(),
            })).collect::<Vec<_>>(),
            "withdrawalsFrontierAfter": outcome.withdrawals_frontier.iter().map(|node| hex(node)).collect::<Vec<_>>(),
            "zkvmCycles": cycles,
            "programElfSha256": format!("0x{}", program.sha256),
            // ELF из файла (--elf) либо вшитый при сборке (null).
            "programElfFile": program.file,
            "sourcesSha256": BUILT_FROM_SOURCES,
            "proofMode": mode.map(|mode| mode.name()),
            "prover": proved.as_ref().map(|outcome| outcome.prover.clone()),
            "setupSeconds": proved.as_ref().map(|outcome| outcome.setup_seconds),
            "proofSeconds": proved.as_ref().map(|outcome| outcome.proof_seconds),
            "programVKey": proved.as_ref().map(|outcome| outcome.vkey.clone()),
        });
        write_atomically(path, (serde_json::to_string_pretty(&report).unwrap() + "\n").as_bytes(), "отчёт");
    }
}
