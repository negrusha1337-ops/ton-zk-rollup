//! Батч rollup'а на EVM, протокол версии 2 (`PROTOCOL-V2.md`): один блок EVM, исполненный Reth,
//! и одиннадцать слов публичных значений, которые проверяет контракт на TON
//! (`contracts/rollup/logic.tolk`, `batchDigest`).
//!
//! Слова:
//!
//!   0  chainId              — идентификатор цепочки; им подписана каждая транзакция блока
//!   1  prevStateRoot        — ХЕШ ЗАГОЛОВКА РОДИТЕЛЯ (не корень состояния)
//!   2  newStateRoot         — ХЕШ ЗАГОЛОВКА БЛОКА
//!   3  batchHash            — накопительный хеш порций данных; порции — RLP блока целиком
//!   4  prevWithdrawalsRoot  — корень дерева выводов до блока
//!   5  withdrawalsRoot      — корень дерева выводов после блока
//!   6  prevDepositHash      — накопительный хеш очереди L1 до отрезка, обработанного блоком
//!   7  newDepositHash       — он же после отрезка
//!   8  prevWithdrawalsCount — число листьев дерева выводов до блока
//!   9  withdrawalsCount     — оно же после блока
//!   10 blockTimestamp       — время блока; контракт сверяет его со временем L1
//!
//! Почему хеш блока, а не корень состояния. Блок проверяется относительно заголовка родителя
//! (номер, время, базовая комиссия, лимит газа), а этот заголовок даёт доказывающий. Если бы
//! контракт хранил только корень состояния, секвенсор мог бы подставить родителя с любыми
//! номером и временем при том же корне. Хеш заголовка обязывает ко всему заголовку сразу, а
//! через него — и к корню состояния. Первый родитель — генезис: его хеш — константа протокола
//! в контракте (`GENESIS_HASH`), вместе с ним закреплён и счёт моста.
//!
//! Правила цепочки (набор хардфорков по Cancun) зашиты в программу — `chain_config`. В RSP их
//! задаёт вход доказывающего; здесь поля `genesis`, `custom_beneficiary` и `opcode_tracking`
//! входа блока не читаются вовсе. Поля заголовка, которые правила Ethereum оставляют сборщику
//! блока, закреплены (`check_header_policy`): лимит газа, `mix_hash`, `extra_data`, корень
//! beacon-блока. Свободен только получатель чаевых — это доход секвенсора.
//!
//! Очередь L1→L2. Блок обрабатывает отрезок очереди — не больше `MAX_BATCH_QUEUE_ITEMS`
//! элементов, по порядку. Докуда обработано, программа не знает и не коммитит: контракт сам
//! берёт хеш очереди в заявленной точке, и батч годен, только если он равен слову 7.
//!   * Депозиты — список зачислений блока (EIP-4895, «withdrawals» в терминах Ethereum): EVM
//!     начисляет их без транзакций, в конце блока. Список обязан совпасть с депозитами отрезка
//!     элемент в элемент.
//!   * Принудительные транзакции (`forced.rs`, `execute.rs`) — только вывод через мост с малым
//!     пределом газа и длины. Исполняются первыми, в порядке очереди; действительная обязана стоять в
//!     блоке на своём месте, недействительная пропускается. Зачисления блока применяются после
//!     транзакций: принудительная транзакция видит депозиты только прежних батчей.
//!
//! Выводы L2→L1 — логи моста-предустановки (`bridge.rs`), в порядке блока; дерево выводов —
//! с дозаписью, во входе его фронтир и счётчик (`withdrawals.rs`).
//!
//! Чего здесь НЕТ:
//!   * принудительного вызова произвольного контракта и принудительного перевода — только
//!     вывод через мост: это гарантия «свои монеты с обычного счёта можно вывести в обход
//!     секвенсора», а не «любую транзакцию можно провести»;
//!   * программы аварийного выхода: баланс обычного счёта после заморозки выходит без пруфа —
//!     контракт сам проверяет доказательство счёта против заголовка блока (`ForceExitEvm`);
//!     монеты на контрактах L2 и токены при заморозке теряются;
//!   * нескольких блоков в батче;
//!   * правил после Cancun: пересборка байткода (`witness.rs`) и список типов транзакций
//!     рассчитаны на Cancun и при переходе на Prague меняются вместе.
use std::{fmt, sync::Arc};

