//! Тестовый сценарий из трёх батчей и нагрузочный батч для замеров. Используется
//! нативным запуском (сверка с контрактом без пруфа) и хост-скриптом SP1 при
//! доказательстве. Должен совпадать с tests/ZkvmProgram.spec.ts.
//!
//! Ключи счетов выводятся из меток и лежат в открытом коде: это тестовые счета
//! игрушечного L2, настоящих денег на них быть не может.
use k256::ecdsa::{Signature, SigningKey};
use k256::elliptic_curve::ops::Reduce;
use k256::elliptic_curve::point::AffineCoordinates;
use k256::{ProjectivePoint, Scalar, U256};
use rollup_exit::{sign_exit, ExitInput};
use rollup_stf::{
    address_of, deposit_hash, encode_transactions, forced_transaction_hash, recover_sender, sha256,
    sign_transaction, signing_hash, state_root, Account, BatchInput, Deposit, Hash, L2Address, QueueItem,
    SignedTransaction, Transaction, WithdrawalLeaf, MAX_DATA_CHUNK_BYTES,
};

pub mod fixtures;

pub const NANO: u128 = 1_000_000_000;
/// Сколько пользователь прикладывает к депозиту и сколько удерживает контракт (DEPOSIT_FEE).
pub const DEPOSIT_VALUE: u128 = NANO;
pub const DEPOSIT_FEE: u128 = NANO / 100;
/// Второй депозит сценария: приходит после батча 1, поэтому его обязан обработать батч 3.
pub const SECOND_DEPOSIT_VALUE: u128 = NANO / 2;
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
    /// Получатель и сумма вывода, который Алиса проводит принудительно, через очередь L1.
    pub forced_recipient_hash: Hash,
    pub forced_withdrawal_amount: u128,
    /// Депозит Бобу, вставший в очередь между батчами 1 и 2: цель батча 3.
    pub second_deposit: Deposit,
    /// Вывод Алисы в батче 3: третий лист дерева выводов.
    pub third_recipient_hash: Hash,
    pub third_withdrawal_amount: u128,
}

impl Scenario {
    pub fn new() -> Self {
        let alice_key = test_key("zkvm:alice-key");
        let bob_key = test_key("zkvm:bob-key");
        let alice = address_of(alice_key.verifying_key());
        let bob = address_of(bob_key.verifying_key());
        Self {
            bob,
            alice_key,
            bob_key,
            alice,
            l1_recipient_hash: sha256(&[b"zkvm:l1-recipient"]),
            deposit: Deposit { l2_recipient: alice, amount: DEPOSIT_VALUE - DEPOSIT_FEE },
            withdrawal_amount: NANO / 4,
            forced_recipient_hash: sha256(&[b"zkvm:l1-forced-recipient"]),
            forced_withdrawal_amount: NANO / 10,
            second_deposit: Deposit {
                l2_recipient: bob,
                amount: SECOND_DEPOSIT_VALUE - DEPOSIT_FEE,
            },
            third_recipient_hash: sha256(&[b"zkvm:l1-third-recipient"]),
            third_withdrawal_amount: NANO / 20,
        }
    }

    /// Накопительный хеш очереди L1 после того, как батч 2 обработал депозит и принудительные
    /// транзакции: с него батч 3 продолжает очередь.
    pub fn queue_hash_after_batch2(&self) -> Hash {
        self.forced_transactions()
            .iter()
            .fold(deposit_hash(&[0u8; 32], &self.deposit), |hash, bytes| forced_transaction_hash(&hash, bytes))
    }

    /// Батч 3: продолжает НЕпустое дерево выводов и НЕнулевой хеш очереди. В батчах 1 и 2
    /// оба прежних значения нулевые, и программа, которая вместо них коммитила бы ноль,
    /// прошла бы все сверки; на батче 3 она разойдётся с контрактом. Очередь: второй депозит
    /// (Бобу). Данные: Алиса выводит на L1 — третий лист дерева.
    pub fn batch3(&self, accounts: Vec<Account>, prior_withdrawals: Vec<WithdrawalLeaf>) -> BatchInput {
        let withdraw = Transaction::Withdraw {
            l1_recipient_hash: self.third_recipient_hash,
            amount: self.third_withdrawal_amount,
        };
        BatchInput {
            chain_id: CHAIN_ID,
            accounts,
            prev_deposit_hash: self.queue_hash_after_batch2(),
            queue_items: vec![QueueItem::Deposit(self.second_deposit.clone())],
            // Nonce Алисы: 0 — принудительный вывод, 1 — перевод Бобу в батче 2.
            data_chunks: vec![encode_transactions(&[self.sign(&self.alice_key, 2, withdraw)])],
            prior_withdrawals,
        }
    }

