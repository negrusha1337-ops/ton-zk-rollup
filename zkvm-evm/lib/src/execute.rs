//! Исполнение одного блока EVM с полной проверкой — по образцу
//! `ClientExecutor::execute` из succinctlabs/rsp (crates/executor/client/src/executor.rs,
//! коммит 5afe72eb, лицензия MIT OR Apache-2.0).
//!
//! Отличия от образца:
//!   * возвращает квитанции транзакций и хеши блока и родителя, а не заголовок: по логам
//!     квитанций rollup узнаёт выводы через мост;
//!   * правила цепочки получает аргументом — их задаёт программа, а не вход доказывающего;
//!   * некорректный блок — ошибка, а не паника (для тестов; гостевая программа всё равно
//!     паникует на любой ошибке);
//!   * только обычное дерево состояния (вариант `arena` в RSP помечен как не прошедший аудит);
//!   * до исполнения байткоды пересобираются из своих байтов и проверяется форма узлов дерева
//!     (`witness.rs`): RSP принимает их из входа на веру, потому что рассчитан на внешнюю
//!     сверку заголовка с настоящей цепочкой, а здесь заголовок задаёт секвенсор;
//!   * вместо `BasicBlockExecutor::execute` — свой цикл по транзакциям, собранный из тех же
//!     частей (reth `crates/evm/evm/src/execute.rs`, `execute_one`; alloy-evm,
//!     `BlockExecutor::execute_block`): принудительные транзакции из очереди L1 исполняются
//!     первыми, в порядке очереди, и каждая либо стоит в блоке на своём месте, либо пропущена
//!     по отказу самого revm.
//!
//! Порядок проверок менять нельзя без повторной сверки с образцом: на нём держится то, что
//! хеш блока действительно обязывает ко всему содержимому блока и к состоянию после него.
use std::sync::Arc;

use alloy_eips::eip2718::Encodable2718;
use alloy_primitives::{keccak256, B256};
use itertools::Itertools;
use reth_chainspec::ChainSpec;
use reth_ethereum_primitives::{EthPrimitives, Receipt};
use reth_evm::{
    execute::{BlockExecutionError, BlockExecutionOutput, BlockExecutor, BlockValidationError},
    ConfigureEvm,
};
use reth_evm_ethereum::EthEvmConfig;
use reth_execution_types::ExecutionOutcome;
use reth_primitives_traits::Block as _;
use reth_trie::{KeccakKeyHasher, TrieAccount};
use revm::{
    context_interface::result::InvalidTransaction,
    database::{states::bundle_state::BundleRetention, State, WrapDatabaseRef},
    install_crypto,
};
use rsp_client_executor::{
    custom::{CustomCrypto, CustomEvmFactory},
    io::{EthClientExecutorInput, WitnessInput},
    BlockValidator, FromInput,
};

use crate::{
    bridge::BRIDGE_ADDRESS,
    forced::{decode_forced_transaction, ForcedOutcome, InvalidReason, SkipReason},
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
    /// Что стало с каждой принудительной транзакцией, в порядке `forced`.
    pub forced: Vec<ForcedOutcome>,
    /// Хеш кода счёта моста в состоянии родителя: `None` — путь к счёту в свидетеле не раскрыт,
    /// `Some(None)` — счёта нет.
    pub bridge_code_hash: Option<Option<B256>>,
}

/// Отказ revm по транзакции, годной по форме: пропуск либо ошибка батча.
///
/// Перечень причин пропуска закрытый (правка 0.4 с дополнением). После проверок формы
/// (`forced.rs`) достижимы: nonce ниже и выше, нехватка баланса, отправитель с кодом, цена
/// ниже базовой, чаевые выше наибольшей цены, intrinsic gas — и ещё две, которых в проекте не
/// было: `value`, с которым плата не помещается в 256 бит, и nonce, равный наибольшему u64.
/// Обе зависят только от байтов элемента очереди, то есть достижимы для любого прохожего: как
/// ошибка батча каждая была бы выключателем rollup'а.
///
/// Всё остальное — ошибка батча: `TxGasLimitGreaterThanCap` (только Osaka),
/// `CallerGasLimitMoreThanBlock` (лимит блока закреплён, предел газа принудительной
/// транзакции много меньше), отказы по `chainId`, типу и блобам (отсеяны проверкой формы).
pub(crate) fn classify_invalid(error: &InvalidTransaction) -> Option<InvalidReason> {
    match error {
        InvalidTransaction::NonceTooLow { .. } => Some(InvalidReason::NonceTooLow),
        InvalidTransaction::NonceTooHigh { .. } => Some(InvalidReason::NonceTooHigh),
        InvalidTransaction::NonceOverflowInTransaction => Some(InvalidReason::NonceOverflow),
        InvalidTransaction::LackOfFundForMaxFee { .. } => Some(InvalidReason::LackOfFunds),
        InvalidTransaction::OverflowPaymentInTransaction => Some(InvalidReason::PaymentOverflow),
        InvalidTransaction::RejectCallerWithCode => Some(InvalidReason::SenderHasCode),
        InvalidTransaction::GasPriceLessThanBasefee => Some(InvalidReason::GasPriceBelowBaseFee),
        InvalidTransaction::PriorityFeeGreaterThanMaxFee => Some(InvalidReason::PriorityFeeAboveMaxFee),
        InvalidTransaction::CallGasCostMoreThanGasLimit { .. } => Some(InvalidReason::IntrinsicGas),
        _ => None,
    }
}

