//! Исполнение одного блока EVM с полной проверкой — по образцу
//! `ClientExecutor::execute` из succinctlabs/rsp (crates/executor/client/src/executor.rs,
//! коммит 5afe72eb, лицензия MIT OR Apache-2.0).
//!
//! Отличия от образца:
//!   * возвращает квитанции транзакций и хеши блока и родителя, а не заголовок: по квитанциям
//!     rollup узнаёт, какие переводы на мост действительно состоялись;
//!   * правила цепочки получает аргументом — их задаёт программа, а не вход доказывающего;
//!   * некорректный блок — ошибка, а не паника (для тестов; гостевая программа всё равно
//!     паникует на любой ошибке);
//!   * только обычное дерево состояния (вариант `arena` в RSP помечен как не прошедший аудит);
//!   * до исполнения байткоды пересобираются из своих байтов и проверяется форма узлов дерева
//!     (`witness.rs`): RSP принимает их из входа на веру, потому что рассчитан на внешнюю
//!     сверку заголовка с настоящей цепочкой, а здесь заголовок задаёт секвенсор.
//!
//! Порядок проверок менять нельзя без повторной сверки с образцом: на нём держится то, что
//! хеш блока действительно обязывает ко всему содержимому блока и к состоянию после него.
use std::sync::Arc;

use alloy_primitives::B256;
use itertools::Itertools;
use reth_chainspec::ChainSpec;
use reth_ethereum_primitives::{EthPrimitives, Receipt};
use reth_evm::execute::{BasicBlockExecutor, Executor};
use reth_evm_ethereum::EthEvmConfig;
use reth_execution_types::ExecutionOutcome;
use reth_primitives_traits::Block as _;
use reth_trie::KeccakKeyHasher;
use revm::{database::WrapDatabaseRef, install_crypto};
use rsp_client_executor::{
    custom::{CustomCrypto, CustomEvmFactory},
    io::{EthClientExecutorInput, WitnessInput},
    BlockValidator, FromInput,
};

use crate::{
    witness::{check_state_tries, rebuild_bytecodes},
    EvmBatchError,
};

/// Итог исполнения блока.
#[derive(Debug, Clone)]
pub struct ExecutedBlock {
    /// Хеш заголовка родителя: относительно его корня состояния проверен свидетель, относительно
    /// его полей (номер, время, базовая комиссия, лимит газа) — заголовок блока.
    pub parent_hash: B256,
    /// Хеш заголовка исполненного блока.
    pub block_hash: B256,
    /// Квитанции транзакций в порядке блока.
    pub receipts: Vec<Receipt>,
}

/// Исполняет блок из `input` по правилам `chain_spec` и проверяет всё, что связывает хеш блока с
/// его содержимым: свидетель состояния против корня состояния родителя, цепочку заголовков,
/// подписи, тело против заголовка, итоги исполнения (газ, квитанции) и корень состояния после.
pub fn execute_block(
    chain_spec: Arc<ChainSpec>,
    mut input: EthClientExecutorInput,
) -> Result<ExecutedBlock, EvmBatchError> {
    // Прекомпиляции EVM (ecrecover, bn254, …) — через системные вызовы SP1. Повторный вызов
    // (в нативных тестах) ничего не меняет.
    install_crypto(CustomCrypto::default());
    let evm_config =
        EthEvmConfig::new_with_evm_factory(chain_spec.clone(), CustomEvmFactory::new(None));

    // Заголовки от нового к старому: [блок, родитель, предки…]. Без родителя нет ни корня
    // состояния «до», ни того, с чем сверять заголовок.
    let sealed_headers = input.sealed_headers().collect::<Vec<_>>();
    if sealed_headers.len() < 2 {
        return Err(EvmBatchError::MissingParentHeader);
    }

    // То, что RSP берёт из входа без проверки: разбор байткода и форма узлов дерева.
    rebuild_bytecodes(&mut input.bytecodes)?;
    check_state_tries(&input.parent_state)?;

    // База состояния из свидетеля: узлы дерева сверяются с корнем состояния родителя, цепочка
    // заголовков — по хешам и номерам.
    let db = WrapDatabaseRef(
        input.witness_db(&sealed_headers).map_err(|e| EvmBatchError::Witness(e.to_string()))?,
    );

    let block = EthPrimitives::from_input_block(input.current_block.clone())
        .try_into_recovered()
        .map_err(|_| EvmBatchError::SignatureRecovery)?;

    // Заголовок и тело блока; затем каждый заголовок цепочки — сам по себе и против своего
    // родителя (хеш родителя, номер, время, базовая комиссия, лимит газа).
    <EthPrimitives as BlockValidator<ChainSpec>>::validate_block(&block, chain_spec.clone())
        .map_err(|e| EvmBatchError::InvalidBlock(e.to_string()))?;
    for (header, parent) in sealed_headers.iter().tuple_windows() {
        <EthPrimitives as BlockValidator<ChainSpec>>::validate_header(parent, chain_spec.clone())
            .map_err(|e| EvmBatchError::InvalidAncestry(e.to_string()))?;
        <EthPrimitives as BlockValidator<ChainSpec>>::validate_header_against_parent(
            header,
            parent,
            chain_spec.clone(),
        )
        .map_err(|e| EvmBatchError::InvalidAncestry(e.to_string()))?;
    }

    let execution_output = BasicBlockExecutor::new(evm_config, db)
        .execute(&block)
        .map_err(|e| EvmBatchError::Execution(e.to_string()))?;

    // Газ, корень квитанций и фильтр логов из заголовка — против результата исполнения.
    <EthPrimitives as BlockValidator<ChainSpec>>::validate_block_post_execution(
        &block,
        chain_spec.clone(),
        &execution_output,
    )
    .map_err(|e| EvmBatchError::InvalidExecutionResult(e.to_string()))?;

    let receipts = execution_output.result.receipts.clone();

    // Корень состояния после блока — против корня в заголовке. Подлинность свидетеля держится
    // НЕ на этой сверке (корень в заголовке выбирает тот, кто собрал блок), а на проверках до
    // исполнения: узлы дерева сверены с корнем состояния родителя при построении базы.
    let outcome = ExecutionOutcome::new(
        execution_output.state,
        vec![execution_output.result.receipts],
        input.current_block.header.number,
        vec![execution_output.result.requests],
    );
    let post_state = outcome.hash_state_slow::<KeccakKeyHasher>();
    input.parent_state.update(&post_state);
    let computed = input.parent_state.state_root();
    if computed != input.current_block.header.state_root {
        return Err(EvmBatchError::MismatchedStateRoot {
            computed: computed.0,
            header: input.current_block.header.state_root.0,
        });
    }

    Ok(ExecutedBlock {
        parent_hash: sealed_headers[1].hash(),
        block_hash: sealed_headers[0].hash(),
        receipts,
    })
}
