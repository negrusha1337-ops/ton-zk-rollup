//! Батч rollup'а на EVM: один блок EVM, исполненный Reth, и те же восемь слов публичных
//! значений, которые проверяет контракт на TON (`zkvm/lib`, `contracts/rollup/`).
//!
//! Что означают слова для EVM:
//!
//!   chainId             — идентификатор цепочки; им подписана каждая транзакция блока
//!   prevStateRoot       — ХЕШ ЗАГОЛОВКА РОДИТЕЛЯ (не корень состояния)
//!   newStateRoot        — ХЕШ ЗАГОЛОВКА БЛОКА
//!   batchHash           — накопительный хеш порций данных; порции — RLP блока целиком
//!   prevWithdrawalsRoot — корень дерева выводов до блока
//!   withdrawalsRoot     — корень дерева выводов после блока
//!   prevDepositHash     — накопительный хеш очереди L1 до блока
//!   newDepositHash      — он же после блока
//!
//! Почему хеш блока, а не корень состояния. Блок проверяется относительно заголовка родителя
//! (номер, время, базовая комиссия, лимит газа), а этот заголовок даёт доказывающий. Если бы
//! контракт хранил только корень состояния, секвенсор мог бы подставить родителя с любыми
//! номером и временем при том же корне. Хеш заголовка обязывает ко всему заголовку сразу, а
//! через него — и к корню состояния.
//!
//! Правила цепочки (набор хардфорков) зашиты в программу — `chain_config`. В RSP их задаёт вход
//! доказывающего и в публичные значения они не попадают; здесь поля `genesis`,
//! `custom_beneficiary` и `opcode_tracking` входа блока не читаются вовсе.
//!
//! Депозиты L1→L2 — список зачислений блока (EIP-4895, «withdrawals» в терминах Ethereum): EVM
//! начисляет их без транзакций. Список обязан совпасть с очередью L1 элемент в элемент.
//! Выводы L2→L1 — успешные переводы на `BRIDGE_ADDRESS` с получателем TON в данных.
//!
//! Чего здесь НЕТ (спайк):
//!   * принудительных транзакций L2: батч с таким элементом очереди недоказуем
//!     (`ForcedTransactionsNotSupported`), то есть защиты от цензуры транзакций пока нет;
//!   * выводов из контрактов (только прямой перевод на адрес моста);
//!   * проверки, что по адресу моста нет кода и что в генезисе нет необеспеченных балансов:
//!     и то и другое задаётся генезисом, сверка генезиса — на пользователе;
//!   * привязки времени блока ко времени L1: время обязано только расти, и блок со временем
//!     у верхней границы остановил бы цепочку;
//!   * аварийного выхода для состояния EVM.
use std::{fmt, sync::Arc};

use alloy_consensus::{Block, Transaction, TxType};
use alloy_eips::eip4895::Withdrawal;
use alloy_genesis::ChainConfig;
use alloy_primitives::{Address, U256};
use reth_chainspec::{ChainSpec, NamedChain};
use reth_ethereum_primitives::TransactionSigned;
use rollup_stf::{batch_data_hash, deposit_hash, withdrawals_root, MAX_DATA_CHUNK_BYTES, MAX_WITHDRAWALS};
use rsp_client_executor::io::EthClientExecutorInput;
use rsp_primitives::genesis::Genesis;
use serde::{Deserialize, Serialize};

mod execute;
#[cfg(test)]
mod tests;
pub mod witness;

pub use execute::{execute_block, ExecutedBlock};
pub use rollup_stf::{Deposit, Hash, PublicValues, QueueItem, WithdrawalLeaf};

/// Адрес моста L2→L1: 20 байт строки «ton-zk-rollup-bridge». Ключа к нему нет ни у кого, поэтому
/// переведённое на него остаётся там навсегда — это и есть сжигание при выводе.
pub const BRIDGE_ADDRESS: Address = Address::new(*b"ton-zk-rollup-bridge");

/// 1 нанотон на L1 = 1 gwei на L2: у монеты L2 18 знаков, как у ETH, и 1 TON = 1 целая монета.
/// Зачисления EIP-4895 считаются в gwei, так что депозит ложится в них без пересчёта.
pub const WEI_PER_NANOTON: u64 = 1_000_000_000;

/// Всё, что нужно для одного батча. Для zkVM это приватный вход.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvmBatchInput {
    /// Идентификатор rollup'а: первое слово публичных значений и часть подписи каждой транзакции.
    pub chain_id: u64,
    /// Блок, заголовки предков и свидетель состояния родителя — в формате RSP.
    pub block: EthClientExecutorInput,
    /// Накопительный хеш очереди L1 на момент предыдущего батча.
    pub prev_deposit_hash: Hash,
    /// Элементы очереди L1, которые блок обязан обработать, в порядке очереди.
    pub queue_items: Vec<QueueItem>,
    /// Порции данных батча в том виде и порядке, в каком они опубликованы в TON. Их склейка
    /// обязана быть RLP блока.
    pub data_chunks: Vec<Vec<u8>>,
    /// Все выводы предыдущих батчей, по порядку номеров листьев.
    pub prior_withdrawals: Vec<WithdrawalLeaf>,
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
    /// В очереди L1 принудительная транзакция: в спайке не поддержано.
    ForcedTransactionsNotSupported,
    /// Число зачислений в блоке не равно числу элементов очереди.
    DepositCountMismatch { block: usize, queue: usize },
    /// Зачисление с этим номером не совпало с элементом очереди.
    DepositMismatch(usize),
    /// Сумма депозита не помещается в зачисление (64 бита gwei).
    DepositTooLarge(usize),
    /// Транзакция без `chainId` в подписи: её можно было бы повторить в другой цепочке.
    UnprotectedTransaction(usize),
    /// В блоке blob-транзакция либо ненулевой расход или избыток blob-газа: блобов у rollup'а нет.
    BlobsNotSupported,
    /// Тип транзакции вне списка допустимых (обычная, EIP-2930, EIP-1559).
    UnsupportedTransactionType(usize),
    /// В дереве выводов кончились листья.
    TooManyWithdrawals,
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
    /// Квитанций меньше, чем транзакций.
    ReceiptCountMismatch,
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