    /// Листья дерева выводов после батча 3.
    pub fn withdrawals_after_batch3(&self) -> Vec<WithdrawalLeaf> {
        let mut leaves = self.withdrawals();
        leaves.push(WithdrawalLeaf { recipient_hash: self.third_recipient_hash, amount: self.third_withdrawal_amount });
        leaves
    }

    /// Принудительные транзакции сценария в порядке очереди L1 (после депозита, до батча 1):
    ///   1) вывод Алисы — корректный, секвенсор обязан его исполнить;
    ///   2) мусор от постороннего — должен быть пропущен, не останавливая rollup.
    pub fn forced_transactions(&self) -> Vec<Vec<u8>> {
        let withdraw = Transaction::Withdraw {
            l1_recipient_hash: self.forced_recipient_hash,
            amount: self.forced_withdrawal_amount,
        };
        let garbage = [sha256(&[b"zkvm:garbage:0"]), sha256(&[b"zkvm:garbage:1"])].concat()[..40].to_vec();
        vec![encode_transactions(&[self.sign(&self.alice_key, 0, withdraw)]), garbage]
    }

    /// Выводы сценария по порядку листьев дерева: принудительный вывод Алисы из очереди
    /// исполняется раньше транзакций секвенсора, поэтому он — лист 0, вывод Боба — лист 1.
    pub fn withdrawals(&self) -> Vec<WithdrawalLeaf> {
        vec![
            WithdrawalLeaf { recipient_hash: self.forced_recipient_hash, amount: self.forced_withdrawal_amount },
            WithdrawalLeaf { recipient_hash: self.l1_recipient_hash, amount: self.withdrawal_amount },
        ]
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
            queue_items: Vec::new(),
            data_chunks: Vec::new(),
            prior_withdrawals: Vec::new(),
        }
    }

    /// Батч 2: обязан обработать очередь L1 — депозит Алисы и две принудительные транзакции
    /// (её вывод и мусор); затем транзакции секвенсора: Алиса переводит Бобу, Боб выводит на
    /// L1. Транзакции секвенсора публикуются в TON одной порцией данных.
    pub fn batch2(&self, accounts: Vec<Account>, prior_withdrawals: Vec<WithdrawalLeaf>) -> BatchInput {
        let transfer = Transaction::Transfer { to: self.bob, amount: 4 * NANO / 10 };
        let withdraw =
            Transaction::Withdraw { l1_recipient_hash: self.l1_recipient_hash, amount: self.withdrawal_amount };
        BatchInput {
            chain_id: CHAIN_ID,
            accounts,
            prev_deposit_hash: [0u8; 32],
            queue_items: std::iter::once(QueueItem::Deposit(self.deposit.clone()))
                .chain(self.forced_transactions().into_iter().map(QueueItem::ForcedTransaction))
                .collect(),
            // Нулевой nonce Алисы потрачен на принудительный вывод из очереди.
            data_chunks: vec![encode_transactions(
                &[
                    vec![self.sign(&self.alice_key, 1, transfer.clone())],
                    self.rejected_transactions(&transfer),
                    vec![self.sign(&self.bob_key, 0, withdraw)],
                ]
                .concat(),
            )],
            prior_withdrawals,
        }
    }

    /// Транзакции, которые программа обязана пропустить, — по одной на каждую причину
    /// отказа. Стоят в данных батча 2 между корректными: так ветки отказа исполняются
    /// не только в нативных тестах, но и внутри zkVM (в том числе восстановление ключа
    /// из негодной подписи через прекомпиляцию), и попадают под пруф. Состояние они не
    /// меняют. `executed` — перевод Алисы, уже исполненный перед ними.
    fn rejected_transactions(&self, executed: &Transaction) -> Vec<SignedTransaction> {
        let replay = self.sign(&self.alice_key, 1, executed.clone());
        let mut bad_recovery_byte = self.sign(&self.alice_key, 2, executed.clone());
        bad_recovery_byte.signature[64] = 9;
        let mut zero_signature = self.sign(&self.alice_key, 2, executed.clone());
        zero_signature.signature = [0u8; 65];
        // Подпись верна, но под другой суммой: восстановится чужой адрес без счёта.
        let mut altered = self.sign(&self.alice_key, 2, executed.clone());
        altered.transaction = Transaction::Transfer { to: self.bob, amount: NANO };
        let signed_for_another_rollup =
            sign_transaction(&self.alice_key, CHAIN_ID + 1, 2, Transaction::Transfer { to: self.bob, amount: 1 });
        let zero_amount = self.sign(&self.bob_key, 0, Transaction::Transfer { to: self.alice, amount: 0 });
        let overdraft = self.sign(&self.bob_key, 0, Transaction::Transfer { to: self.alice, amount: 1000 * NANO });
        let mut rejected = vec![
            replay,
            bad_recovery_byte,
            zero_signature,
            altered,
            signed_for_another_rollup,
            zero_amount,
            overdraft,
        ];
        rejected.extend(self.malformed_signatures(executed));
        rejected
    }

    /// Подписи, которые доходят до арифметики кривой и отвергаются уже там. В zkVM эти
    /// ветки идут через прекомпиляцию secp256k1 с подсказками хоста, и именно их нужно
    /// исполнить под zkVM: любую такую подпись можно поставить в очередь L1 за 0,05 TON, и
    /// если бы программа на ней паниковала, rollup встал бы до заморозки.
    ///   • high-s: та же верная подпись с s := n − s и перевёрнутым битом восстановления;
    ///   • бит восстановления 2 и 3 (абсцисса R «с переносом»);
    ///   • r, не являющееся абсциссой точки кривой (так выглядит половина случайных подписей);
    ///   • подпись, из которой «восстанавливается» бесконечно удалённая точка.
    pub fn malformed_signatures(&self, transaction: &Transaction) -> Vec<SignedTransaction> {
        const NONCE: u64 = 2;
        let valid = self.sign(&self.alice_key, NONCE, transaction.clone());
        let with_signature = |r: Scalar, s: Scalar, v: u8| {
            let signature = Signature::from_scalars(r, s).expect("r и s ненулевые");
            let mut bytes = [0u8; 65];
            bytes[..64].copy_from_slice(&signature.to_bytes());
            bytes[64] = v;
            SignedTransaction { nonce: NONCE, transaction: transaction.clone(), signature: bytes }
        };
        let (r, s) = Signature::from_slice(&valid.signature[..64]).expect("подпись сценария").split_scalars();

        let high_s = with_signature(*r, -*s, valid.signature[64] ^ 1);
        let carried_x: Vec<SignedTransaction> = [2u8, 3].iter().map(|&v| with_signature(*r, *s, v)).collect();

        // Первое r = 1, 2, …, для которого r³ + 7 — не квадрат: точки с такой абсциссой нет.
        let off_curve = (1u64..)
            .map(|candidate| with_signature(Scalar::from(candidate), Scalar::ONE, 0))
            .find(|signed| recover_sender(CHAIN_ID, signed).is_err())
            .expect("невычеты встречаются через один");

        // R = k·G, r = R.x, s = z / k: тогда r⁻¹·(s·R − z·G) — бесконечно удалённая точка.
        let z = <Scalar as Reduce<U256>>::reduce_bytes(&signing_hash(CHAIN_ID, NONCE, transaction).into());
        let k = Scalar::from(7u64);
        let point = (ProjectivePoint::GENERATOR * k).to_affine();
        let identity_r = <Scalar as Reduce<U256>>::reduce_bytes(&point.x());
        let identity_s = z * k.invert().expect("k ≠ 0");
        let identity: Vec<SignedTransaction> =
            [0u8, 1].iter().map(|&v| with_signature(identity_r, identity_s, v)).collect();

        [vec![high_s], carried_x, vec![off_curve], identity].concat()
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
            queue_items: Vec::new(),
            data_chunks: data.chunks(MAX_DATA_CHUNK_BYTES).map(<[u8]>::to_vec).collect(),
            prior_withdrawals,
        }
    }
}

