//! Переход состояния игрушечного L2 — та самая функция, выполнение которой
//! доказывает zkVM. Это НЕ EVM: простой реестр балансов. Его задача — выдавать публичные
//! значения ровно в том формате, который проверяет rollup-контракт на TON
//! (contracts/rollup/logic.tolk):
//!
//!   chainId ‖ prevStateRoot ‖ newStateRoot ‖ batchHash
//!           ‖ prevWithdrawalsRoot ‖ withdrawalsRoot ‖ prevDepositHash ‖ newDepositHash
//!
//! восемь слов по 32 байта. Контракт берёт от них SHA-256, обрезает до 253 бит и
//! подаёт верификатору первым публичным входом — так же считает дайджест SP1.
//!
//! Что именно доказывает пруф:
//!   - идентификатор rollup'а (chainId) — тот, под который подписаны транзакции; контракт
//!     подставляет свой, поэтому пруф одного rollup'а не подойдёт другому;
//!   - транзакции взяты из данных, опубликованных в TON (модуль `data`, DA.md);
//!   - исполнены только транзакции, подписанные владельцем счёта и идущие по порядку его
//!     nonce (модуль `tx`); некорректные пропущены — и из очереди L1, и из данных секвенсора.
//!     Поэтому содержимое опубликованных данных не может сделать батч недоказуемым. Форма
//!     может: порция длиннее MAX_DATA_CHUNK_BYTES или ячейка, разложенная не так, как
//!     `data_chunk_hash`, дают хеш, который программа не воспроизведёт. Публикует данные
//!     только секвенсор, и на этот случай у него есть сброс (DiscardBatchData в контракте);
//!   - дерево выводов продолжено от того корня, который хранит контракт (prevWithdrawalsRoot):
//!     приписать или стереть прежний лист нельзя;
//!   - очередь L1 обработана строго по порядку: депозиты зачислены, принудительные
//!     транзакции исполнены (или пропущены, если некорректны); выводы добавлены в дерево выводов.
#![no_std]

extern crate alloc;

pub mod data;
pub mod tx;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub use data::{batch_data_hash, data_chunk_hash, data_hash_step, MAX_DATA_CHUNK_BYTES};
pub use tx::{
    address_of, decode_transactions, encode_transactions, recover_sender, sign_transaction, signing_hash,
    SignedTransaction, Transaction,
};

pub type Hash = [u8; 32];
pub type L2Address = [u8; 20];

/// Глубина дерева выводов — как WITHDRAWAL_TREE_DEPTH в контракте.
pub const WITHDRAWAL_TREE_DEPTH: usize = 32;
/// Сколько листьев помещается в дерево выводов: номер листа в контракте — uint32.
pub const MAX_WITHDRAWALS: u64 = 1 << WITHDRAWAL_TREE_DEPTH;
/// Число слов публичных значений и их размер в байтах.
pub const PUBLIC_VALUE_WORDS: usize = 8;
pub const PUBLIC_VALUES_BYTES: usize = PUBLIC_VALUE_WORDS * 32;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Account {
    pub address: L2Address,
    pub balance: u128,
    /// Сколько транзакций счёт уже отправил; следующая обязана нести этот номер.
    pub nonce: u64,
}

/// Депозит из очереди L1: то, что контракт положил в накопительный хеш.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Deposit {
    pub l2_recipient: L2Address,
    pub amount: u128,
}

/// Элемент очереди L1→L2. Секвенсор обязан обработать очередь по порядку: это и есть
/// защита от цензуры — то, что попало в очередь на L1, он не может не включить.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum QueueItem {
    Deposit(Deposit),
    /// Транзакция L2, которую пользователь поставил в очередь сам, в обход секвенсора:
    /// байты одной подписанной транзакции в кодировке `encode_transactions`. Контракт их
    /// не разбирает, поэтому здесь может быть что угодно; некорректная транзакция
    /// пропускается, а не делает батч недоказуемым.
    ForcedTransaction(Vec<u8>),
}

/// Метка принудительной транзакции в накопительном хеше очереди: стоит на месте
/// получателя депозита, а получатель депозита — 160 бит, так что спутать их нельзя.
/// Должна совпадать с FORCED_TRANSACTION_MARKER в contracts/rollup/logic.tolk.
const FORCED_TRANSACTION_MARKER: Hash = {
    let mut marker = [0u8; 32];
    marker[0] = 0x80;
    marker
};
/// Принудительная транзакция обязана помещаться в одну ячейку TON без ссылок.
pub const MAX_FORCED_TRANSACTION_BYTES: usize = data::DATA_CELL_BYTES;

/// Уже существующий лист дерева выводов (дерево накопительное).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WithdrawalLeaf {
    pub recipient_hash: Hash,
    pub amount: u128,
}

