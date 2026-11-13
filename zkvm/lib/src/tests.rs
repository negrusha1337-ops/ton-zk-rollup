//! Тесты перехода состояния: что батч делает и, главное, чего он сделать не даёт.
use alloc::vec::Vec;
use k256::ecdsa::SigningKey;

use super::*;

const CHAIN: u64 = 77;

fn key(byte: u8) -> SigningKey {
    SigningKey::from_slice(&[byte; 32]).unwrap()
}

fn address(byte: u8) -> L2Address {
    address_of(key(byte).verifying_key())
}

/// Счета, отсортированные по адресу, как требует вход батча.
fn accounts(list: &[(u8, u128, u64)]) -> Vec<Account> {
    let mut out: Vec<Account> =
        list.iter().map(|&(who, balance, nonce)| Account { address: address(who), balance, nonce }).collect();
    out.sort_by_key(|account| account.address);
    out
}

fn batch(state: Vec<Account>, transactions: &[SignedTransaction]) -> BatchInput {
    BatchInput {
        chain_id: CHAIN,
        accounts: state,
        prev_deposit_hash: [0u8; 32],
        queue_items: Vec::new(),
        data_chunks: alloc::vec![encode_transactions(transactions)],
        prior_withdrawals: Vec::new(),
    }
}

fn transfer(from: u8, nonce: u64, to: u8, amount: u128) -> SignedTransaction {
    sign_transaction(&key(from), CHAIN, nonce, Transaction::Transfer { to: address(to), amount })
}

fn balance_of(state: &[Account], who: u8) -> Option<u128> {
    state.iter().find(|account| account.address == address(who)).map(|account| account.balance)
}

fn forced(signed: &SignedTransaction) -> QueueItem {
    QueueItem::ForcedTransaction(encode_transactions(core::slice::from_ref(signed)))
}

/// Состояние после батча из одних транзакций секвенсора.
fn after(state: Vec<Account>, transactions: &[SignedTransaction]) -> Vec<Account> {
    apply_batch(&batch(state, transactions)).unwrap().1
}

#[test]
fn deposit_then_transfer_and_withdraw() {
    let withdraw =
        sign_transaction(&key(2), CHAIN, 0, Transaction::Withdraw { l1_recipient_hash: [7u8; 32], amount: 100 });
    let mut input = batch(Vec::new(), &[transfer(1, 0, 2, 300), withdraw]);
    input.queue_items = alloc::vec![QueueItem::Deposit(Deposit { l2_recipient: address(1), amount: 1000 })];

    let (values, state, withdrawals) = apply_batch(&input).unwrap();
    assert_eq!(balance_of(&state, 1), Some(700));
    assert_eq!(balance_of(&state, 2), Some(200));
    assert!(state.iter().all(|account| account.nonce == 1));
    assert_eq!(withdrawals.len(), 1);
    assert_eq!(values.chain_id, CHAIN);
    assert_eq!(values.prev_state_root, state_root(&[]).unwrap());
    assert_eq!(values.new_state_root, state_root(&state).unwrap());
    assert_eq!(values.prev_withdrawals_root, [0u8; 32]);
    assert_ne!(values.new_deposit_hash, [0u8; 32]);
    assert_eq!(values.to_bytes().len(), PUBLIC_VALUES_BYTES);
    assert_eq!(PUBLIC_VALUES_BYTES, 256);
    assert_eq!(values.digest()[0] & 0xe0, 0);
}

#[test]
fn nobody_can_spend_from_someone_elses_account() {
    // У жертвы (1) есть деньги. Злоумышленник (9) подписывает «перевод» своим ключом:
    // отправитель восстанавливается из подписи, поэтому списать можно только с себя.
    let state = accounts(&[(1, 1000, 0)]);
    assert_eq!(after(state.clone(), &[transfer(9, 0, 9, 1000)]), state);

    // Даже со счётом и деньгами злоумышленник тратит только свои.
    let state = accounts(&[(1, 1000, 0), (9, 50, 0)]);
    let result = after(state, &[transfer(9, 0, 2, 50)]);
    assert_eq!(balance_of(&result, 1), Some(1000));
    assert_eq!(balance_of(&result, 9), Some(0));
}

#[test]
fn altered_transaction_does_not_touch_the_signer() {
    // Секвенсор берёт настоящую подпись жертвы и меняет сумму или получателя: подпись
    // «принадлежит» уже другому адресу, у которого счёта нет, и транзакция не исполняется.
    let state = accounts(&[(1, 1000, 0)]);
    let mut bigger = transfer(1, 0, 2, 10);
    bigger.transaction = Transaction::Transfer { to: address(2), amount: 1000 };
    let mut redirected = transfer(1, 0, 2, 10);
    redirected.transaction = Transaction::Transfer { to: address(9), amount: 10 };
    for forged in [bigger, redirected] {
        assert_eq!(after(state.clone(), &[forged]), state);
    }
}

