//! Мост L2→L1: контракт-предустановка в генезисе и разбор его логов (`PROTOCOL-V2.md`,
//! раздел 7 с правками 0.1 и 0.4).
//!
//! Вывод — лог моста: `Withdrawal(address indexed sender, bytes32 recipientHash, uint256 amount)`,
//! сумма — в нанотонах. Лог существует, только если кадр вызова не откатился, поэтому
//! «успешность перевода» проверять не нужно, а выводы из контрактов L2 получаются сами. Лог от
//! имени моста может записать только код, исполняемый по адресу моста: `DELEGATECALL` в мост
//! пишет лог от имени вызывающего, и листа он не даёт.
//!
//! Что обязывает код моста быть тем самым: если в блоке есть лог моста, хеш кода счёта моста в
//! состоянии родителя обязан равняться `BRIDGE_CODE_HASH`. Код существующего счёта правила
//! Cancun поменять не дают (nonce 1 и код закрывают повторное создание, `SELFDESTRUCT` в коде
//! нет), поэтому код во время блока — тот же, что в состоянии родителя.
use alloy_primitives::{b256, hex, Address, Log, B256, U256};
use reth_ethereum_primitives::Receipt;

use crate::protocol::WithdrawalLeaf;

/// Адрес моста L2→L1: 20 байт строки «ton-zk-rollup-bridge». Ключа к нему нет ни у кого.
pub const BRIDGE_ADDRESS: Address = Address::new(*b"ton-zk-rollup-bridge");

/// 1 нанотон на L1 = 1 gwei на L2: у монеты L2 18 знаков, как у ETH, и 1 TON = 1 целая монета.
/// Зачисления EIP-4895 считаются в gwei, так что депозит ложится в них без пересчёта.
pub const WEI_PER_NANOTON: u64 = 1_000_000_000;

/// Наименьшая сумма вывода, нанотоны: 0,05 TON. Зашита в код моста (`PUSH4 0x02faf080`).
pub const MIN_WITHDRAWAL_NANOTONS: u64 = 50_000_000;

/// keccak-256 от «Withdrawal(address,bytes32,uint256)».
pub const WITHDRAWAL_TOPIC: B256 = b256!("4206db6775563d1043abfcf27cd0ecd19fcc464be574a1487fc95b24957a671a");

/// Код моста, 89 байт. По шагам:
///
///   CALLDATASIZE PUSH1 0x20 XOR PUSH1 0x53 JUMPI      данные не ровно 32 байта → отказ
///   PUSH4 1e9 CALLVALUE MOD PUSH1 0x53 JUMPI          сумма не в целых нанотонах → отказ
///   PUSH4 1e9 CALLVALUE DIV DUP1 PUSH4 0x02faf080 GT PUSH1 0x53 JUMPI
///                                                     сумма меньше 0,05 TON (и нулевая) → отказ
///   PUSH1 0x20 MSTORE                                 память[32..64] = сумма в нанотонах
///   PUSH1 0 CALLDATALOAD PUSH1 0 MSTORE               память[0..32] = хеш получателя
///   CALLER PUSH32 topic0 PUSH1 0x40 PUSH1 0 LOG2      лог: событие, отправитель; данные — 64 байта
///   STOP
///   JUMPDEST PUSH1 0 PUSH1 0 REVERT                   смещение 0x53: отказ, монеты остаются у отправителя
///
/// В коде нет `CALL`, `DELEGATECALL`, `SELFDESTRUCT`, `SSTORE`: принятые монеты остаются на
/// счёте моста навсегда — это и есть сжигание при выводе.
pub const BRIDGE_CODE: [u8; 89] = hex!(
    "36602018605357"
    "633b9aca003406605357"
    "633b9aca0034048063" "02faf080" "11605357"
    "602052" "600035600052"
    "33" "7f4206db6775563d1043abfcf27cd0ecd19fcc464be574a1487fc95b24957a671a" "60406000a2" "00"
    "5b60006000fd"
);

/// keccak-256 кода моста. Тест пересчитывает его из `BRIDGE_CODE`.
pub const BRIDGE_CODE_HASH: B256 = b256!("4fb6d78f56819527fe507eb73d6490c14924233bc459195a7fdd4ec422a80bae");

/// Лог моста не той формы, которую пишет его код. При верном коде недостижимо.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MalformedBridgeLog;

/// Лист дерева выводов из лога моста: два топика (событие и отправитель словом), данные —
/// хеш получателя и сумма в нанотонах.
pub fn withdrawal_from_log(log: &Log) -> Result<WithdrawalLeaf, MalformedBridgeLog> {
    let topics = log.data.topics();
    let data: &[u8] = log.data.data.as_ref();
    if topics.len() != 2 || topics[0] != WITHDRAWAL_TOPIC || topics[1][..12] != [0u8; 12] || data.len() != 64 {
        return Err(MalformedBridgeLog);
    }
    let mut recipient_hash = [0u8; 32];
    recipient_hash.copy_from_slice(&data[..32]);
    let amount = u128::try_from(U256::from_be_slice(&data[32..])).map_err(|_| MalformedBridgeLog)?;
    Ok(WithdrawalLeaf { recipient_hash, amount })
}

/// Выводы блока: каждый лог квитанций с адресом моста, в порядке блока (по транзакциям, внутри
/// транзакции — по порядку логов).
pub fn bridge_withdrawals(receipts: &[Receipt]) -> Result<Vec<WithdrawalLeaf>, MalformedBridgeLog> {
    let mut leaves = Vec::new();
    for receipt in receipts {
        for log in &receipt.logs {
            if log.address == BRIDGE_ADDRESS {
                leaves.push(withdrawal_from_log(log)?);
            }
        }
    }
    Ok(leaves)
}