/// Исполняет блок из `input` по правилам `chain_spec` и проверяет всё, что связывает хеш блока с
/// его содержимым: свидетель состояния против корня состояния родителя, цепочку заголовков,
/// подписи, тело против заголовка, итоги исполнения (газ, квитанции) и корень состояния после.
///
/// `forced` — байты принудительных транзакций отрезка очереди L1, по порядку. Каждая, годная по
/// форме и действительная на состоянии в свой момент, обязана стоять в блоке следующей
/// транзакцией — байт в байт; остальные пропускаются. `forced_gas_cap` — предел газа
/// принудительной транзакции (у программы — `FORCED_TX_GAS_CAP`).
pub(crate) fn execute_block(
    chain_spec: Arc<ChainSpec>,
    mut input: EthClientExecutorInput,
    forced: &[&[u8]],
    forced_gas_cap: u64,
) -> Result<ExecutedBlock, EvmBatchError> {
    // Прекомпиляции EVM (ecrecover, bn254, …) — через системные вызовы SP1. Повторный вызов
    // (в нативных тестах) ничего не меняет.
    install_crypto(CustomCrypto::default());
    let evm_config =
        EthEvmConfig::new_with_evm_factory(chain_spec.clone(), CustomEvmFactory::new(None));
    let chain_id = chain_spec.chain.id();

    // Заголовки от нового к старому: [блок, родитель, предки…]. Без родителя нет ни корня
    // состояния «до», ни того, с чем сверять заголовок.
    let sealed_headers = input.sealed_headers().collect::<Vec<_>>();
    if sealed_headers.len() < 2 {
        return Err(EvmBatchError::MissingParentHeader);
    }

    // То, что RSP берёт из входа без проверки: разбор байткода и форма узлов дерева.
    rebuild_bytecodes(&mut input.bytecodes)?;
    check_state_tries(&input.parent_state)?;

    // Счёт моста в состоянии родителя: понадобится, если в блоке окажется лог моста. Читается
    // до исполнения — после него дерево уже обновлено. Подлинность прочитанного — та же, что у
    // всего свидетеля: корень дерева сверяется с корнем состояния родителя строкой ниже.
    let bridge_code_hash = input
        .parent_state
        .state_trie
        .get_rlp::<TrieAccount>(keccak256(BRIDGE_ADDRESS).as_slice())
        .ok()
        .map(|account| account.map(|account| account.code_hash));

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

    // Исполнение. Состояние — как у BasicBlockExecutor: кеш поверх базы свидетеля с накоплением
    // изменений; после блока переходы сворачиваются в набор изменений.
    let mut state = State::builder().with_database(db).with_bundle_update().build();
    let mut outcomes = Vec::with_capacity(forced.len());
    let result = {
        let mut executor = evm_config
            .executor_for_block(&mut state, block.sealed_block())
            .map_err(|e| EvmBatchError::Execution(e.to_string()))?;
        executor.apply_pre_execution_changes().map_err(|e| EvmBatchError::Execution(e.to_string()))?;

        // Принудительные транзакции — первыми, в порядке очереди. `included` — сколько
        // транзакций блока ими уже занято.
        let transactions = &input.current_block.body.transactions;
        let mut included = 0usize;
        for (index, bytes) in forced.iter().enumerate() {
            let transaction = match decode_forced_transaction(bytes, chain_id, forced_gas_cap) {
                Ok(transaction) => transaction,
                Err(reason) => {
                    outcomes.push(ForcedOutcome::Skipped(reason));
                    continue;
                }
            };
            // Исполнение на живом состоянии: после предыдущих включённых принудительных, до
            // транзакций секвенсора. Отказ состояния не меняет (изменения применяет только
            // commit_transaction).
            match executor.execute_transaction_without_commit(&transaction) {
                Ok(output) => {
                    // Действительна: секвенсор обязан был поставить её в блок на это место.
                    // Сравнение — по байтам кодировки, а не по хешам из кеша.
                    let in_block = transactions.get(included).is_some_and(|next| next.encoded_2718() == *bytes);
                    if !in_block {
                        return Err(EvmBatchError::ForcedTransactionOmitted(index));
                    }
                    executor.commit_transaction(output);
                    included += 1;
                    outcomes.push(ForcedOutcome::Included);
                }
                Err(BlockExecutionError::Validation(BlockValidationError::InvalidTx { error, .. })) => {
                    match error.as_invalid_tx_err().and_then(classify_invalid) {
                        Some(reason) => outcomes.push(ForcedOutcome::Skipped(SkipReason::Invalid(reason))),
                        None => return Err(EvmBatchError::ForcedTransactionRefusal(index, error.to_string())),
                    }
                }
                // Не помещается по газу блока — НЕ пропуск: секвенсор обязан закончить отрезок
                // очереди раньше. Иначе тяжёлые элементы перед жертвой выдавливали бы её из блока.
                Err(BlockExecutionError::Validation(
                    BlockValidationError::TransactionGasLimitMoreThanAvailableBlockGas { .. },
                )) => return Err(EvmBatchError::ForcedTransactionDoesNotFit(index)),
                Err(error) => return Err(EvmBatchError::Execution(error.to_string())),
            }
        }

        // Остальные транзакции блока — секвенсора.
        for transaction in block.transactions_recovered().skip(included) {
            executor.execute_transaction(transaction).map_err(|e| EvmBatchError::Execution(e.to_string()))?;
        }
        executor.apply_post_execution_changes().map_err(|e| EvmBatchError::Execution(e.to_string()))?
    };
    state.merge_transitions(BundleRetention::Reverts);
    let execution_output = BlockExecutionOutput { state: state.take_bundle(), result };
    // База свидетеля держит ссылку на вход: отпускаем её до обновления дерева.
    drop(state);

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
        forced: outcomes,
        bridge_code_hash,
    })
}