use alloy_consensus::{Block, Header, Transaction, TxType};
use alloy_eips::eip4895::Withdrawal;
use alloy_genesis::ChainConfig;
use alloy_primitives::{Address, B256, U256};
use reth_chainspec::{ChainSpec, NamedChain};
use reth_ethereum_primitives::TransactionSigned;
use rsp_client_executor::io::EthClientExecutorInput;
use rsp_primitives::genesis::Genesis;
use serde::{Deserialize, Serialize};

pub mod bridge;
mod execute;
pub mod forced;
pub mod genesis;
pub mod protocol;
pub mod reveal;
#[cfg(test)]
mod tests;
pub mod withdrawals;
pub mod witness;

pub use bridge::{BRIDGE_ADDRESS, BRIDGE_CODE, BRIDGE_CODE_HASH, WEI_PER_NANOTON, WITHDRAWAL_TOPIC};
pub use execute::ExecutedBlock;
pub use forced::{ForcedOutcome, InvalidReason, SkipReason};
pub use genesis::{genesis_header, GENESIS_HASH, GENESIS_STATE_ROOT};
pub use protocol::{
    batch_data_hash, deposit_hash, forced_transaction_hash, queue_item_hash, Deposit, Hash, PublicValues, QueueItem,
    WithdrawalLeaf, MAX_DATA_CHUNK_BYTES,
};
pub use withdrawals::{Frontier, FrontierError, WithdrawalTree, MAX_WITHDRAWALS, WITHDRAWAL_TREE_DEPTH};

/// Лимит газа блока: закреплён, равен лимиту генезиса. Со свободным лимитом секвенсор мог бы
/// сползанием лимита сделать принудительные транзакции «не помещающимися».
pub const GAS_LIMIT: u64 = 30_000_000;

/// Предел газа принудительной транзакции: вызов моста стоит около 23,3 тыс. gas (21 000 +
/// данные + код моста). С таким пределом `MAX_BATCH_QUEUE_ITEMS` принудительных транзакций
/// заведомо помещаются в блок, и ошибка «не помещается по газу блока» недостижима.
pub const FORCED_TX_GAS_CAP: u64 = 40_000;

/// Наибольшая длина принудительной транзакции в байтах; более длинный элемент очереди
/// пропускается без разбора (`forced.rs`). Вызов моста с 32 байтами данных и пустым списком
/// доступа занимает не больше 212 байт при любых значениях полей.
pub const FORCED_TX_MAX_BYTES: usize = 256;

/// Сколько элементов очереди L1 блок может обработать — как MAX_BATCH_QUEUE_ITEMS в
/// contracts/rollup/logic.tolk. Секвенсора нельзя заставить взять больше, и сам он больше
/// взять не может: цена пруфа батча ограничена сверху.
pub const MAX_BATCH_QUEUE_ITEMS: usize = 32;

