//! Тестовый сценарий из двух батчей. Используется нативным запуском (сверка с
//! контрактом без пруфа) и будет использоваться хост-скриптом SP1 при доказательстве.
//! Должен совпадать с tests/ZkvmProgram.spec.ts.
use rollup_stf::{sha256, Account, BatchInput, Deposit, Hash, L2Address, Transaction, WithdrawalLeaf};

pub const NANO: u128 = 1_000_000_000;
/// Сколько пользователь прикладывает к депозиту и сколько удерживает контракт (DEPOSIT_FEE).
pub const DEPOSIT_VALUE: u128 = NANO;
pub const DEPOSIT_FEE: u128 = NANO / 100;

fn l2_address(label: &str) -> L2Address {
    let digest = sha256(&[label.as_bytes()]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&digest[..20]);
    out
}

pub struct Scenario {
    pub alice: L2Address,
    pub bob: L2Address,
    /// Хеш адреса получателя вывода в basechain TON.
    pub l1_recipient_hash: Hash,
    pub deposit: Deposit,
    pub withdrawal_amount: u128,
}

impl Scenario {
    pub fn new() -> Self {
        let alice = l2_address("zkvm:alice");
        Self {
            alice,
            bob: l2_address("zkvm:bob"),
            l1_recipient_hash: sha256(&[b"zkvm:l1-recipient"]),
            deposit: Deposit { l2_recipient: alice, amount: DEPOSIT_VALUE - DEPOSIT_FEE },
            withdrawal_amount: NANO / 4,
        }
    }

    /// Батч 1: депозит уже в очереди L1, но цель очереди зафиксирована на генезисе,
    /// поэтому батч его не обрабатывает. Состояние пустое, транзакций нет.
    pub fn batch1(&self) -> BatchInput {
        BatchInput {
            accounts: Vec::new(),
            prev_deposit_hash: [0u8; 32],
            deposits: Vec::new(),
            transactions: Vec::new(),
            prior_withdrawals: Vec::new(),
        }
    }

    /// Батч 2: обязан обработать депозит; затем перевод и вывод на L1.
    pub fn batch2(&self, accounts: Vec<Account>, prior_withdrawals: Vec<WithdrawalLeaf>) -> BatchInput {
        BatchInput {
            accounts,
            prev_deposit_hash: [0u8; 32],
            deposits: vec![self.deposit.clone()],
            transactions: vec![
                Transaction::Transfer { from: self.alice, to: self.bob, amount: 4 * NANO / 10 },
                Transaction::Withdraw {
                    from: self.bob,
                    l1_recipient_hash: self.l1_recipient_hash,
                    amount: self.withdrawal_amount,
                },
            ],
            prior_withdrawals,
        }
    }
}

impl Default for Scenario {
    fn default() -> Self {
        Self::new()
    }
}