#[test]
fn transaction_cannot_be_replayed_or_reordered() {
    let state = accounts(&[(1, 1000, 0)]);
    let first = transfer(1, 0, 2, 10);
    // Повтор в том же батче исполняется один раз.
    let once = after(state.clone(), &[first.clone()]);
    assert_eq!(after(state.clone(), &[first.clone(), first.clone()]), once);
    assert_eq!(balance_of(&once, 1), Some(990));
    // Повтор в следующем батче: nonce счёта уже сдвинут.
    assert_eq!(after(once.clone(), &[first]), once);
    // Транзакция с номером из будущего.
    assert_eq!(after(state.clone(), &[transfer(1, 1, 2, 10)]), state);
}

#[test]
fn transaction_signed_for_another_rollup_is_not_executed() {
    let state = accounts(&[(1, 1000, 0)]);
    let elsewhere = sign_transaction(&key(1), CHAIN + 1, 0, Transaction::Transfer { to: address(2), amount: 10 });
    assert_eq!(after(state.clone(), &[elsewhere]), state);
}

#[test]
fn chain_id_is_part_of_the_proven_statement() {
    let state = accounts(&[(1, 1000, 0)]);
    let (here, _, _) = apply_batch(&batch(state.clone(), &[])).unwrap();
    let mut other = batch(state, &[]);
    other.chain_id = CHAIN + 1;
    let (there, _, _) = apply_batch(&other).unwrap();
    assert_ne!(here.digest(), there.digest());
}

#[test]
fn overdraft_is_not_executed() {
    let state = accounts(&[(1, 10, 0)]);
    assert_eq!(after(state.clone(), &[transfer(1, 0, 2, 11)]), state);
}

#[test]
fn no_published_data_can_make_a_batch_unprovable() {
    // Мусор, обрезанная транзакция, дубль порции — батч всё равно доказуем, а корректные
    // транзакции до мусора исполнены.
    let state = accounts(&[(1, 1000, 0)]);
    let good = encode_transactions(&[transfer(1, 0, 2, 10)]);
    let mut truncated = good.clone();
    truncated.pop();
    for chunks in [
        alloc::vec![alloc::vec![0xffu8; 300]],
        alloc::vec![truncated],
        alloc::vec![good.clone(), alloc::vec![0x07u8; 5]],
        alloc::vec![good.clone(), good.clone()],
    ] {
        let mut input = batch(state.clone(), &[]);
        input.data_chunks = chunks;
        let (values, _, _) = apply_batch(&input).unwrap();
        // Обязательство на данные считается от того, что опубликовано, а не от того, что исполнено.
        assert_eq!(values.batch_hash, batch_data_hash(&input.data_chunks).unwrap());
    }
    let mut with_tail = batch(state, &[]);
    with_tail.data_chunks = alloc::vec![good.clone(), good, alloc::vec![0x07u8; 5]];
    let (_, result, _) = apply_batch(&with_tail).unwrap();
    assert_eq!(balance_of(&result, 2), Some(10));
}

#[test]
fn forced_copy_of_a_published_transaction_does_not_stall_the_batch() {
    // Атака из разбора: посторонний копирует транзакцию из данных, опубликованных заранее,
    // и ставит её в очередь L1. Она исполняется из очереди, а её копия в данных пропускается.
    let state = accounts(&[(1, 1000, 0)]);
    let published = [transfer(1, 0, 2, 10), transfer(1, 1, 2, 20)];
    let mut input = batch(state, &published);
    input.queue_items = alloc::vec![forced(&published[0])];
    let (_, result, _) = apply_batch(&input).unwrap();
    assert_eq!(balance_of(&result, 2), Some(30));
    assert_eq!(result.iter().find(|a| a.address == address(1)).unwrap().nonce, 2);
}

#[test]
fn unsorted_or_duplicate_accounts_are_rejected() {
    let mut reversed = accounts(&[(1, 1, 0), (2, 1, 0)]);
    reversed.reverse();
    assert_eq!(apply_batch(&batch(reversed.clone(), &[])).unwrap_err(), BatchError::AccountsNotSorted);
    assert_eq!(state_root(&reversed), None);

    // Дубликат адреса: «корень» такого списка совпал бы с корнем честного состояния.
    let honest = accounts(&[(1, 1000, 0), (2, 5, 0)]);
    let mut padded = honest.clone();
    padded.insert(0, Account { balance: 1_000_000, ..honest[0].clone() });
    assert_eq!(state_root(&padded), None);
    assert_eq!(apply_batch(&batch(padded, &[])).unwrap_err(), BatchError::AccountsNotSorted);
}

