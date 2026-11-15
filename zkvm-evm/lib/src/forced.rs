//! Принудительные транзакции L2: проверка формы (`PROTOCOL-V2.md`, раздел 3 с правками 0.1).
//!
//! Элемент очереди L1 — произвольные байты: контракт их не разбирает. Принцип: ни одно свойство
//! элемента, которое контракт не проверяет, не может быть ошибкой батча — иначе любой прохожий
//! одним элементом очереди сделал бы батч недоказуемым. Поэтому всё, что не годится по форме,
//! ПРОПУСКАЕТСЯ: элемент входит в хеш очереди, а в блоке его нет.
//!
//! Годна по форме только транзакция вывода через мост: получатель — `BRIDGE_ADDRESS`, лимит
//! газа не больше `FORCED_TX_GAS_CAP`, длина не больше `FORCED_TX_MAX_BYTES`. Исполняется при
//! этом только код моста, и цена такого элемента для прувера известна заранее. Произвольный
//! вызов принудительным быть не может: плата за место в очереди берётся за штуку, а вес
//! произвольного кода для прувера — нет.
//!
//! Предел длины — из замера (bench/evm-v2-cycles.json). Контракт ставит в очередь до 8 128 байт,
//! и без предела разбор, сверка кодировки и хеш подписи такой транзакции стоили пруверу около
//! 0,4 млн циклов за элемент — вдвое дороже ВКЛЮЧЁННОГО вывода и за ту же плату за место.
//! Вызов моста с 32 байтами данных не длиннее 212 байт при любых значениях полей. Слишком
//! длинный элемент — пропуск, а не ошибка батча: контракт его длину не ограничивает.
//!
//! Годную по форме транзакцию исполняет `execute.rs`; там же решается, действительна ли она на
//! состоянии в этот момент (nonce, баланс, цена) — тем же кодом revm, которым это решает узел.
use alloy_consensus::{transaction::SignerRecoverable, Transaction, TxType};
use alloy_eips::eip2718::{Decodable2718, Encodable2718};
use alloy_primitives::Address;
use reth_ethereum_primitives::TransactionSigned;
use reth_primitives_traits::Recovered;

use crate::{BRIDGE_ADDRESS, FORCED_TX_MAX_BYTES};

/// Почему элемент очереди не стал транзакцией блока.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    /// Длиннее `FORCED_TX_MAX_BYTES`: такой элемент не разбирается вовсе.
    TooLong,
    /// Байты не разбираются как одна транзакция EIP-2718 (мусор, хвост после транзакции).
    Undecodable,
    /// Тип транзакции вне списка: обычная, EIP-2930, EIP-1559.
    UnsupportedType,
    /// В подписи нет `chainId` (обычная транзакция до EIP-155).
    MissingChainId,
    /// `chainId` другой цепочки.
    ForeignChainId,
    /// Создание контракта.
    Create,
    /// Получатель — не мост.
    NotBridgeCall,
    /// Лимит газа выше `FORCED_TX_GAS_CAP`.
    GasLimitAboveCap,
    /// Кодировка не каноническая: разобранная транзакция кодируется в другие байты.
    NonCanonicalEncoding,
    /// Подпись не восстанавливается (в том числе `s` в верхней половине, EIP-2).
    Signature,
    /// Недействительна на состоянии в момент исполнения — причина со слов revm.
    Invalid(InvalidReason),
}

/// Причины отказа revm, достижимые для транзакции, годной по форме. Перечень закрытый: всё
/// прочее из `InvalidTransaction` — ошибка батча (`execute.rs`, `classify_invalid`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvalidReason {
    NonceTooLow,
    NonceTooHigh,
    /// Nonce транзакции — наибольшее значение u64.
    NonceOverflow,
    /// Баланса не хватает на `gas_limit × цена + value` (в том числе счёта нет вовсе).
    LackOfFunds,
    /// `gas_limit × цена + value` не помещается в 256 бит.
    PaymentOverflow,
    /// У отправителя есть код (EIP-3607).
    SenderHasCode,
    /// Цена газа ниже базовой комиссии блока.
    GasPriceBelowBaseFee,
    /// Чаевые выше наибольшей цены (EIP-1559).
    PriorityFeeAboveMaxFee,
    /// Лимита газа не хватает на саму транзакцию (intrinsic gas).
    IntrinsicGas,
}

/// Что стало с принудительной транзакцией из очереди.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForcedOutcome {
    /// Исполнена и стоит в блоке на своём месте.
    Included,
    Skipped(SkipReason),
}

/// Проверка формы. Возвращает транзакцию с восстановленным отправителем либо причину пропуска.
///
/// Порядок проверок — от дешёвых к дорогим: длина первой, восстановление подписи последним,
/// чтобы мусор в очереди стоил пруверу как можно меньше. На результат («годна / пропуск»)
/// порядок не влияет.
pub fn decode_forced_transaction(
    bytes: &[u8],
    chain_id: u64,
    gas_cap: u64,
) -> Result<Recovered<TransactionSigned>, SkipReason> {
    if bytes.len() > FORCED_TX_MAX_BYTES {
        return Err(SkipReason::TooLong);
    }
    let transaction = TransactionSigned::decode_2718_exact(bytes).map_err(|_| SkipReason::Undecodable)?;
    if !matches!(transaction.tx_type(), TxType::Legacy | TxType::Eip2930 | TxType::Eip1559) {
        return Err(SkipReason::UnsupportedType);
    }
    match transaction.chain_id() {
        None => return Err(SkipReason::MissingChainId),
        Some(id) if id != chain_id => return Err(SkipReason::ForeignChainId),
        Some(_) => {}
    }
    match transaction.to() {
        None => return Err(SkipReason::Create),
        Some(to) if to != BRIDGE_ADDRESS => return Err(SkipReason::NotBridgeCall),
        Some(_) => {}
    }
    if transaction.gas_limit() > gas_cap {
        return Err(SkipReason::GasLimitAboveCap);
    }
    // Декодер может быть снисходительнее кодировщика. С транзакцией блока элемент сравнивается
    // побайтно, и узел получит ровно байты из очереди: неканоническую кодировку в блок не
    // поставить, значит и требовать её нельзя.
    if transaction.encoded_2718() != bytes {
        return Err(SkipReason::NonCanonicalEncoding);
    }
    // Тем же способом, каким восстанавливаются отправители транзакций блока (`execute.rs`).
    let signer: Address = transaction.recover_signer().map_err(|_| SkipReason::Signature)?;
    Ok(Recovered::new_unchecked(transaction, signer))
}