/// Всё, что нужно для одного батча. Для zkVM это приватный вход.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BatchInput {
    /// Идентификатор rollup'а: попадает в публичные значения и в подпись каждой транзакции.
    pub chain_id: u64,
    /// Состояние до батча, отсортированное по адресу.
    pub accounts: Vec<Account>,
    /// Накопительный хеш очереди депозитов на момент предыдущего батча.
    pub prev_deposit_hash: Hash,
    /// Элементы очереди L1 (депозиты и принудительные транзакции), которые батч обязан
    /// обработать, в порядке очереди.
    pub queue_items: Vec<QueueItem>,
    /// Порции данных батча в том виде и порядке, в каком они опубликованы в TON.
    /// Транзакции — это их склейка в кодировке `encode_transactions`.
    pub data_chunks: Vec<Vec<u8>>,
    /// Все выводы предыдущих батчей, по порядку номеров листьев.
    pub prior_withdrawals: Vec<WithdrawalLeaf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicValues {
    pub chain_id: u64,
    pub prev_state_root: Hash,
    pub new_state_root: Hash,
    pub batch_hash: Hash,
    /// Корень дерева выводов до батча: контракт подставляет свой, поэтому прежние выводы
    /// (приватный вход программы) обязаны быть теми самыми, что уже приняты на L1.
    pub prev_withdrawals_root: Hash,
    pub withdrawals_root: Hash,
    pub prev_deposit_hash: Hash,
    pub new_deposit_hash: Hash,
}

impl PublicValues {
    /// 256 байт в порядке, зафиксированном протоколом.
    pub fn to_bytes(&self) -> [u8; PUBLIC_VALUES_BYTES] {
        let mut out = [0u8; PUBLIC_VALUES_BYTES];
        let chain_word = word(self.chain_id as u128);
        let words = [
            &chain_word,
            &self.prev_state_root,
            &self.new_state_root,
            &self.batch_hash,
            &self.prev_withdrawals_root,
            &self.withdrawals_root,
            &self.prev_deposit_hash,
            &self.new_deposit_hash,
        ];
        for (i, word) in words.iter().enumerate() {
            out[i * 32..(i + 1) * 32].copy_from_slice(*word);
        }
        out
    }