#[test]
fn prior_withdrawals_are_bound_to_the_public_values() {
    // Прежние выводы — приватный вход. Секвенсор, приписавший себе лист, получит другой
    // prevWithdrawalsRoot, а его контракт подставляет из своего хранилища.
    let state = accounts(&[(1, 1000, 0)]);
    let honest_prior = alloc::vec![WithdrawalLeaf { recipient_hash: [7u8; 32], amount: 100 }];
    let mut forged_prior = honest_prior.clone();
    forged_prior.push(WithdrawalLeaf { recipient_hash: [0x66; 32], amount: 999_999 });

    let mut honest = batch(state.clone(), &[]);
    honest.prior_withdrawals = honest_prior.clone();
    let mut forged = batch(state, &[]);
    forged.prior_withdrawals = forged_prior;
    let (honest_values, _, _) = apply_batch(&honest).unwrap();
    let (forged_values, _, _) = apply_batch(&forged).unwrap();

    assert_eq!(honest_values.prev_withdrawals_root, withdrawals_root(&honest_prior));
    assert_eq!(honest_values.withdrawals_root, honest_values.prev_withdrawals_root);
    assert_ne!(forged_values.prev_withdrawals_root, honest_values.prev_withdrawals_root);
    // Стереть чужой невыведенный лист тоже нельзя: корень прежнего дерева изменится.
    let mut erased = batch(accounts(&[(1, 1000, 0)]), &[]);
    erased.prior_withdrawals = Vec::new();
    assert_ne!(apply_batch(&erased).unwrap().0.prev_withdrawals_root, honest_values.prev_withdrawals_root);
}

#[test]
fn empty_withdrawal_tree_root_is_zero() {
    assert_eq!(withdrawals_root(&[]), [0u8; 32]);
}

#[test]
fn forced_transaction_is_executed_in_queue_order() {
    // Очередь: депозит на счёт 1, затем его же принудительный вывод — секвенсор не участвует.
    let withdraw =
        sign_transaction(&key(1), CHAIN, 0, Transaction::Withdraw { l1_recipient_hash: [7u8; 32], amount: 300 });
    let mut input = batch(Vec::new(), &[]);
    input.queue_items =
        alloc::vec![QueueItem::Deposit(Deposit { l2_recipient: address(1), amount: 1000 }), forced(&withdraw)];
    let (values, state, withdrawals) = apply_batch(&input).unwrap();
    assert_eq!(balance_of(&state, 1), Some(700));
    assert_eq!(withdrawals.len(), 1);
    assert_eq!(withdrawals[0].amount, 300);

    // Хеш очереди учитывает оба элемента и зависит от их порядка.
    let after_deposit = deposit_hash(&[0u8; 32], &Deposit { l2_recipient: address(1), amount: 1000 });
    let bytes = encode_transactions(core::slice::from_ref(&withdraw));
    assert_eq!(values.new_deposit_hash, forced_transaction_hash(&after_deposit, &bytes));
}

#[test]
fn invalid_forced_transaction_is_skipped_but_still_counted() {
    let state = accounts(&[(1, 1000, 0)]);
    let honest = transfer(1, 0, 2, 10);
    // Корректная транзакция с лишним хвостом: элемент очереди — ровно одна транзакция, не больше.
    let mut with_tail = encode_transactions(core::slice::from_ref(&honest));
    with_tail.extend_from_slice(&[0u8; 5]);
    let items = alloc::vec![
        forced(&transfer(1, 0, 2, 5000)),
        forced(&transfer(9, 0, 9, 1)),
        forced(&transfer(1, 7, 2, 10)),
        QueueItem::ForcedTransaction(alloc::vec![0xff; 50]),
        QueueItem::ForcedTransaction(with_tail),
    ];

    let mut input = batch(state.clone(), &[]);
    input.queue_items = items;
    let (values, result, withdrawals) = apply_batch(&input).unwrap();
    // Ни одна из пяти не исполнена: состояние прежнее…
    assert_eq!(result, state);
    assert!(withdrawals.is_empty());
    assert_eq!(values.new_state_root, values.prev_state_root);
    // …но очередь продвинулась на все пять, иначе контракт не принял бы батч.
    assert_ne!(values.new_deposit_hash, [0u8; 32]);

    // После мусора в очереди обычная работа продолжается.
    input.data_chunks = alloc::vec![encode_transactions(&[honest])];
    let (_, result, _) = apply_batch(&input).unwrap();
    assert_eq!(balance_of(&result, 2), Some(10));
}

