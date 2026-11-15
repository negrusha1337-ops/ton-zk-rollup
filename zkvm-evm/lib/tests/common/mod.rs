//! Общее для тестов батча EVM: тестовые ключи и сборка подписанных транзакций.
//!
//! Ключи — заведомо тестовые константы (байт, повторённый 32 раза); монет на таких счетах в
//! цепочке сценария нет. Счета сценария подписывает сам сценарий одноразовыми ключами.
#![allow(dead_code)]

use alloy_consensus::{SignableTransaction, TxEip1559};
use alloy_eips::eip2718::Encodable2718;
use alloy_primitives::{keccak256, Address, Bytes, Signature, TxKind, U256};
use k256::ecdsa::SigningKey;
use reth_ethereum_primitives::TransactionSigned;
use rollup_evm::{Hash, BRIDGE_ADDRESS, WEI_PER_NANOTON};

pub const CHAIN_ID: u64 = 362107787851;

/// Порядок группы secp256k1.
pub fn curve_order() -> U256 {
    "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141".parse().unwrap()
}

pub fn key(byte: u8) -> SigningKey {
    SigningKey::from_slice(&[byte; 32]).unwrap()
}

pub fn address_of(key: &SigningKey) -> Address {
    let point = key.verifying_key().to_encoded_point(false);
    Address::from_slice(&keccak256(&point.as_bytes()[1..])[12..])
}

/// Подпись транзакции (s — в нижней половине, как у обычных кошельков).
pub fn signature_of<T: SignableTransaction<Signature>>(key: &SigningKey, transaction: &T) -> Signature {
    let (signature, recovery) = key.sign_prehash_recoverable(transaction.signature_hash().as_slice()).unwrap();
    Signature::new(
        U256::from_be_slice(&signature.r().to_bytes()),
        U256::from_be_slice(&signature.s().to_bytes()),
        recovery.is_y_odd(),
    )
}

pub fn sign<T>(key: &SigningKey, transaction: T) -> TransactionSigned
where
    T: SignableTransaction<Signature>,
    TransactionSigned: From<alloy_consensus::Signed<T>>,
{
    let signature = signature_of(key, &transaction);
    transaction.into_signed(signature).into()
}

/// Та же подпись с s в верхней половине: математически верна, но запрещена EIP-2.
pub fn sign_high_s<T>(key: &SigningKey, transaction: T) -> TransactionSigned
where
    T: SignableTransaction<Signature>,
    TransactionSigned: From<alloy_consensus::Signed<T>>,
{
    let signature = signature_of(key, &transaction);
    let flipped = Signature::new(signature.r(), curve_order() - signature.s(), !signature.v());
    transaction.into_signed(flipped).into()
}

pub fn encoded(transaction: &TransactionSigned) -> Vec<u8> {
    transaction.encoded_2718()
}

/// Вывод через мост: вызов моста с хешем получателя в данных и суммой в нанотонах.
pub fn bridge_call(nonce: u64, nanotons: u64, recipient: Hash) -> TxEip1559 {
    TxEip1559 {
        chain_id: CHAIN_ID,
        nonce,
        gas_limit: 40_000,
        max_fee_per_gas: 2_000_000_000,
        max_priority_fee_per_gas: 1_000_000_000,
        to: TxKind::Call(BRIDGE_ADDRESS),
        value: U256::from(nanotons) * U256::from(WEI_PER_NANOTON),
        input: Bytes::copy_from_slice(&recipient),
        access_list: Default::default(),
    }
}
