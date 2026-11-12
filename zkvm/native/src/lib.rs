//! Тестовый сценарий из двух батчей и нагрузочный батч для замеров. Используется
//! нативным запуском (сверка с контрактом без пруфа) и хост-скриптом SP1 при
//! доказательстве. Должен совпадать с tests/ZkvmProgram.spec.ts.
//!
//! Ключи счетов выводятся из меток и лежат в открытом коде: это тестовые счета
//! игрушечного L2, настоящих денег на них быть не может.
use k256::ecdsa::SigningKey;
use rollup_stf::{
    address_of, encode_transactions, sha256, sign_transaction, Account, BatchInput, Deposit, Hash, L2Address,
    SignedTransaction, Transaction, WithdrawalLeaf, MAX_DATA_CHUNK_BYTES,
};

pub const NANO: u128 = 1_000_000_000;
/// Сколько пользователь прикладывает к депозиту и сколько удерживает контракт (DEPOSIT_FEE).
pub const DEPOSIT_VALUE: u128 = NANO;
pub const DEPOSIT_FEE: u128 = NANO / 100;
/// Идентификатор тестового rollup'а: произвольное число, одно и то же в контракте
/// (поле chainId хранилища), в публичных значениях пруфа и в подписях транзакций.
pub const CHAIN_ID: u64 = 0x544f_4e5a_4b; // «TONZK»

fn test_key(label: &str) -> SigningKey {
    SigningKey::from_slice(&sha256(&[label.as_bytes()])).expect("хеш метки — допустимый ключ secp256k1")
}

pub struct Scenario {
    alice_key: SigningKey,
    bob_key: SigningKey,
    pub alice: L2Address,
    pub bob: L2Address,
    /// Хеш адреса получателя вывода в basechain TON.
    pub l1_recipient_hash: Hash,
    pub deposit: Deposit,
    pub withdrawal_amount: u128,
}

impl Scenario {
    pub fn new() -> Self {
        let alice_key = test_key("zkvm:alice-key");
        let bob_key = test_key("zkvm:bob-key");
        let alice = address_of(alice_key.verifying_key());
        Self {
            bob: address_of(bob_key.verifying_key()),
            alice_key,
            bob_key,
            alice,
            l1_recipient_hash: sha256(&[b"zkvm:l1-recipient"]),
            deposit: Deposit { l2_recipient: alice, amount: DEPOSIT_VALUE - DEPOSIT_FEE },
            withdrawal_amount: NANO / 4,
        }
    }

    fn sign(&self, key: &SigningKey, nonce: u64, transaction: Transaction) -> SignedTransaction {
        sign_transaction(key, CHAIN_ID, nonce, transaction)
    }

    /// Батч 1: депозит уже в очереди L1, но цель очереди зафиксирована на генезисе,
    /// поэтому батч его не обрабатывает. Состояние пустое, транзакций нет, данные не
    /// публикуются — хеш данных такого батча равен нулю.
    pub fn batch1(&self) -> BatchInput {
        BatchInput {
            chain_id: CHAIN_ID,
            accounts: Vec::new(),
            prev_deposit_hash: [0u8; 32],
            deposits: Vec::new(),
            data_chunks: Vec::new(),
            prior_withdrawals: Vec::new(),
        }
    }

    /// Батч 2: обязан обработать депозит; затем Алиса переводит Бобу, а Боб выводит на L1.
    /// Обе транзакции подписаны владельцами счетов и публикуются в TON одной порцией данных.
    pub fn batch2(&self, accounts: Vec<Account>, prior_withdrawals: Vec<WithdrawalLeaf>) -> BatchInput {
        let transfer = Transaction::Transfer { to: self.bob, amount: 4 * NANO / 10 };
        let withdraw =
            Transaction::Withdraw { l1_recipient_hash: self.l1_recipient_hash, amount: self.withdrawal_amount };
        BatchInput {
            chain_id: CHAIN_ID,
            accounts,
            prev_deposit_hash: [0u8; 32],
            deposits: vec![self.deposit.clone()],
            data_chunks: vec![encode_transactions(&[
                self.sign(&self.alice_key, 0, transfer),
                self.sign(&self.bob_key, 0, withdraw),
            ])],
            prior_withdrawals,
        }
    }

    /// Нагрузочный батч поверх состояния после батча 2: `transfers` подписанных переводов
    /// по одному нанотону туда-обратно между двумя счетами. Нужен только для замеров
    /// (цена данных и подписей в циклах zkVM); в контракт не отправляется. Данные режутся
    /// на порции предельного размера, так что транзакции пересекают границы порций.
    pub fn load_batch(
        &self,
        accounts: Vec<Account>,
        prior_withdrawals: Vec<WithdrawalLeaf>,
        transfers: usize,
    ) -> BatchInput {
        let nonce_of = |address: &L2Address| {
            accounts.iter().find(|account| &account.address == address).map_or(0, |account| account.nonce)
        };
        let (alice_start, bob_start) = (nonce_of(&self.alice), nonce_of(&self.bob));
        let transactions: Vec<SignedTransaction> = (0..transfers)
            .map(|index| {
                let turn = (index / 2) as u64;
                if index % 2 == 0 {
                    self.sign(&self.alice_key, alice_start + turn, Transaction::Transfer { to: self.bob, amount: 1 })
                } else {
                    self.sign(&self.bob_key, bob_start + turn, Transaction::Transfer { to: self.alice, amount: 1 })
                }
            })
            .collect();
        let data = encode_transactions(&transactions);
        BatchInput {
            chain_id: CHAIN_ID,
            accounts,
            // Очередь депозитов после батча 2 обработана целиком; её хеш на логику батча не влияет.
            prev_deposit_hash: [0u8; 32],
            deposits: Vec::new(),
            data_chunks: data.chunks(MAX_DATA_CHUNK_BYTES).map(<[u8]>::to_vec).collect(),
            prior_withdrawals,
        }
    }
}

impl Default for Scenario {
    fn default() -> Self {
        Self::new()
    }
}
