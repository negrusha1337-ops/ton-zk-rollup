//! Фикстуры сценария: fixtures/zkvm_batches/batches.json и fixtures/zkvm_exit/claims.json.
//!
//! Построение вынесено из main.rs, чтобы тест мог сверить закоммиченные файлы с тем, что
//! выдаёт нынешний код: сценарий не входит в хеш исходников программ, и устаревший
//! batches.json иначе не заметил бы никто (находка третьего круга проверки, REVIEW.md).
use rollup_exit::prove_exit;
use rollup_stf::{apply_batch, data_chunk_hash, BatchInput, PublicValues};
use serde_json::{json, Value};

use crate::{Scenario, CHAIN_ID, DEPOSIT_VALUE, EXIT_NAMES, SECOND_DEPOSIT_VALUE};

fn decimal(bytes: &[u8]) -> String {
    // Число из big-endian байтов в десятичной записи (для JSON без потери точности).
    let mut digits = vec![0u8];
    for &byte in bytes {
        let mut carry = byte as u32;
        for digit in digits.iter_mut() {
            let value = (*digit as u32) * 256 + carry;
            *digit = (value % 10) as u8;
            carry = value / 10;
        }
        while carry > 0 {
            digits.push((carry % 10) as u8);
            carry /= 10;
        }
    }
    digits.iter().rev().map(|d| char::from(b'0' + d)).collect()
}

fn describe(values: &PublicValues, input: &BatchInput) -> Value {
    json!({
        // Порции данных батча: их секвенсор публикует в TON сообщениями PublishData.
        "dataChunksHex": input.data_chunks.iter().map(hex::encode).collect::<Vec<_>>(),
        "publicValuesHex": hex::encode(values.to_bytes()),
        "publicInput": decimal(&values.digest()),
        "prevStateRoot": decimal(&values.prev_state_root),
        "roots": {
            "newStateRoot": decimal(&values.new_state_root),
            "batchHash": decimal(&values.batch_hash),
            "withdrawalsRoot": decimal(&values.withdrawals_root),
        },
        "prevWithdrawalsRoot": decimal(&values.prev_withdrawals_root),
        "prevDepositHash": decimal(&values.prev_deposit_hash),
        "newDepositHash": decimal(&values.new_deposit_hash),
    })
}

fn run(name: &str, input: &BatchInput) -> (PublicValues, Vec<rollup_stf::Account>, Vec<rollup_stf::WithdrawalLeaf>) {
    apply_batch(input).unwrap_or_else(|error| panic!("{name}: батч отклонён: {error:?}"))
}

/// Эталонные хеши порций разной длины: тест сверяет их с хешем ячеек, которые строит
/// TypeScript (`dataChunkCell`), то есть с тем, что увидит контракт.
fn chunk_hash_vectors() -> Vec<Value> {
    [0usize, 1, 126, 127, 128, 254, 635, 636, 2667, 2668, 60_000]
        .iter()
        .map(|&length| {
            let data: Vec<u8> = (0..length).map(|i| (i * 31 + length * 7 + (i >> 8)) as u8).collect();
            json!({ "length": length, "hash": hex::encode(data_chunk_hash(&data)) })
        })
        .collect()
}

/// Содержимое batches.json и claims.json для нынешнего сценария; заодно дайджесты батчей.
pub struct Fixtures {
    pub batches: Value,
    pub exits: Value,
    pub batch_digests: [String; 3],
}

