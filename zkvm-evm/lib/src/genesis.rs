//! Генезис цепочки L2 — закреплён целиком (`PROTOCOL-V2.md`, раздел 7 и правка 0.4).
//!
//! В состоянии генезиса один счёт — мост (`bridge.rs`): код моста, nonce 1, баланс 0. Других
//! счетов нет, поэтому все монеты L2 появляются только из депозитов. Хеш заголовка генезиса —
//! константа протокола, от `chainId` не зависит; контракт на TON сверяет с ней начальное слово
//! состояния при фиксации ключа (`GENESIS_HASH` в contracts/rollup/logic.tolk).
//!
//! Программа эту константу не читает: первый батч обязан продолжать блок с этим хешем потому,
//! что контракт подставляет его в дайджест как `prevStateRoot`. Здесь она — для сборщика
//! генезиса, хоста и тестов (тест пересчитывает и корень состояния, и хеш заголовка).
use alloy_consensus::{constants::EMPTY_ROOT_HASH, Header, EMPTY_OMMER_ROOT_HASH};
use alloy_primitives::{b256, Address, Bloom, Bytes, B256, B64, U256};

use crate::GAS_LIMIT;

/// Базовая комиссия генезиса: 1 gwei, то есть 1 нанотон за единицу газа.
pub const GENESIS_BASE_FEE: u64 = 1_000_000_000;

/// Корень состояния генезиса: дерево из одного счёта — моста.
pub const GENESIS_STATE_ROOT: B256 = b256!("01635824b7294796d2a6b1fd3485a3083ef24d56fa956ca9d72c3b3c71df252a");

/// Хеш заголовка генезиса — `GENESIS_HASH` контракта.
pub const GENESIS_HASH: B256 = b256!("c0284e91570e7f1314f6e4460a613225f49b46deeebd2be3c463fb1c1e0e7883");

/// Заголовок генезиса: время 0, закреплённый лимит газа, правила по Cancun с нулевого блока.
pub fn genesis_header() -> Header {
    Header {
        parent_hash: B256::ZERO,
        ommers_hash: EMPTY_OMMER_ROOT_HASH,
        beneficiary: Address::ZERO,
        state_root: GENESIS_STATE_ROOT,
        transactions_root: EMPTY_ROOT_HASH,
        receipts_root: EMPTY_ROOT_HASH,
        logs_bloom: Bloom::ZERO,
        difficulty: U256::ZERO,
        number: 0,
        gas_limit: GAS_LIMIT,
        gas_used: 0,
        timestamp: 0,
        extra_data: Bytes::new(),
        mix_hash: B256::ZERO,
        nonce: B64::ZERO,
        base_fee_per_gas: Some(GENESIS_BASE_FEE),
        withdrawals_root: Some(EMPTY_ROOT_HASH),
        blob_gas_used: Some(0),
        excess_blob_gas: Some(0),
        parent_beacon_block_root: Some(B256::ZERO),
        ..Default::default()
    }
}