impl Scenario {
    /// Нагрузочный батч с раздутой очередью L1: `deposits` депозитов на новые счета и `forced`
    /// принудительных транзакций. Нужен только для замеров — сколько циклов zkVM стоит один
    /// элемент очереди, то есть во что обходится секвенсору обязательная часть батча
    /// (bench/zkvm-queue-cost.json). В контракт не отправляется.
    ///
    /// Принудительные транзакции — худший для прувера случай: переводы с ВЕРНОЙ подписью от
    /// счетов, которых нет в состоянии. Программа обязана восстановить ключ из подписи (это и
    /// стоит дорого) и только потом пропускает транзакцию. Поставить такую в очередь может
    /// кто угодно.
    pub fn queue_load_batch(
        &self,
        accounts: Vec<Account>,
        prior_withdrawals: Vec<WithdrawalLeaf>,
        deposits: usize,
        forced: usize,
    ) -> BatchInput {
        let deposit_items = (0..deposits).map(|index| {
            let seed = sha256(&[format!("zkvm:queue-load:deposit:{index}").as_bytes()]);
            let mut l2_recipient = [0u8; 20];
            l2_recipient.copy_from_slice(&seed[..20]);
            QueueItem::Deposit(Deposit { l2_recipient, amount: NANO / 20 })
        });
        let forced_items = (0..forced).map(|index| {
            let stranger = test_key(&format!("zkvm:queue-load:stranger:{index}"));
            let transfer = Transaction::Transfer { to: self.bob, amount: 1 };
            QueueItem::ForcedTransaction(encode_transactions(&[self.sign(&stranger, 0, transfer)]))
        });
        BatchInput {
            chain_id: CHAIN_ID,
            accounts,
            // Хеш очереди на логику батча не влияет: замер идёт без контракта.
            prev_deposit_hash: [0u8; 32],
            queue_items: deposit_items.chain(forced_items).collect(),
            data_chunks: Vec::new(),
            prior_withdrawals,
        }
    }
}