pub fn build() -> Fixtures {
    let scenario = Scenario::new();
    let input1 = scenario.batch1();
    let (values1, accounts1, withdrawals1) = run("батч 1", &input1);
    let input2 = scenario.batch2(accounts1, withdrawals1);
    let (values2, accounts2, withdrawals2) = run("батч 2", &input2);
    assert_eq!(
        rollup_stf::withdrawals_root(&withdrawals2),
        rollup_stf::withdrawals_root(&scenario.withdrawals()),
        "выводы сценария разошлись с тем, что выдала программа"
    );
    // Батч 3 продолжает состояние после батча 2; заявки на аварийный выход ниже — из
    // состояния после батча 3 (в аварийном сценарии секвенсор пропадает после него).
    let input3 = scenario.batch3(accounts2.clone(), withdrawals2.clone());
    let (values3, accounts3, withdrawals3) = run("батч 3", &input3);
    assert_eq!(
        rollup_stf::withdrawals_root(&withdrawals3),
        rollup_stf::withdrawals_root(&scenario.withdrawals_after_batch3()),
        "выводы сценария после батча 3 разошлись с тем, что выдала программа"
    );
    let leaves_json = |leaves: &[rollup_stf::WithdrawalLeaf]| {
        leaves
            .iter()
            .enumerate()
            .map(|(index, leaf)| {
                json!({
                    "leafIndex": index,
                    "recipientHash": decimal(&leaf.recipient_hash),
                    "amount": leaf.amount.to_string(),
                })
            })
            .collect::<Vec<_>>()
    };
    let balances_json = |accounts: &[rollup_stf::Account]| {
        accounts
            .iter()
            .map(|account| {
                json!({
                    "address": hex::encode(account.address),
                    "balance": account.balance.to_string(),
                    "nonce": account.nonce,
                })
            })
            .collect::<Vec<_>>()
    };

    let output = json!({
        "source": "Сгенерировано нативным запуском zkvm/native (cargo run -p rollup-native); не редактировать вручную",
        "note": "Публичные значения программы перехода состояния (8 слов, первое — chainId). Пруфа здесь нет: это сверка формата с контрактом",
        "chainId": CHAIN_ID.to_string(),
        "genesisStateRoot": decimal(&values1.prev_state_root),
        "deposit": {
            "l2Recipient": decimal(&scenario.deposit.l2_recipient),
            "value": DEPOSIT_VALUE.to_string(),
            "amount": scenario.deposit.amount.to_string(),
        },
        // Принудительные транзакции: их ставят в очередь L1 после депозита и до батча 1.
        "forcedTransactionsHex": scenario.forced_transactions().iter().map(hex::encode).collect::<Vec<_>>(),
        // Второй депозит: его вносят после батча 1 и до батча 2, поэтому обработать его обязан
        // батч 3. В аварийном сценарии он остаётся необработанным и возвращается вносителю.
        "secondDeposit": {
            "l2Recipient": decimal(&scenario.second_deposit.l2_recipient),
            "value": SECOND_DEPOSIT_VALUE.to_string(),
            "amount": scenario.second_deposit.amount.to_string(),
        },
        // Листья дерева выводов после батча 2 и после батча 3, по порядку номеров.
        "withdrawals": leaves_json(&scenario.withdrawals()),
        "withdrawalsAfterBatch3": leaves_json(&withdrawals3),
        // Балансы после батча 2 и после батча 3 (из последних строятся заявки на аварийный выход).
        "finalBalances": balances_json(&accounts2),
        "balancesAfterBatch3": balances_json(&accounts3),
        "batches": [describe(&values1, &input1), describe(&values2, &input2), describe(&values3, &input3)],
        "chunkHashVectors": {
            "note": "Байт i порции длины n равен (i·31 + n·7 + (i >> 8)) mod 256",
            "vectors": chunk_hash_vectors(),
        },
    });

    // Аварийный выход: заявки обоих счетов из состояния после батча 3.
    let claims: Vec<Value> = EXIT_NAMES
        .iter()
        .map(|name| {
            let values = prove_exit(&scenario.exit_input(name, accounts3.clone()))
                .unwrap_or_else(|error| panic!("выход {name}: заявка отклонена: {error:?}"));
            json!({
                "name": name,
                "l2Account": decimal(&values.l2_account),
                "amount": values.amount.to_string(),
                "recipientHash": decimal(&values.recipient_hash),
                "publicValuesHex": hex::encode(values.to_bytes()),
                "publicInput": decimal(&values.digest()),
            })
        })
        .collect();
    let exit_output = json!({
        "source": "Сгенерировано нативным запуском zkvm/native (cargo run -p rollup-native); не редактировать вручную",
        "note": "Заявки на аварийный выход из состояния после батча 3: публичные значения программы выхода (5 слов). Пруфа здесь нет",
        "chainId": CHAIN_ID.to_string(),
        "stateRoot": decimal(&values3.new_state_root),
        "claims": claims,
    });
    Fixtures {
        batches: output,
        exits: exit_output,
        batch_digests: [decimal(&values1.digest()), decimal(&values2.digest()), decimal(&values3.digest())],
    }
}

/// Текст файла фикстуры: так его пишет `cargo run -p rollup-native` и так сравнивает тест.
pub fn render(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("JSON") + "\n"
}