#[test]
fn skipped_transaction_leaves_no_partial_changes() {
    // Перевод на счёт с балансом у самого потолка: списать можно, зачислить нельзя.
    // Транзакция обязана быть пропущена целиком — без списания и без сдвига nonce.
    let state = accounts(&[(1, 1000, 0), (2, u128::MAX, 0)]);
    let mut input = batch(state.clone(), &[]);
    input.queue_items = alloc::vec![forced(&transfer(1, 0, 2, 10))];
    assert_eq!(apply_batch(&input).unwrap().1, state);
    assert_eq!(after(state.clone(), &[transfer(1, 0, 2, 10)]), state);
}

#[test]
fn nobody_can_force_a_spend_from_someone_elses_account() {
    // Принудительная очередь не обходит подписи: чужую транзакцию туда поставить можно,
    // но исполнится она, только если подписана владельцем счёта.
    let state = accounts(&[(1, 1000, 0), (9, 5, 0)]);
    let mut altered = transfer(1, 0, 2, 10);
    altered.transaction = Transaction::Transfer { to: address(9), amount: 1000 };
    let mut input = batch(state.clone(), &[]);
    input.queue_items = alloc::vec![forced(&altered)];
    assert_eq!(apply_batch(&input).unwrap().1, state);
}

#[test]
fn oversized_forced_transaction_cannot_be_proven() {
    // Контракт не поставит в очередь больше одной ячейки, значит и пруфа с таким элементом нет.
    let mut input = batch(Vec::new(), &[]);
    input.queue_items = alloc::vec![QueueItem::ForcedTransaction(alloc::vec![0u8; MAX_FORCED_TRANSACTION_BYTES + 1])];
    assert_eq!(apply_batch(&input).unwrap_err(), BatchError::ForcedTransactionTooLarge);
}

#[test]
fn self_transfer_only_advances_the_nonce() {
    let state = accounts(&[(1, 1000, 0)]);
    let result = after(state, &[transfer(1, 0, 1, 400)]);
    assert_eq!(balance_of(&result, 1), Some(1000));
    assert_eq!(result[0].nonce, 1);
}

#[test]
fn zero_amount_transactions_leave_no_trace() {
    // Перевод нуля на новый адрес завёл бы вечный пустой счёт, вывод нуля — вечный лист
    // дерева выводов. Такие транзакции пропускаются целиком: не меняется даже nonce.
    let state = accounts(&[(1, 1000, 0)]);
    let zero_withdraw =
        sign_transaction(&key(1), CHAIN, 0, Transaction::Withdraw { l1_recipient_hash: [7u8; 32], amount: 0 });
    let (values, after_state, withdrawals) =
        apply_batch(&batch(state.clone(), &[transfer(1, 0, 5, 0), transfer(1, 0, 1, 0), zero_withdraw])).unwrap();
    assert_eq!(after_state, state);
    assert!(withdrawals.is_empty());
    assert_eq!(values.new_state_root, values.prev_state_root);
    assert_eq!(values.withdrawals_root, [0u8; 32]);

    // То же из очереди L1: элемент учтён в хеше очереди, но не исполнен.
    let mut input = batch(state.clone(), &[]);
    input.queue_items = alloc::vec![forced(&transfer(1, 0, 5, 0))];
    let (values, after_state, _) = apply_batch(&input).unwrap();
    assert_eq!(after_state, state);
    assert_ne!(values.new_deposit_hash, values.prev_deposit_hash);
}

#[test]
fn public_values_bytes_match_the_reference_vector() {
    // Раскладка публичных значений — часть протокола: контракт считает дайджест от этих же
    // восьми слов в этом же порядке. Тест закрепляет БАЙТЫ, а не поля структуры: программа,
    // которая заполняет поле `prev_withdrawals_root`, но коммитит на его месте ноль или
    // соседнее слово, прошла бы все остальные тесты, пока прежние корни в сценарии нулевые.
    let values = PublicValues {
        chain_id: 3,
        prev_state_root: [2u8; 32],
        new_state_root: [3u8; 32],
        batch_hash: [4u8; 32],
        prev_withdrawals_root: [5u8; 32],
        withdrawals_root: [6u8; 32],
        prev_deposit_hash: [7u8; 32],
        new_deposit_hash: [8u8; 32],
    };
    let mut expected = [0u8; 256];
    expected[31] = 3; // chainId — число в 32 байтах, big-endian
    for (index, byte) in (2u8..=8).enumerate() {
        expected[(index + 1) * 32..(index + 2) * 32].fill(byte);
    }
    assert_eq!(values.to_bytes(), expected);
    // Дайджест посчитан независимо (sha256 от этих 256 байт; у первого байта 0xbe срезаны три
    // старших бита — маска 253 бита, не уже и не шире).
    let digest = "1e2d673f5ebec57f7537a2c4bf777cb6b1d14bc88d556427d5402603bbeea50a";
    assert_eq!(values.digest().iter().map(|byte| alloc::format!("{byte:02x}")).collect::<alloc::string::String>(), digest);
}