/// Всё, что нужно для одного батча. Для zkVM это приватный вход.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmBatchInput {
    /// Идентификатор rollup'а: первое слово публичных значений и часть подписи каждой транзакции.
    pub chain_id: u64,
    /// Блок, заголовки предков и свидетель состояния родителя — в формате RSP.
    pub block: EthClientExecutorInput,
    /// Накопительный хеш очереди L1 на момент предыдущего батча.
    pub prev_deposit_hash: Hash,
    /// Отрезок очереди L1, который обрабатывает блок, в порядке очереди.
    pub queue_items: Vec<QueueItem>,
    /// Порции данных батча в том виде и порядке, в каком они опубликованы в TON. Их склейка
    /// обязана быть RLP блока.
    pub data_chunks: Vec<Vec<u8>>,
    /// Фронтир дерева выводов до блока (`withdrawals.rs`).
    pub withdrawals_frontier: Frontier,
    /// Число листьев дерева выводов до блока.
    pub withdrawals_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvmBatchError {
    /// Из зашитых правил не собралась спецификация цепочки.
    ChainSpec,
    /// Для этого `chainId` библиотека RSP ослабляет проверки заголовка (сети Linea).
    UnsupportedChainId(u64),
    /// Порция данных длиннее допустимого.
    DataChunkTooLarge,
    /// Склейка порций данных — не RLP этого блока.
    DataMismatch,
    /// В отрезке очереди больше MAX_BATCH_QUEUE_ITEMS элементов.
    TooManyQueueItems(usize),
    /// Число зачислений в блоке не равно числу депозитов отрезка очереди.
    DepositCountMismatch { block: usize, queue: usize },
    /// Зачисление с этим номером не совпало с депозитом очереди.
    DepositMismatch(usize),
    /// Сумма депозита не помещается в зачисление (64 бита gwei). Контракт таких не принимает.
    DepositTooLarge(usize),
    /// Принудительная транзакция (номер среди принудительных отрезка) действительна, а в блоке
    /// на её месте стоит другая либо ничего: секвенсор её цензурирует.
    ForcedTransactionOmitted(usize),
    /// Принудительная транзакция не помещается по газу блока: отрезок надо было закончить раньше.
    ForcedTransactionDoesNotFit(usize),
    /// Отказ revm по принудительной транзакции вне закрытого перечня причин пропуска.
    ForcedTransactionRefusal(usize, String),
    /// Поле заголовка, закреплённое правилами rollup'а, имеет другое значение.
    HeaderPolicy(&'static str),
    /// Транзакция без `chainId` в подписи: её можно было бы повторить в другой цепочке.
    UnprotectedTransaction(usize),
    /// В блоке blob-транзакция либо ненулевой расход или избыток blob-газа: блобов у rollup'а нет.
    BlobsNotSupported,
    /// Тип транзакции вне списка допустимых (обычная, EIP-2930, EIP-1559).
    UnsupportedTransactionType(usize),
    /// Фронтир дерева выводов во входе негоден.
    WithdrawalFrontier(FrontierError),
    /// В дереве выводов кончились листья.
    TooManyWithdrawals,
    /// В блоке есть лог моста, а код счёта моста в состоянии родителя — не код моста.
    BridgeCodeMismatch,
    /// Лог моста не той формы, которую пишет его код.
    MalformedBridgeLog,
    /// Во входе нет заголовка родителя.
    MissingParentHeader,
    /// Свидетель состояния или цепочка заголовков не сошлись.
    Witness(String),
    /// Не восстановился отправитель транзакции.
    SignatureRecovery,
    /// Блок нарушает правила цепочки сам по себе: заголовок или тело против заголовка.
    InvalidBlock(String),
    /// Заголовок предка некорректен или блок не продолжает родителя по правилам (хеш, номер,
    /// время, базовая комиссия, лимит газа).
    InvalidAncestry(String),
    /// Итоги исполнения не сошлись с заголовком (газ, корень квитанций, фильтр логов).
    InvalidExecutionResult(String),
    /// Исполнение блока не удалось (например, недопустимая транзакция).
    Execution(String),
    /// Корень состояния после исполнения не равен корню в заголовке.
    MismatchedStateRoot { computed: Hash, header: Hash },
}

impl fmt::Display for EvmBatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for EvmBatchError {}

/// Правила цепочки rollup'а: все хардфорки Ethereum по Cancun включительно действуют с нулевого
/// блока. Зашито в программу, а значит — в ключ программы. От `chainId` правила не зависят:
/// значения, для которых RSP их ослабляет, отвергает `chain_spec`.
pub fn chain_config(chain_id: u64) -> ChainConfig {
    let mut config = ChainConfig::default();
    config.chain_id = chain_id;
    config.homestead_block = Some(0);
    config.dao_fork_block = Some(0);
    config.dao_fork_support = true;
    config.eip150_block = Some(0);
    config.eip155_block = Some(0);
    config.eip158_block = Some(0);
    config.byzantium_block = Some(0);
    config.constantinople_block = Some(0);
    config.petersburg_block = Some(0);
    config.istanbul_block = Some(0);
    config.muir_glacier_block = Some(0);
    config.berlin_block = Some(0);
    config.london_block = Some(0);
    config.merge_netsplit_block = Some(0);
    config.terminal_total_difficulty = Some(U256::ZERO);
    config.terminal_total_difficulty_passed = true;
    config.shanghai_time = Some(0);
    config.cancun_time = Some(0);
    config
}

/// Спецификация цепочки из зашитых правил.
pub fn chain_spec(chain_id: u64) -> Result<Arc<ChainSpec>, EvmBatchError> {
    // RSP (into_primitives.rs, handle_custom_chains) для сетей Linea пропускает проверку
    // сложности и длины extraData. Rollup с таким chainId получил бы другие правила заголовка.
    if matches!(
        NamedChain::try_from(chain_id),
        Ok(NamedChain::Linea | NamedChain::LineaSepolia | NamedChain::LineaGoerli)
    ) {
        return Err(EvmBatchError::UnsupportedChainId(chain_id));
    }
    let genesis = Genesis::Custom(chain_config(chain_id));
    let spec: ChainSpec = (&genesis).try_into().map_err(|_| EvmBatchError::ChainSpec)?;
    Ok(Arc::new(spec))
}

/// Данные батча для публикации в TON: RLP блока, порезанный на порции допустимой длины.
pub fn block_data_chunks(block: &Block<TransactionSigned>) -> Vec<Vec<u8>> {
    alloy_rlp::encode(block).chunks(MAX_DATA_CHUNK_BYTES).map(<[u8]>::to_vec).collect()
}

/// Склейка порций обязана быть ровно `encoded`. Границы порций — на усмотрение публикующего:
/// контракт копит хеш тех порций, что реально опубликованы.
fn check_block_data(encoded: &[u8], chunks: &[Vec<u8>]) -> Result<(), EvmBatchError> {
    let mut offset = 0usize;
    for chunk in chunks {
        let end = offset.checked_add(chunk.len()).ok_or(EvmBatchError::DataMismatch)?;
        if end > encoded.len() || encoded[offset..end] != chunk[..] {
            return Err(EvmBatchError::DataMismatch);
        }
        offset = end;
    }
    if offset != encoded.len() {
        return Err(EvmBatchError::DataMismatch);
    }
    Ok(())
}

/// Сверяет отрезок очереди L1 с блоком и возвращает накопительный хеш очереди после отрезка.
///
/// Депозиты отрезка обязаны совпасть с зачислениями блока: зачисление i — ровно i-й депозит
/// отрезка (тот же получатель, та же сумма, нанотоны = gwei), номер зачисления — его место в
/// блоке, номер валидатора — ноль. Лишнее зачисление — это монеты из воздуха, пропущенное —
/// украденный депозит; ни то ни другое не даёт хеш очереди, который ждёт контракт, но проверка
/// здесь явная и не полагается на это. Принудительные транзакции входят в хеш своими байтами;
/// что с ними стало в блоке, решает исполнение (`execute.rs`).
pub fn check_queue(
    credits: &[Withdrawal],
    queue_items: &[QueueItem],
    prev_deposit_hash: &Hash,
) -> Result<Hash, EvmBatchError> {
    if queue_items.len() > MAX_BATCH_QUEUE_ITEMS {
        return Err(EvmBatchError::TooManyQueueItems(queue_items.len()));
    }
    let deposits = queue_items.iter().filter(|item| matches!(item, QueueItem::Deposit(_))).count();
    if credits.len() != deposits {
        return Err(EvmBatchError::DepositCountMismatch { block: credits.len(), queue: deposits });
    }
    let mut hash = *prev_deposit_hash;
    let mut index = 0usize;
    for item in queue_items {
        if let QueueItem::Deposit(deposit) = item {
            let credit = &credits[index];
            let amount = u64::try_from(deposit.amount).map_err(|_| EvmBatchError::DepositTooLarge(index))?;
            if credit.index != index as u64 ||
                credit.validator_index != 0 ||
                credit.address != Address::from(deposit.l2_recipient) ||
                credit.amount != amount
            {
                return Err(EvmBatchError::DepositMismatch(index));
            }
            index += 1;
        }
        hash = queue_item_hash(&hash, item);
    }
    Ok(hash)
}

/// Каждая транзакция блока обязана нести `chainId` в подписи (EIP-155 и новее). Совпадение
/// `chainId` с цепочкой проверяет уже EVM при исполнении; транзакцию вовсе без `chainId` EVM
/// принял бы, а она годится для любой цепочки с теми же счетами.
fn reject_unprotected(transactions: &[TransactionSigned]) -> Result<(), EvmBatchError> {
    match transactions.iter().position(|transaction| transaction.chain_id().is_none()) {
        Some(index) => Err(EvmBatchError::UnprotectedTransaction(index)),
        None => Ok(()),
    }
}

/// Блобов (EIP-4844) у rollup'а нет: данные публикуются в TON. Blob-транзакция сослалась бы на
/// данные, которых нигде нет, а расход blob-газа в заголовке с транзакциями не сверяется (у Reth
/// такая проверка есть, но RSP её не вызывает) — секвенсор двигал бы цену блобов как угодно. Поэтому: ни одной blob-транзакции,
/// нулевой расход и нулевой избыток blob-газа в заголовке. Избыток правила считают от
/// родителя, то есть в конечном счёте от генезиса: без этой проверки ненулевой избыток в
/// генезисе задавал бы `BLOBBASEFEE` первых блоков.
fn reject_blobs(block: &Block<TransactionSigned>) -> Result<(), EvmBatchError> {
    let has_blob_transaction =
        block.body.transactions.iter().any(|transaction| transaction.blob_versioned_hashes().is_some());
    if has_blob_transaction || block.header.blob_gas_used != Some(0) || block.header.excess_blob_gas != Some(0) {
        return Err(EvmBatchError::BlobsNotSupported);
    }
    Ok(())
}

/// Допустимые типы транзакций — явным списком. Транзакции с делегированием (EIP-7702) правила
/// Cancun и так отвергают при исполнении, но на их отсутствии держится `rebuild_bytecodes`
/// (любой код — обычный): запрет не должен зависеть от того, какой хардфорк включён.
fn reject_unsupported_types(transactions: &[TransactionSigned]) -> Result<(), EvmBatchError> {
    let supported = |transaction: &TransactionSigned| {
        matches!(transaction.tx_type(), TxType::Legacy | TxType::Eip2930 | TxType::Eip1559)
    };
    match transactions.iter().position(|transaction| !supported(transaction)) {
        Some(index) => Err(EvmBatchError::UnsupportedTransactionType(index)),
        None => Ok(()),
    }
}

/// Поля заголовка, которые правила Ethereum оставляют на усмотрение сборщика блока, а rollup
/// закрепляет. Лимит газа — чтобы секвенсор не мог сползанием лимита вытеснить принудительные
/// транзакции; `mix_hash` (он же `PREVRANDAO`) — ноль: случайности на L2 нет, и честнее ноль,
/// чем значение по выбору секвенсора; `extra_data` и корень beacon-блока — пусто и ноль, чтобы
/// у заголовка не было свободных полей кроме получателя чаевых.
fn check_header_policy(header: &Header) -> Result<(), EvmBatchError> {
    if header.gas_limit != GAS_LIMIT {
        return Err(EvmBatchError::HeaderPolicy("gas_limit"));
    }
    if header.mix_hash != B256::ZERO {
        return Err(EvmBatchError::HeaderPolicy("mix_hash"));
    }
    if !header.extra_data.is_empty() {
        return Err(EvmBatchError::HeaderPolicy("extra_data"));
    }
    if header.parent_beacon_block_root != Some(B256::ZERO) {
        return Err(EvmBatchError::HeaderPolicy("parent_beacon_block_root"));
    }
    Ok(())
}

/// Итог батча с подробностями — для хоста и тестов. Программа коммитит только `values`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchOutcome {
    pub values: PublicValues,
    /// Что стало с каждой принудительной транзакцией отрезка, в порядке очереди.
    pub forced: Vec<ForcedOutcome>,
    /// Выводы блока в порядке дозаписи в дерево.
    pub withdrawals: Vec<WithdrawalLeaf>,
    /// Фронтир дерева выводов после блока — вход следующего батча.
    pub withdrawals_frontier: Frontier,
}