/// Кто выходит аварийно в сценарии.
pub const EXIT_NAMES: [&str; 2] = ["alice", "bob"];

impl Scenario {
    /// Заявка на аварийный выход из состояния `accounts` (после заморозки rollup'а):
    /// владелец счёта подписывает получателя в basechain TON.
    pub fn exit_input(&self, name: &str, accounts: Vec<Account>) -> ExitInput {
        let (key, address) = match name {
            "alice" => (&self.alice_key, self.alice),
            "bob" => (&self.bob_key, self.bob),
            other => panic!("в сценарии нет счёта {other}: допустимы alice и bob"),
        };
        let recipient_hash = sha256(&[format!("zkvm:exit-recipient:{name}").as_bytes()]);
        let account_index =
            accounts.iter().position(|account| account.address == address).expect("счёт есть в состоянии") as u32;
        let root = state_root(&accounts).expect("состояние сценария отсортировано");
        ExitInput {
            chain_id: CHAIN_ID,
            signature: sign_exit(key, CHAIN_ID, &root, &recipient_hash),
            accounts,
            account_index,
            recipient_hash,
        }
    }
}

impl Default for Scenario {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rollup_stf::apply_batch;

    /// Батч 2 сценария несёт по одной транзакции на каждую причину отказа. Ни одна из них
    /// не должна оставить следа: состояние и дерево выводов те же, что у батча без них.
    #[test]
    fn rejected_transactions_of_the_scenario_change_nothing() {
        let scenario = Scenario::new();
        let (_, accounts, withdrawals) = apply_batch(&scenario.batch1()).unwrap();
        let with_rejected = scenario.batch2(accounts.clone(), withdrawals.clone());

        let transfer = Transaction::Transfer { to: scenario.bob, amount: 4 * NANO / 10 };
        let withdraw = Transaction::Withdraw {
            l1_recipient_hash: scenario.l1_recipient_hash,
            amount: scenario.withdrawal_amount,
        };
        assert_eq!(scenario.rejected_transactions(&transfer).len(), 13);
        let mut clean = scenario.batch2(accounts, withdrawals);
        clean.data_chunks = vec![encode_transactions(&[
            scenario.sign(&scenario.alice_key, 1, transfer),
            scenario.sign(&scenario.bob_key, 0, withdraw),
        ])];
        assert!(with_rejected.data_chunks[0].len() > clean.data_chunks[0].len());

        let (values, state, leaves) = apply_batch(&with_rejected).unwrap();
        let (clean_values, clean_state, _) = apply_batch(&clean).unwrap();
        assert_eq!(state, clean_state);
        assert_eq!(values.new_state_root, clean_values.new_state_root);
        assert_eq!(values.withdrawals_root, clean_values.withdrawals_root);
        assert_ne!(values.batch_hash, clean_values.batch_hash);
        assert_eq!(leaves.len(), 2);
        // Каждый счёт отправил ровно по две транзакции: отклонённые nonce не сдвинули.
        assert!(state.iter().all(|account| account.nonce == if account.address == scenario.alice { 2 } else { 1 }));
    }

