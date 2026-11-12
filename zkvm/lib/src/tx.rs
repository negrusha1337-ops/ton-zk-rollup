//! Транзакции игрушечного L2: кодировка в данных батча и подписи.
//!
//! Счета устроены как в Ethereum: адрес — последние 20 байт keccak256 от открытого ключа
//! secp256k1, отправитель транзакции не передаётся, а восстанавливается из подписи.
//! Подпись покрывает идентификатор rollup'а и порядковый номер (nonce) счёта, поэтому
//! транзакцию нельзя ни подделать, ни повторить, ни перенести в другой rollup.
use alloc::vec::Vec;
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use sha3::{Digest, Keccak256};

use crate::{BatchError, Hash, L2Address};

/// Метка назначения подписи: подпись транзакции L2 нельзя выдать за подпись чего-то ещё.
const SIGNING_TAG: &[u8] = b"ton-zk-rollup:toy-tx:v1";

const TAG_TRANSFER: u8 = 0;
const TAG_WITHDRAW: u8 = 1;
pub const SIGNATURE_BYTES: usize = 65;
/// Тег, nonce (u64), цель, сумма (u128) — всё big-endian; затем подпись r ‖ s ‖ v.
const TRANSFER_BODY_BYTES: usize = 1 + 8 + 20 + 16;
const WITHDRAW_BODY_BYTES: usize = 1 + 8 + 32 + 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Transaction {
    Transfer { to: L2Address, amount: u128 },
    /// Вывод на L1: списывает баланс и добавляет лист в дерево выводов.
    Withdraw { l1_recipient_hash: Hash, amount: u128 },
}

/// Транзакция в том виде, в каком она лежит в данных батча.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedTransaction {
    /// Порядковый номер транзакции отправителя; обязан совпасть с nonce его счёта.
    pub nonce: u64,
    pub transaction: Transaction,
    /// r ‖ s ‖ v, где v — бит восстановления (0 или 1).
    pub signature: [u8; SIGNATURE_BYTES],
}