/// Применяет батч: проверяет блок целиком и возвращает публичные значения.
pub fn apply_evm_batch(input: EvmBatchInput) -> Result<PublicValues, EvmBatchError> {
    process_evm_batch(input).map(|outcome| outcome.values)
}

/// То же с подробностями.
pub fn process_evm_batch(input: EvmBatchInput) -> Result<BatchOutcome, EvmBatchError> {
    process_with_gas_cap(input, FORCED_TX_GAS_CAP)
}

/// Предел газа принудительной транзакции — параметром только ради теста ошибки «не помещается
/// по газу блока»: с пределом протокола она недостижима.
pub(crate) fn process_with_gas_cap(input: EvmBatchInput, forced_gas_cap: u64) -> Result<BatchOutcome, EvmBatchError> {
    let EvmBatchInput {
        chain_id,
        block,
        prev_deposit_hash,
        queue_items,
        data_chunks,
        withdrawals_frontier,
        withdrawals_count,
    } = input;
    let chain_spec = chain_spec(chain_id)?;

    // Данные батча: то, что опубликовано в TON, — это сам блок.
    let batch_hash = batch_data_hash(&data_chunks).map_err(|_| EvmBatchError::DataChunkTooLarge)?;
    check_block_data(&alloy_rlp::encode(&block.current_block), &data_chunks)?;

    let body = &block.current_block.body;
    reject_unprotected(&body.transactions)?;
    reject_blobs(&block.current_block)?;
    reject_unsupported_types(&body.transactions)?;
    check_header_policy(&block.current_block.header)?;
    let block_timestamp = block.current_block.header.timestamp;

    // Очередь L1: депозиты отрезка против зачислений блока, хеш очереди после отрезка.
    let credits: &[Withdrawal] = match &body.withdrawals {
        Some(withdrawals) => &withdrawals.0,
        None => &[],
    };
    let new_deposit_hash = check_queue(credits, &queue_items, &prev_deposit_hash)?;

    // Дерево выводов до блока: его корень и счётчик контракт подставит свои.
    let mut tree = WithdrawalTree::from_input(withdrawals_frontier, withdrawals_count)
        .map_err(EvmBatchError::WithdrawalFrontier)?;
    let prev_withdrawals_root = tree.root();

    // Блок: принудительные транзакции отрезка — первыми.
    let forced: Vec<&[u8]> = queue_items
        .iter()
        .filter_map(|item| match item {
            QueueItem::ForcedTransaction(bytes) => Some(bytes.as_slice()),
            QueueItem::Deposit(_) => None,
        })
        .collect();
    let executed = execute::execute_block(chain_spec, block, &forced, forced_gas_cap)?;

    // Выводы: логи моста. Лог от имени моста — доказательство вывода, только если по адресу
    // моста лежит код моста.
    let withdrawals = bridge::bridge_withdrawals(&executed.receipts).map_err(|_| EvmBatchError::MalformedBridgeLog)?;
    if !withdrawals.is_empty() && executed.bridge_code_hash != Some(Some(BRIDGE_CODE_HASH)) {
        return Err(EvmBatchError::BridgeCodeMismatch);
    }
    for leaf in &withdrawals {
        tree.append(leaf).map_err(|_| EvmBatchError::TooManyWithdrawals)?;
    }

    Ok(BatchOutcome {
        values: PublicValues {
            chain_id,
            prev_state_root: executed.parent_hash.0,
            new_state_root: executed.block_hash.0,
            batch_hash,
            prev_withdrawals_root,
            withdrawals_root: tree.root(),
            prev_deposit_hash,
            new_deposit_hash,
            prev_withdrawals_count: withdrawals_count,
            withdrawals_count: tree.count(),
            block_timestamp,
        },
        forced: executed.forced,
        withdrawals,
        withdrawals_frontier: *tree.frontier(),
    })
}