    /// Подписи, отвергаемые арифметикой кривой: каждая даёт отказ, а не панику и не чужой адрес.
    #[test]
    fn malformed_signatures_are_rejected_by_curve_arithmetic() {
        let scenario = Scenario::new();
        let transfer = Transaction::Transfer { to: scenario.bob, amount: 4 * NANO / 10 };
        let malformed = scenario.malformed_signatures(&transfer);
        assert_eq!(malformed.len(), 6);
        for (index, signed) in malformed.iter().enumerate() {
            assert_eq!(
                recover_sender(CHAIN_ID, signed),
                Err(rollup_stf::BatchError::BadSignature),
                "подпись № {index} должна быть отвергнута"
            );
        }
        // Сама подпись, из которой они получены, верна: отказ — из-за искажения, а не из-за основы.
        let valid = scenario.sign(&scenario.alice_key, 2, transfer);
        assert_eq!(recover_sender(CHAIN_ID, &valid), Ok(scenario.alice));
    }

    /// Закоммиченные фикстуры сценария — те, что выдаёт нынешний код. Сценарий не входит в
    /// хеш исходников программ, поэтому устаревший batches.json иначе никто бы не заметил.
    #[test]
    fn committed_fixtures_are_current() {
        let built = fixtures::build();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
        for (file, value) in
            [("zkvm_batches/batches.json", &built.batches), ("zkvm_exit/claims.json", &built.exits)]
        {
            let committed = std::fs::read_to_string(root.join(file)).unwrap_or_else(|e| panic!("{file}: {e}"));
            assert!(
                committed == fixtures::render(value),
                "fixtures/{file} устарел: запусти cargo run -p rollup-native"
            );
        }
    }

    /// Батч 3 продолжает ненулевые прежние корни, и оба они попадают в публичные БАЙТЫ.
    #[test]
    fn batch3_commits_nonzero_previous_roots() {
        let scenario = Scenario::new();
        let (_, accounts, withdrawals) = apply_batch(&scenario.batch1()).unwrap();
        let (values2, accounts, withdrawals) = apply_batch(&scenario.batch2(accounts, withdrawals)).unwrap();
        let (values3, state, leaves) = apply_batch(&scenario.batch3(accounts, withdrawals)).unwrap();

        assert_ne!(values3.prev_withdrawals_root, [0u8; 32]);
        assert_ne!(values3.prev_deposit_hash, [0u8; 32]);
        assert_eq!(values3.prev_withdrawals_root, values2.withdrawals_root);
        assert_eq!(values3.prev_deposit_hash, values2.new_deposit_hash);
        assert_eq!(values3.prev_state_root, values2.new_state_root);
        // Именно в байтах, которые хешируются в дайджест: слова 5 и 7 (с единицы).
        let bytes = values3.to_bytes();
        assert_eq!(&bytes[4 * 32..5 * 32], &values2.withdrawals_root);
        assert_eq!(&bytes[6 * 32..7 * 32], &values2.new_deposit_hash);

        assert_eq!(leaves.len(), 3);
        assert_eq!(
            rollup_stf::withdrawals_root(&leaves),
            rollup_stf::withdrawals_root(&scenario.withdrawals_after_batch3())
        );
        let bob = state.iter().find(|account| account.address == scenario.bob).unwrap();
        // 0,4 TON от Алисы − 0,25 TON вывода + второй депозит.
        assert_eq!(bob.balance, 4 * NANO / 10 - scenario.withdrawal_amount + scenario.second_deposit.amount);
    }

    /// Согласие на выход подписано под корень состояния после батча 3 и проходит проверку.
    #[test]
    fn scenario_exits_are_accepted() {
        let scenario = Scenario::new();
        let (_, accounts, withdrawals) = apply_batch(&scenario.batch1()).unwrap();
        let (_, accounts, withdrawals) = apply_batch(&scenario.batch2(accounts, withdrawals)).unwrap();
        let (_, accounts, _) = apply_batch(&scenario.batch3(accounts, withdrawals)).unwrap();
        for name in EXIT_NAMES {
            let values = rollup_exit::prove_exit(&scenario.exit_input(name, accounts.clone())).unwrap();
            assert!(values.amount > 0);
        }
    }
}