    /// Первый публичный вход верификатора: SHA-256, обрезанный до 253 бит.
    pub fn digest(&self) -> Hash {
        let mut digest = sha256(&[&self.to_bytes()]);
        digest[0] &= 0x1f;
        digest
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum BatchError {
    /// Счета во входе не отсортированы строго по адресу (или есть дубликат).
    AccountsNotSorted,
    /// Причины, по которым отдельная транзакция не исполняется. Батч они не ломают:
    /// такая транзакция пропускается.
    InsufficientBalance,
    BalanceOverflow,
    /// У адреса, восстановленного из подписи, нет счёта.
    UnknownSender,
    /// Подпись не разбирается или из неё не восстанавливается ключ.
    BadSignature,
    /// Номер транзакции не совпал с nonce счёта: повтор или пропуск.
    BadNonce,
    /// Байты не разбираются как транзакция.
    MalformedData,
    /// Порция длиннее, чем помещается в одно сообщение TON.
    DataChunkTooLarge,
    /// Принудительная транзакция длиннее одной ячейки: контракт такую в очередь не ставит.
    ForcedTransactionTooLarge,
    /// Перевод или вывод нулевой суммы: ничего не двигает, но оставил бы вечную запись
    /// (пустой счёт или лист дерева выводов). Пропускается, как любая некорректная транзакция.
    ZeroAmount,
    /// В дереве выводов не осталось листьев (2^32). Вывод пропускается; для прежних выводов
    /// во входе батча это ошибка батча.
    WithdrawalTreeFull,
}

pub fn sha256(parts: &[&[u8]]) -> Hash {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// Число как 32-байтовое слово (big-endian) — так его хеширует контракт.
fn word(value: u128) -> Hash {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&value.to_be_bytes());
    out
}

fn address_word(address: &L2Address) -> Hash {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(address);
    out
}

/// Состояние счёта внутри батча.
#[derive(Clone, Copy, Default)]
struct AccountState {
    balance: u128,
    nonce: u64,
}

type Ledger = BTreeMap<L2Address, AccountState>;

/// Корень состояния: хеш отсортированного списка (адрес, баланс, nonce). Для игрушечного
/// реестра этого достаточно; у настоящего L2 здесь будет дерево состояния EVM.
fn ledger_root(ledger: &Ledger) -> Hash {
    let mut hasher = Sha256::new();
    hasher.update((ledger.len() as u64).to_be_bytes());
    for (address, account) in ledger {
        hasher.update(address);
        hasher.update(account.balance.to_be_bytes());
        hasher.update(account.nonce.to_be_bytes());
    }
    hasher.finalize().into()
}

/// Счета идут строго по возрастанию адреса — значит, и без дубликатов.
pub fn is_strictly_sorted(accounts: &[Account]) -> bool {
    accounts.windows(2).all(|pair| pair[0].address < pair[1].address)
}

/// Корень состояния для списка счетов, строго отсортированного по адресу; `None` для любого
/// другого списка. Отказ принципиален: у списка с дубликатом адреса «корень» совпал бы с
/// корнем честного состояния, а сам список содержал бы приписанный баланс.
pub fn state_root(accounts: &[Account]) -> Option<Hash> {
    if !is_strictly_sorted(accounts) {
        return None;
    }
    Some(ledger_root(
        &accounts.iter().map(|a| (a.address, AccountState { balance: a.balance, nonce: a.nonce })).collect(),
    ))
}

/// Шаг накопительного хеша очереди депозитов — как handleDeposit в контракте.
pub fn deposit_hash(previous: &Hash, deposit: &Deposit) -> Hash {
    sha256(&[previous, &address_word(&deposit.l2_recipient), &word(deposit.amount)])
}

/// Шаг накопительного хеша очереди для принудительной транзакции — как
/// handleForceTransaction в контракте: вместо получателя — метка, вместо суммы — хеш
/// ячейки с байтами транзакции.
pub fn forced_transaction_hash(previous: &Hash, transaction_bytes: &[u8]) -> Hash {
    sha256(&[previous, &FORCED_TRANSACTION_MARKER, &data_chunk_hash(transaction_bytes)])
}

pub fn withdrawal_leaf_hash(leaf_index: u32, leaf: &WithdrawalLeaf) -> Hash {
    sha256(&[&word(leaf_index as u128), &leaf.recipient_hash, &word(leaf.amount)])
}

/// Корень дерева выводов: листья стоят подряд с нуля, остальное — пустые поддеревья
/// (пустой лист — 32 нулевых байта, узел — sha256(левый ‖ правый)). Корень дерева
/// без листьев контракт хранит как ноль.
pub fn withdrawals_root(leaves: &[WithdrawalLeaf]) -> Hash {
    if leaves.is_empty() {
        return [0u8; 32];
    }
    let mut level: Vec<Hash> = leaves
        .iter()
        .enumerate()
        .map(|(index, leaf)| withdrawal_leaf_hash(index as u32, leaf))
        .collect();
    let mut empty = [0u8; 32];
    for _ in 0..WITHDRAWAL_TREE_DEPTH {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for pair in level.chunks(2) {
            let right = if pair.len() == 2 { &pair[1] } else { &empty };
            next.push(sha256(&[&pair[0], right]));
        }
        empty = sha256(&[&empty, &empty]);
        level = next;
    }
    level[0]
}

fn credit(ledger: &mut Ledger, to: &L2Address, amount: u128) -> Result<(), BatchError> {
    let account = ledger.entry(*to).or_default();
    account.balance = account.balance.checked_add(amount).ok_or(BatchError::BalanceOverflow)?;
    Ok(())
}

/// Исполняет одну подписанную транзакцию. Либо применяет её целиком, либо ничего не
/// меняет и возвращает причину отказа: сначала все проверки, потом изменения.
fn apply_transaction(
    ledger: &mut Ledger,
    withdrawals: &mut Vec<WithdrawalLeaf>,
    chain_id: u64,
    signed: &SignedTransaction,
) -> Result<(), BatchError> {
    let sender = recover_sender(chain_id, signed)?;
    let account = *ledger.get(&sender).ok_or(BatchError::UnknownSender)?;
    if account.nonce != signed.nonce {
        return Err(BatchError::BadNonce);
    }
    let amount = match signed.transaction {
        Transaction::Transfer { amount, .. } | Transaction::Withdraw { amount, .. } => amount,
    };
    if amount == 0 {
        return Err(BatchError::ZeroAmount);
    }
    if matches!(signed.transaction, Transaction::Withdraw { .. }) && withdrawals.len() as u64 >= MAX_WITHDRAWALS {
        return Err(BatchError::WithdrawalTreeFull);
    }
    let debited = AccountState {
        balance: account.balance.checked_sub(amount).ok_or(BatchError::InsufficientBalance)?,
        nonce: account.nonce + 1,
    };
    match &signed.transaction {
        Transaction::Transfer { to, .. } if *to == sender => {
            // Перевод самому себе: меняется только nonce.
            ledger.insert(sender, AccountState { balance: account.balance, nonce: debited.nonce });
        }
        Transaction::Transfer { to, .. } => {
            let recipient = ledger.get(to).copied().unwrap_or_default();
            let credited = recipient.balance.checked_add(amount).ok_or(BatchError::BalanceOverflow)?;
            ledger.insert(sender, debited);
            ledger.insert(*to, AccountState { balance: credited, nonce: recipient.nonce });
        }
        Transaction::Withdraw { l1_recipient_hash, .. } => {
            ledger.insert(sender, debited);
            withdrawals.push(WithdrawalLeaf { recipient_hash: *l1_recipient_hash, amount });
        }
    }
    Ok(())
}

/// Принудительная транзакция из очереди L1: исполняется, если это ровно одна корректная
/// подписанная транзакция, и молча пропускается иначе. Пропуск обязателен: в очередь может
/// поставить что угодно кто угодно, и мусор не должен останавливать rollup.
fn apply_forced_transaction(
    ledger: &mut Ledger,
    withdrawals: &mut Vec<WithdrawalLeaf>,
    chain_id: u64,
    bytes: &[u8],
) {
    let (decoded, well_formed) = decode_transactions(core::slice::from_ref(&bytes.to_vec()));
    if let ([signed], true) = (decoded.as_slice(), well_formed) {
        let _skipped_if_invalid = apply_transaction(ledger, withdrawals, chain_id, signed);
    }
}

/// Применяет батч и возвращает публичные значения и новое состояние.
/// Любая ошибка означает, что батч некорректен и пруфа для него быть не должно.
pub fn apply_batch(input: &BatchInput) -> Result<(PublicValues, Vec<Account>, Vec<WithdrawalLeaf>), BatchError> {
    let batch_hash = batch_data_hash(&input.data_chunks)?;
    apply_batch_with_data_hash(input, batch_hash)
}

/// То же, но хеш данных уже посчитан вызывающим (`batch_data_hash`). Разделено, чтобы
/// гостевая программа могла отдельно замерить цену привязки к данным.
pub fn apply_batch_with_data_hash(
    input: &BatchInput,
    batch_hash: Hash,
) -> Result<(PublicValues, Vec<Account>, Vec<WithdrawalLeaf>), BatchError> {
    if !is_strictly_sorted(&input.accounts) {
        return Err(BatchError::AccountsNotSorted);
    }
    let mut ledger: Ledger = input
        .accounts
        .iter()
        .map(|account| (account.address, AccountState { balance: account.balance, nonce: account.nonce }))
        .collect();
    let prev_state_root = ledger_root(&ledger);
    // Номер листа — 32 бита: список длиннее дерева дал бы повторяющиеся номера.
    if input.prior_withdrawals.len() as u64 > MAX_WITHDRAWALS {
        return Err(BatchError::WithdrawalTreeFull);
    }

    // Очередь L1 — строго по порядку, с тем же накопительным хешем, что в контракте.
    let prev_withdrawals_root = withdrawals_root(&input.prior_withdrawals);
    let mut withdrawals = input.prior_withdrawals.clone();
    let mut new_deposit_hash = input.prev_deposit_hash;
    for item in &input.queue_items {
        match item {
            QueueItem::Deposit(deposit) => {
                new_deposit_hash = deposit_hash(&new_deposit_hash, deposit);
                credit(&mut ledger, &deposit.l2_recipient, deposit.amount)?;
            }
            QueueItem::ForcedTransaction(bytes) => {
                if bytes.len() > MAX_FORCED_TRANSACTION_BYTES {
                    return Err(BatchError::ForcedTransactionTooLarge);
                }
                new_deposit_hash = forced_transaction_hash(&new_deposit_hash, bytes);
                apply_forced_transaction(&mut ledger, &mut withdrawals, input.chain_id, bytes);
            }
        }
    }

    // Транзакции секвенсора из данных батча. Некорректная транзакция пропускается, а хвост
    // данных, который не разбирается, отбрасывается: каким бы ни было содержимое порций —
    // дубль порции, транзакция, которую уже исполнила очередь L1, просто мусор, — батч
    // остаётся доказуемым. Иначе rollup мог бы остановить кто угодно, поставив в очередь
    // копию транзакции из заранее опубликованных данных. (Порцию недопустимой формы
    // отвергает `batch_data_hash` выше; это ошибка секвенсора, и исправляет её он сам.)
    let (transactions, _whole_data_parsed) = decode_transactions(&input.data_chunks);
    for signed in &transactions {
        let _skipped_if_invalid = apply_transaction(&mut ledger, &mut withdrawals, input.chain_id, signed);
    }

    let public_values = PublicValues {
        chain_id: input.chain_id,
        prev_state_root,
        new_state_root: ledger_root(&ledger),
        batch_hash,
        prev_withdrawals_root,
        withdrawals_root: withdrawals_root(&withdrawals),
        prev_deposit_hash: input.prev_deposit_hash,
        new_deposit_hash,
    };
    let new_accounts = ledger
        .into_iter()
        .map(|(address, account)| Account { address, balance: account.balance, nonce: account.nonce })
        .collect();
    Ok((public_values, new_accounts, withdrawals))
}

#[cfg(test)]
mod tests;