/// Сверяет зачисления блока с очередью L1 и возвращает накопительный хеш очереди после них.
///
/// Зачисление i обязано быть ровно депозитом i из очереди: тот же получатель, та же сумма
/// (нанотоны = gwei), номер зачисления — его место в блоке, номер валидатора — ноль. Лишнее
/// зачисление — это монеты из воздуха, пропущенное — украденный депозит; ни то ни другое не
/// даёт хеш очереди, который ждёт контракт, но проверка здесь явная и не полагается на это.
pub fn check_deposits(
    credits: &[Withdrawal],
    queue_items: &[QueueItem],
    prev_deposit_hash: &Hash,
) -> Result<Hash, EvmBatchError> {
    if credits.len() != queue_items.len() {
        return Err(EvmBatchError::DepositCountMismatch {
            block: credits.len(),
            queue: queue_items.len(),
        });
    }
    let mut hash = *prev_deposit_hash;
    for (index, (credit, item)) in credits.iter().zip(queue_items).enumerate() {
        let QueueItem::Deposit(deposit) = item else {
            return Err(EvmBatchError::ForcedTransactionsNotSupported);
        };
        let amount =
            u64::try_from(deposit.amount).map_err(|_| EvmBatchError::DepositTooLarge(index))?;
        if credit.index != index as u64 ||
            credit.validator_index != 0 ||
            credit.address != Address::from(deposit.l2_recipient) ||
            credit.amount != amount
        {
            return Err(EvmBatchError::DepositMismatch(index));
        }
        hash = deposit_hash(&hash, deposit);
    }
    Ok(hash)
}

/// Заявка на вывод, если транзакция — перевод на мост по правилам: получатель — адрес моста,
/// данные — ровно 32 байта (хеш получателя в TON), сумма ненулевая и кратна нанотону.
/// Перевод на мост не по правилам вывода не создаёт: монеты остаются на адресе моста.
/// Состоялся ли перевод, решает квитанция — см. `apply_evm_batch`.
pub fn bridge_withdrawal(transaction: &TransactionSigned) -> Option<WithdrawalLeaf> {
    if transaction.to() != Some(BRIDGE_ADDRESS) {
        return None;
    }
    let data: &[u8] = transaction.input();
    let recipient_hash = Hash::try_from(data).ok()?;
    let value = transaction.value();
    let unit = U256::from(WEI_PER_NANOTON);
    if value.is_zero() || !(value % unit).is_zero() {
        return None;
    }
    let amount = u128::try_from(value / unit).ok()?;
    Some(WithdrawalLeaf { recipient_hash, amount })
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

/// Применяет батч: проверяет блок целиком и возвращает публичные значения.
pub fn apply_evm_batch(input: EvmBatchInput) -> Result<PublicValues, EvmBatchError> {
    let EvmBatchInput { chain_id, block, prev_deposit_hash, queue_items, data_chunks, prior_withdrawals } =
        input;
    let chain_spec = chain_spec(chain_id)?;

    // Данные батча: то, что опубликовано в TON, — это сам блок.
    let batch_hash =
        batch_data_hash(&data_chunks).map_err(|_| EvmBatchError::DataChunkTooLarge)?;
    check_block_data(&alloy_rlp::encode(&block.current_block), &data_chunks)?;

    let body = &block.current_block.body;
    reject_unprotected(&body.transactions)?;
    reject_blobs(&block.current_block)?;
    reject_unsupported_types(&body.transactions)?;

    // Депозиты: зачисления блока против очереди L1.
    let credits: &[Withdrawal] = match &body.withdrawals {
        Some(withdrawals) => &withdrawals.0,
        None => &[],
    };
    let new_deposit_hash = check_deposits(credits, &queue_items, &prev_deposit_hash)?;

    // Кандидаты в выводы: место транзакции в блоке и лист. Окончательно — после исполнения.
    let candidates: Vec<(usize, WithdrawalLeaf)> = body
        .transactions
        .iter()
        .enumerate()
        .filter_map(|(index, transaction)| bridge_withdrawal(transaction).map(|leaf| (index, leaf)))
        .collect();

    let executed = execute_block(chain_spec, block)?;

    // Выводы: только состоявшиеся переводы. Неуспешная транзакция монет не перевела — вывод по
    // ней был бы выплатой на L1 без сжигания на L2.
    let prev_withdrawals_root = withdrawals_root(&prior_withdrawals);
    let mut leaves = prior_withdrawals;
    for (index, leaf) in candidates {
        let receipt = executed.receipts.get(index).ok_or(EvmBatchError::ReceiptCountMismatch)?;
        if receipt.success {
            leaves.push(leaf);
        }
    }
    if leaves.len() as u64 > MAX_WITHDRAWALS {
        return Err(EvmBatchError::TooManyWithdrawals);
    }

    Ok(PublicValues {
        chain_id,
        prev_state_root: executed.parent_hash.0,
        new_state_root: executed.block_hash.0,
        batch_hash,
        prev_withdrawals_root,
        withdrawals_root: withdrawals_root(&leaves),
        prev_deposit_hash,
        new_deposit_hash,
    })
}