pub fn keccak256(parts: &[&[u8]]) -> Hash {
    let mut hasher = Keccak256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// Подписываемая часть транзакции: всё, кроме самой подписи.
fn encode_body(nonce: u64, transaction: &Transaction, out: &mut Vec<u8>) {
    match transaction {
        Transaction::Transfer { to, amount } => {
            out.push(TAG_TRANSFER);
            out.extend_from_slice(&nonce.to_be_bytes());
            out.extend_from_slice(to);
            out.extend_from_slice(&amount.to_be_bytes());
        }
        Transaction::Withdraw { l1_recipient_hash, amount } => {
            out.push(TAG_WITHDRAW);
            out.extend_from_slice(&nonce.to_be_bytes());
            out.extend_from_slice(l1_recipient_hash);
            out.extend_from_slice(&amount.to_be_bytes());
        }
    }
}

/// Хеш, который подписывает отправитель:
///   keccak256(метка ‖ идентификатор rollup'а (32 байта) ‖ тело транзакции с nonce).
pub fn signing_hash(chain_id: u64, nonce: u64, transaction: &Transaction) -> Hash {
    let mut chain_word = [0u8; 32];
    chain_word[24..].copy_from_slice(&chain_id.to_be_bytes());
    let mut body = Vec::with_capacity(WITHDRAW_BODY_BYTES);
    encode_body(nonce, transaction, &mut body);
    keccak256(&[SIGNING_TAG, &chain_word, &body])
}

/// Адрес счёта по открытому ключу — как в Ethereum.
pub fn address_of(key: &VerifyingKey) -> L2Address {
    let point = key.to_encoded_point(false);
    let digest = keccak256(&[&point.as_bytes()[1..]]);
    let mut address = [0u8; 20];
    address.copy_from_slice(&digest[12..]);
    address
}

/// Отправитель транзакции: счёт, чьим ключом подписан её хеш.
pub fn recover_sender(chain_id: u64, signed: &SignedTransaction) -> Result<L2Address, BatchError> {
    let hash = signing_hash(chain_id, signed.nonce, &signed.transaction);
    let signature = Signature::from_slice(&signed.signature[..64]).map_err(|_| BatchError::BadSignature)?;
    let recovery_id = RecoveryId::from_byte(signed.signature[64]).ok_or(BatchError::BadSignature)?;
    let key =
        VerifyingKey::recover_from_prehash(&hash, &signature, recovery_id).map_err(|_| BatchError::BadSignature)?;
    Ok(address_of(&key))
}

/// Подписывает транзакцию ключом счёта. Программе zkVM не нужна — ею пользуются
/// кошелёк (в нашем случае сценарий в zkvm/native) и тесты.
pub fn sign_transaction(key: &SigningKey, chain_id: u64, nonce: u64, transaction: Transaction) -> SignedTransaction {
    let hash = signing_hash(chain_id, nonce, &transaction);
    let (signature, recovery_id) =
        key.sign_prehash_recoverable(&hash).expect("подпись детерминирована и не может не получиться");
    let mut bytes = [0u8; SIGNATURE_BYTES];
    bytes[..64].copy_from_slice(&signature.to_bytes());
    bytes[64] = recovery_id.to_byte();
    SignedTransaction { nonce, transaction, signature: bytes }
}

/// Кодировка транзакций в данных батча. Ей пользуется секвенсор; программа делает обратное.
pub fn encode_transactions(transactions: &[SignedTransaction]) -> Vec<u8> {
    let mut out = Vec::new();
    for signed in transactions {
        encode_body(signed.nonce, &signed.transaction, &mut out);
        out.extend_from_slice(&signed.signature);
    }
    out
}

fn amount_from(bytes: &[u8]) -> u128 {
    let mut raw = [0u8; 16];
    raw.copy_from_slice(bytes);
    u128::from_be_bytes(raw)
}

/// Разбор данных батча: порции склеиваются, транзакция может пересекать границу порций.
/// Любой хвост, который не разбирается целиком, — ошибка: пруфа для таких данных нет.
pub fn decode_transactions(chunks: &[Vec<u8>]) -> Result<Vec<SignedTransaction>, BatchError> {
    let data: Vec<u8> = chunks.iter().flat_map(|chunk| chunk.iter().copied()).collect();
    let mut transactions = Vec::new();
    let mut rest = data.as_slice();
    while let Some(&tag) = rest.first() {
        let body_size = match tag {
            TAG_TRANSFER => TRANSFER_BODY_BYTES,
            TAG_WITHDRAW => WITHDRAW_BODY_BYTES,
            _ => return Err(BatchError::MalformedData),
        };
        if rest.len() < body_size + SIGNATURE_BYTES {
            return Err(BatchError::MalformedData);
        }
        let (body, after_body) = rest.split_at(body_size);
        let (signature_bytes, tail) = after_body.split_at(SIGNATURE_BYTES);

        let mut nonce = [0u8; 8];
        nonce.copy_from_slice(&body[1..9]);
        let amount = amount_from(&body[body_size - 16..]);
        let transaction = if tag == TAG_TRANSFER {
            let mut to = [0u8; 20];
            to.copy_from_slice(&body[9..29]);
            Transaction::Transfer { to, amount }
        } else {
            let mut l1_recipient_hash = [0u8; 32];
            l1_recipient_hash.copy_from_slice(&body[9..41]);
            Transaction::Withdraw { l1_recipient_hash, amount }
        };
        let mut signature = [0u8; SIGNATURE_BYTES];
        signature.copy_from_slice(signature_bytes);
        transactions.push(SignedTransaction { nonce: u64::from_be_bytes(nonce), transaction, signature });
        rest = tail;
    }
    Ok(transactions)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unsigned(nonce: u64, transaction: Transaction) -> SignedTransaction {
        SignedTransaction { nonce, transaction, signature: [0x5a; SIGNATURE_BYTES] }
    }

    #[test]
    fn transactions_survive_encoding_and_chunk_boundaries() {
        let transactions = alloc::vec![
            unsigned(0, Transaction::Transfer { to: [2u8; 20], amount: u128::MAX }),
            unsigned(u64::MAX, Transaction::Withdraw { l1_recipient_hash: [9u8; 32], amount: 1 }),
            unsigned(7, Transaction::Transfer { to: [4u8; 20], amount: 0 }),
        ];
        let data = encode_transactions(&transactions);
        // Граница порций посреди транзакции: разбор идёт по склейке.
        let (head, tail) = data.split_at(70);
        assert_eq!(decode_transactions(&[head.to_vec(), tail.to_vec()]).unwrap(), transactions);
    }

    #[test]
    fn malformed_data_is_rejected() {
        assert_eq!(decode_transactions(&[alloc::vec![7u8]]).unwrap_err(), BatchError::MalformedData);
        let mut truncated = encode_transactions(&[unsigned(0, Transaction::Transfer { to: [2u8; 20], amount: 5 })]);
        truncated.pop();
        assert_eq!(decode_transactions(&[truncated]).unwrap_err(), BatchError::MalformedData);
    }

    #[test]
    fn signing_hash_binds_chain_nonce_and_content() {
        let transfer = Transaction::Transfer { to: [2u8; 20], amount: 5 };
        let base = signing_hash(1, 0, &transfer);
        assert_ne!(base, signing_hash(2, 0, &transfer));
        assert_ne!(base, signing_hash(1, 1, &transfer));
        assert_ne!(base, signing_hash(1, 0, &Transaction::Transfer { to: [2u8; 20], amount: 6 }));
        assert_ne!(base, signing_hash(1, 0, &Transaction::Transfer { to: [3u8; 20], amount: 5 }));
    }

    #[test]
    fn signer_is_recovered_and_tampering_changes_the_sender() {
        let key = SigningKey::from_slice(&[0x11; 32]).unwrap();
        let owner = address_of(key.verifying_key());
        let signed = sign_transaction(&key, 1, 3, Transaction::Transfer { to: [2u8; 20], amount: 5 });
        assert_eq!(recover_sender(1, &signed).unwrap(), owner);

        // Та же подпись под другой суммой, другим nonce или в другом rollup'е «принадлежит»
        // уже не владельцу счёта: списать с его счёта по ней нельзя.
        let mut other_amount = signed.clone();
        other_amount.transaction = Transaction::Transfer { to: [2u8; 20], amount: 6 };
        assert_ne!(recover_sender(1, &other_amount).ok(), Some(owner));
        let mut other_nonce = signed.clone();
        other_nonce.nonce = 4;
        assert_ne!(recover_sender(1, &other_nonce).ok(), Some(owner));
        assert_ne!(recover_sender(2, &signed).ok(), Some(owner));
    }

    #[test]
    fn garbage_signature_is_rejected_or_recovers_a_stranger() {
        // Произвольные 65 байт либо не разбираются как подпись, либо «восстанавливают»
        // случайный адрес, у которого нет счёта, — в обоих случаях батч некорректен.
        let forged = unsigned(0, Transaction::Transfer { to: [2u8; 20], amount: 5 });
        let mut with_bad_recovery_bit = forged.clone();
        with_bad_recovery_bit.signature[64] = 9;
        assert_eq!(recover_sender(1, &with_bad_recovery_bit).unwrap_err(), BatchError::BadSignature);
        let mut zero = forged;
        zero.signature = [0u8; SIGNATURE_BYTES];
        assert_eq!(recover_sender(1, &zero).unwrap_err(), BatchError::BadSignature);
    }
}
