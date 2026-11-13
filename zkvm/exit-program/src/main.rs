//! Гостевая программа SP1 для аварийного выхода: доказывает, что у счёта L2 есть баланс в
//! замороженном состоянии и что владелец счёта согласен вывести его этому получателю.
//! Публичные значения — ровно 160 байт в формате, который проверяет контракт на TON.
#![no_main]
sp1_zkvm::entrypoint!(main);

use rollup_exit::{prove_exit, ExitInput};

pub fn main() {
    let input = sp1_zkvm::io::read::<ExitInput>();
    // Нет счёта или нет подписи владельца — паника: пруфа для такой заявки не существует.
    let public_values = prove_exit(&input).expect("некорректная заявка на выход");
    sp1_zkvm::io::commit_slice(&public_values.to_bytes());
}
