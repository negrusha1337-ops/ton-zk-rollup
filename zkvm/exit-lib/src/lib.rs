//! Аварийный выход с баланса L2 — утверждение, которое доказывает отдельная программа
//! zkVM (zkvm/exit-program), когда rollup заморожен и секвенсора больше нет:
//!
//!   «в состоянии с корнем stateRoot есть счёт l2Account с балансом amount, и владелец
//!    этого счёта подписал вывод всего баланса из ЭТОГО состояния получателю recipientHash
//!    в этом rollup'е».
//!
//! Публичные значения — пять слов по 32 байта в порядке, который проверяет контракт
//! (contracts/rollup/escape.tolk, exitDigest):
//!
//!   chainId ‖ stateRoot ‖ l2Account ‖ amount ‖ recipientHash
//!
//! Корень состояния контракт подставляет свой — последний принятый до заморозки.
//! Подпись нужна, чтобы чужой баланс нельзя было вывести на свой адрес.
#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
use rollup_stf::tx::keccak256;
use rollup_stf::{address_of, sha256, state_root, Account, Hash, L2Address};
use serde::{Deserialize, Serialize};

/// Метка назначения подписи: согласие на выход нельзя выдать за подпись транзакции L2.
const SIGNING_TAG: &[u8] = b"ton-zk-rollup:exit:v2";
pub const EXIT_PUBLIC_VALUES_BYTES: usize = 5 * 32;
const SIGNATURE_BYTES: usize = 65;

/// Вход программы выхода. Для zkVM это приватный вход.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExitInput {
    pub chain_id: u64,
    /// Всё состояние L2 на момент заморозки, отсортированное по адресу, — то, что любой
    /// может восстановить из данных, опубликованных в TON.
    pub accounts: Vec<Account>,
    /// Какой счёт выходит.
    pub account_index: u32,
    /// Хеш адреса получателя в basechain TON.
    pub recipient_hash: Hash,
    /// Подпись владельца счёта: r ‖ s ‖ v.
    pub signature: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExitPublicValues {
    pub chain_id: u64,
    pub state_root: Hash,
    pub l2_account: L2Address,
    pub amount: u128,
    pub recipient_hash: Hash,
}

fn number_word(value: u128) -> Hash {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&value.to_be_bytes());
    out
}

impl ExitPublicValues {
    /// 160 байт в порядке, зафиксированном протоколом.
    pub fn to_bytes(&self) -> [u8; EXIT_PUBLIC_VALUES_BYTES] {
        let mut account_word = [0u8; 32];
        account_word[12..].copy_from_slice(&self.l2_account);
        let words = [
            number_word(self.chain_id as u128),
            self.state_root,
            account_word,
            number_word(self.amount),
            self.recipient_hash,
        ];
        let mut out = [0u8; EXIT_PUBLIC_VALUES_BYTES];
        for (i, word) in words.iter().enumerate() {
            out[i * 32..(i + 1) * 32].copy_from_slice(word);
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
pub enum ExitError {
    /// Список счетов не отсортирован строго по адресу или содержит дубликат.
    AccountsNotSorted,
    NoSuchAccount,
    /// Подпись не разбирается или из неё не восстанавливается ключ.
    BadSignature,
    /// Подписал не владелец выходящего счёта.
    NotOwner,
}

/// Хеш, который подписывает владелец счёта:
///   keccak256(метка ‖ chainId ‖ корень состояния ‖ хеш получателя).
/// Корень состояния входит в подпись, чтобы согласие относилось к конкретному состоянию —
/// тому, на котором rollup заморожен: подпись, выданную заранее или для другого состояния,
/// предъявить нельзя. Сумма в подпись не входит — она однозначно следует из состояния.
pub fn exit_signing_hash(chain_id: u64, state_root: &Hash, recipient_hash: &Hash) -> Hash {
    keccak256(&[SIGNING_TAG, &number_word(chain_id as u128), state_root, recipient_hash])
}

/// Подписывает согласие на выход. Программе zkVM не нужна — ею пользуются кошелёк
/// (у нас — сценарий в zkvm/native) и тесты.
pub fn sign_exit(key: &SigningKey, chain_id: u64, state_root: &Hash, recipient_hash: &Hash) -> Vec<u8> {
    let hash = exit_signing_hash(chain_id, state_root, recipient_hash);
    let (signature, recovery_id) =
        key.sign_prehash_recoverable(&hash).expect("подпись детерминирована и не может не получиться");
    let mut bytes = signature.to_bytes().to_vec();
    bytes.push(recovery_id.to_byte());
    bytes
}

fn recover_signer(hash: &Hash, signature: &[u8]) -> Result<L2Address, ExitError> {
    if signature.len() != SIGNATURE_BYTES {
        return Err(ExitError::BadSignature);
    }
    let parsed = Signature::from_slice(&signature[..64]).map_err(|_| ExitError::BadSignature)?;
    let recovery_id = RecoveryId::from_byte(signature[64]).ok_or(ExitError::BadSignature)?;
    let key = VerifyingKey::recover_from_prehash(hash, &parsed, recovery_id).map_err(|_| ExitError::BadSignature)?;
    Ok(address_of(&key))
}

/// Проверяет право на выход и возвращает публичные значения пруфа.
///
/// Список счетов обязан быть строго отсортирован по адресу, как в программе батчей.
/// Без этого в список можно было бы вписать второй раз свой же адрес с любым балансом:
/// корень состояния от этого не изменился бы, а выходить можно было бы с приписанной суммой.
pub fn prove_exit(input: &ExitInput) -> Result<ExitPublicValues, ExitError> {
    let root = state_root(&input.accounts).ok_or(ExitError::AccountsNotSorted)?;
    let account = input.accounts.get(input.account_index as usize).ok_or(ExitError::NoSuchAccount)?;
    let signer =
        recover_signer(&exit_signing_hash(input.chain_id, &root, &input.recipient_hash), &input.signature)?;
    if signer != account.address {
        return Err(ExitError::NotOwner);
    }
    Ok(ExitPublicValues {
        chain_id: input.chain_id,
        state_root: root,
        l2_account: account.address,
        amount: account.balance,
        recipient_hash: input.recipient_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAIN: u64 = 77;
    const RECIPIENT: Hash = [0xe1; 32];

    fn key(byte: u8) -> SigningKey {
        SigningKey::from_slice(&[byte; 32]).unwrap()
    }

    fn state() -> Vec<Account> {
        let mut accounts: Vec<Account> = [(1u8, 700u128), (2, 200)]
            .iter()
            .map(|&(who, balance)| Account { address: address_of(key(who).verifying_key()), balance, nonce: 1 })
            .collect();
        accounts.sort_by_key(|account| account.address);
        accounts
    }

    fn input_for(who: u8, signer: u8) -> ExitInput {
        let accounts = state();
        let address = address_of(key(who).verifying_key());
        let account_index = accounts.iter().position(|account| account.address == address).unwrap() as u32;
        let root = state_root(&accounts).unwrap();
        ExitInput {
            chain_id: CHAIN,
            accounts,
            account_index,
            recipient_hash: RECIPIENT,
            signature: sign_exit(&key(signer), CHAIN, &root, &RECIPIENT),
        }
    }

    #[test]
    fn owner_exits_with_full_balance() {
        let values = prove_exit(&input_for(1, 1)).unwrap();
        assert_eq!(values.amount, 700);
        assert_eq!(values.l2_account, address_of(key(1).verifying_key()));
        assert_eq!(values.state_root, state_root(&state()).unwrap());
        assert_eq!(values.recipient_hash, RECIPIENT);
        assert_eq!(values.to_bytes().len(), EXIT_PUBLIC_VALUES_BYTES);
        assert_eq!(values.digest()[0] & 0xe0, 0);
    }

    #[test]
    fn public_values_bytes_match_the_reference_vector() {
        // Байты пяти слов и их дайджест — как их считает контракт (exitDigest в escape.tolk);
        // эталон посчитан независимо. У первого байта sha256 (0x33) срезаны три старших бита.
        let values = ExitPublicValues {
            chain_id: 1,
            state_root: [0x22; 32],
            l2_account: [0x33; 20],
            amount: 0x0a0b_0c0d_0e0f,
            recipient_hash: [0x55; 32],
        };
        let mut expected = [0u8; EXIT_PUBLIC_VALUES_BYTES];
        expected[31] = 1;
        expected[32..64].fill(0x22);
        expected[76..96].fill(0x33);
        expected[122..128].copy_from_slice(&[0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]);
        expected[128..160].fill(0x55);
        assert_eq!(values.to_bytes(), expected);
        let digest: alloc::string::String =
            values.digest().iter().map(|byte| alloc::format!("{byte:02x}")).collect();
        assert_eq!(digest, "13d31e4046c23293deb14e16dd84e723763a8896d49501467bb74178457dec47");
    }

    #[test]
    fn signing_tag_separates_exit_consent_from_other_signatures() {
        // Метка назначения входит в подписываемый хеш: без неё (или с пустой) согласие на
        // выход совпало бы с хешем, который может быть подписан для чего-то другого.
        let root = [0x22u8; 32];
        let with_tag = exit_signing_hash(CHAIN, &root, &RECIPIENT);
        let without_tag = keccak256(&[&number_word(CHAIN as u128), &root, &RECIPIENT]);
        assert_ne!(with_tag, without_tag);
        assert_eq!(with_tag, keccak256(&[b"ton-zk-rollup:exit:v2", &number_word(CHAIN as u128), &root, &RECIPIENT]));
    }

    #[test]
    fn nobody_can_exit_someone_elses_balance() {
        // Счёт 1 выходит, но подписал владелец счёта 2 (или посторонний).
        assert_eq!(prove_exit(&input_for(1, 2)).unwrap_err(), ExitError::NotOwner);
        assert_eq!(prove_exit(&input_for(1, 9)).unwrap_err(), ExitError::NotOwner);
    }

    #[test]
    fn consent_is_bound_to_recipient_and_rollup() {
        // Подпись под одного получателя не годится для другого…
        let mut redirected = input_for(1, 1);
        redirected.recipient_hash = [0xe2; 32];
        assert!(matches!(prove_exit(&redirected).unwrap_err(), ExitError::NotOwner | ExitError::BadSignature));
        // …и для другого rollup'а.
        let mut elsewhere = input_for(1, 1);
        elsewhere.chain_id = CHAIN + 1;
        assert!(matches!(prove_exit(&elsewhere).unwrap_err(), ExitError::NotOwner | ExitError::BadSignature));
    }

    #[test]
    fn consent_is_bound_to_the_state() {
        // Согласие подписано для одного состояния; в другом состоянии (у того же счёта
        // другой баланс) оно не действует: баланс вывели бы без согласия на это состояние.
        let mut later = input_for(1, 1);
        let index = later.account_index as usize;
        later.accounts[index].balance += 1;
        assert!(matches!(prove_exit(&later).unwrap_err(), ExitError::NotOwner | ExitError::BadSignature));
        // Изменение чужого счёта тоже меняет корень, а с ним и подписываемый хеш.
        let mut other = input_for(1, 1);
        let stranger = 1 - other.account_index as usize;
        other.accounts[stranger].nonce += 1;
        assert!(matches!(prove_exit(&other).unwrap_err(), ExitError::NotOwner | ExitError::BadSignature));
    }

    #[test]
    fn duplicate_account_with_inflated_balance_is_rejected() {
        // Атака из разбора: перед честным списком вписан тот же адрес с огромным балансом.
        // Раньше корень считался после склейки дубликатов и совпадал с честным.
        let honest = prove_exit(&input_for(1, 1)).unwrap();
        let mut padded = input_for(1, 1);
        let mine = padded.accounts[padded.account_index as usize].clone();
        padded.accounts.insert(0, Account { balance: 1_000_000_000, ..mine.clone() });
        padded.account_index = 0;
        assert_eq!(prove_exit(&padded).unwrap_err(), ExitError::AccountsNotSorted);

        // Дубликат в любом месте и просто переставленный список — тоже отказ.
        let mut appended = input_for(1, 1);
        appended.accounts.push(Account { balance: 1_000_000_000, ..mine });
        assert_eq!(prove_exit(&appended).unwrap_err(), ExitError::AccountsNotSorted);
        let mut reversed = input_for(1, 1);
        reversed.accounts.reverse();
        assert_eq!(prove_exit(&reversed).unwrap_err(), ExitError::AccountsNotSorted);
        assert_eq!(honest.amount, 700);
    }

    #[test]
    fn inflated_balance_changes_the_state_root() {
        // Приписать себе баланс можно только вместе с другим корнем состояния, а его
        // контракт подставляет сам. Владелец счёта волен подписать и такое состояние —
        // программа выдаст пруф, но с чужим корнем, и контракт его не примет.
        let honest = prove_exit(&input_for(1, 1)).unwrap();
        let mut inflated = input_for(1, 1);
        let index = inflated.account_index as usize;
        inflated.accounts[index].balance = 1_000_000;
        let inflated_root = state_root(&inflated.accounts).unwrap();
        inflated.signature = sign_exit(&key(1), CHAIN, &inflated_root, &RECIPIENT);
        let forged = prove_exit(&inflated).unwrap();
        assert_eq!(forged.amount, 1_000_000);
        assert_ne!(forged.state_root, honest.state_root);
    }

    #[test]
    fn malformed_input_is_rejected() {
        let mut missing = input_for(1, 1);
        missing.account_index = 99;
        assert_eq!(prove_exit(&missing).unwrap_err(), ExitError::NoSuchAccount);
        let mut short = input_for(1, 1);
        short.signature.pop();
        assert_eq!(prove_exit(&short).unwrap_err(), ExitError::BadSignature);
    }

    #[test]
    fn transaction_signature_is_not_an_exit_consent() {
        // Подпись обычной транзакции L2 считается от другой метки и согласием на выход не служит.
        let transfer = rollup_stf::sign_transaction(
            &key(1),
            CHAIN,
            0,
            rollup_stf::Transaction::Transfer { to: [2u8; 20], amount: 5 },
        );
        let mut input = input_for(1, 1);
        input.signature = transfer.signature.to_vec();
        assert!(matches!(prove_exit(&input).unwrap_err(), ExitError::NotOwner | ExitError::BadSignature));
    }
}
