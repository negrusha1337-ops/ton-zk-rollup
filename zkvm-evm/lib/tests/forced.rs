//! Проверка формы принудительных транзакций (`PROTOCOL-V2.md`, раздел 3 с правками 0.1): по
//! случаю на каждую причину пропуска, не зависящую от состояния. Причины, зависящие от
//! состояния (nonce, баланс, цена), — в `blocks.rs`, на настоящих блоках.
use alloy_consensus::{TxEip2930, TxEip4844, TxEip7702, TxLegacy};
use alloy_eips::{eip2718::Encodable2718, eip7702::SignedAuthorization};
use alloy_primitives::{Address, Bytes, Signature, TxKind, B256, U256};
use reth_ethereum_primitives::TransactionSigned;
use rollup_evm::{
    forced::{decode_forced_transaction, SkipReason},
    BRIDGE_ADDRESS, FORCED_TX_GAS_CAP,
};

mod common;
use common::{address_of, bridge_call, encoded, key, sign, sign_high_s, signature_of, CHAIN_ID};

const RECIPIENT: [u8; 32] = [0x5a; 32];

fn decode(bytes: &[u8]) -> Result<Address, SkipReason> {
    decode_forced_transaction(bytes, CHAIN_ID, FORCED_TX_GAS_CAP).map(|transaction| transaction.signer())
}

fn legacy(chain_id: Option<u64>) -> TxLegacy {
    TxLegacy {
        chain_id,
        nonce: 3,
        gas_price: 2_000_000_000,
        gas_limit: 40_000,
        to: TxKind::Call(BRIDGE_ADDRESS),
        value: U256::from(50_000_000u64) * U256::from(1_000_000_000u64),
        input: Bytes::copy_from_slice(&RECIPIENT),
    }
}

fn access_list_transaction() -> TxEip2930 {
    TxEip2930 {
        chain_id: CHAIN_ID,
        nonce: 3,
        gas_price: 2_000_000_000,
        gas_limit: 40_000,
        to: TxKind::Call(BRIDGE_ADDRESS),
        value: U256::from(50_000_000u64) * U256::from(1_000_000_000u64),
        input: Bytes::copy_from_slice(&RECIPIENT),
        access_list: Default::default(),
    }
}

#[test]
fn bridge_call_of_each_ordinary_type_is_well_formed() {
    let signer = key(1);
    let candidates: Vec<TransactionSigned> = vec![
        sign(&signer, legacy(Some(CHAIN_ID))),
        sign(&signer, access_list_transaction()),
        sign(&signer, bridge_call(3, 50_000_000, RECIPIENT)),
    ];
    for transaction in candidates {
        assert_eq!(decode(&encoded(&transaction)), Ok(address_of(&signer)), "{:?}", transaction.tx_type());
    }
    // Отправитель — тот, чьим ключом подписано.
    let other = sign(&key(2), bridge_call(3, 50_000_000, RECIPIENT));
    assert_eq!(decode(&encoded(&other)), Ok(address_of(&key(2))));
    assert_ne!(address_of(&key(1)), address_of(&key(2)));
}

#[test]
fn bytes_that_are_not_one_transaction_are_skipped() {
    let honest = encoded(&sign(&key(1), bridge_call(0, 50_000_000, RECIPIENT)));
    assert!(decode(&honest).is_ok());

    assert_eq!(decode(&[]), Err(SkipReason::Undecodable));
    assert_eq!(decode(&[0xde, 0xad, 0xbe, 0xef]), Err(SkipReason::Undecodable));
    assert_eq!(decode(&[0x02]), Err(SkipReason::Undecodable));
    // Обрезанная транзакция и транзакция с хвостом.
    assert_eq!(decode(&honest[..honest.len() - 1]), Err(SkipReason::Undecodable));
    let mut tail = honest.clone();
    tail.push(0);
    assert_eq!(decode(&tail), Err(SkipReason::Undecodable));
    // Две транзакции подряд — не одна.
    assert_eq!(decode(&[honest.clone(), honest.clone()].concat()), Err(SkipReason::Undecodable));
    // Неизвестный тип.
    let mut unknown_type = honest.clone();
    unknown_type[0] = 0x05;
    assert_eq!(decode(&unknown_type), Err(SkipReason::Undecodable));
    // «Сетевая» кодировка (типизированная транзакция, завёрнутая в строку RLP) — не EIP-2718.
    let mut wrapped = Vec::new();
    sign(&key(1), bridge_call(0, 50_000_000, RECIPIENT)).network_encode(&mut wrapped);
    assert_ne!(wrapped, honest);
    assert_eq!(decode(&wrapped), Err(SkipReason::Undecodable));
}

#[test]
fn blob_and_delegation_transactions_are_skipped() {
    let signer = key(1);
    let blob = TxEip4844 {
        chain_id: CHAIN_ID,
        gas_limit: 40_000,
        max_fee_per_gas: 2_000_000_000,
        to: BRIDGE_ADDRESS,
        blob_versioned_hashes: vec![B256::repeat_byte(1)],
        max_fee_per_blob_gas: 1,
        input: Bytes::copy_from_slice(&RECIPIENT),
        ..Default::default()
    };
    assert_eq!(decode(&encoded(&sign(&signer, blob))), Err(SkipReason::UnsupportedType));

    let authorization = alloy_eips::eip7702::Authorization { chain_id: U256::from(CHAIN_ID), address: Address::ZERO, nonce: 0 };
    let delegation = TxEip7702 {
        chain_id: CHAIN_ID,
        gas_limit: 40_000,
        max_fee_per_gas: 2_000_000_000,
        to: BRIDGE_ADDRESS,
        input: Bytes::copy_from_slice(&RECIPIENT),
        authorization_list: vec![SignedAuthorization::new_unchecked(authorization, 0, U256::from(1u8), U256::from(1u8))],
        ..Default::default()
    };
    assert_eq!(decode(&encoded(&sign(&signer, delegation))), Err(SkipReason::UnsupportedType));
}

#[test]
fn transaction_for_another_chain_or_for_any_chain_is_skipped() {
    let signer = key(1);
    assert_eq!(decode(&encoded(&sign(&signer, legacy(None)))), Err(SkipReason::MissingChainId));
    assert_eq!(decode(&encoded(&sign(&signer, legacy(Some(CHAIN_ID + 1))))), Err(SkipReason::ForeignChainId));
    assert_eq!(decode(&encoded(&sign(&signer, legacy(Some(1))))), Err(SkipReason::ForeignChainId));
    let mut foreign = bridge_call(0, 50_000_000, RECIPIENT);
    foreign.chain_id = CHAIN_ID - 1;
    assert_eq!(decode(&encoded(&sign(&signer, foreign))), Err(SkipReason::ForeignChainId));
    // Та же транзакция для своей цепочки, но с другим ожидаемым chainId у программы.
    let own = encoded(&sign(&signer, bridge_call(0, 50_000_000, RECIPIENT)));
    assert!(decode_forced_transaction(&own, CHAIN_ID, FORCED_TX_GAS_CAP).is_ok());
    assert_eq!(
        decode_forced_transaction(&own, CHAIN_ID + 1, FORCED_TX_GAS_CAP).map(|_| ()),
        Err(SkipReason::ForeignChainId)
    );
}

#[test]
fn only_a_call_to_the_bridge_can_be_forced() {
    let signer = key(1);
    // Обычный перевод: был бы действителен в блоке, но принудительным быть не может.
    let mut transfer = bridge_call(0, 50_000_000, RECIPIENT);
    transfer.to = TxKind::Call(Address::repeat_byte(0x22));
    transfer.input = Bytes::new();
    transfer.gas_limit = 21_000;
    assert_eq!(decode(&encoded(&sign(&signer, transfer))), Err(SkipReason::NotBridgeCall));
    // Адрес, отличающийся от моста одним битом.
    let mut near = bridge_call(0, 50_000_000, RECIPIENT);
    let mut address = BRIDGE_ADDRESS.into_array();
    address[19] ^= 1;
    near.to = TxKind::Call(Address::from(address));
    assert_eq!(decode(&encoded(&sign(&signer, near))), Err(SkipReason::NotBridgeCall));
    // Создание контракта.
    let mut create = bridge_call(0, 0, RECIPIENT);
    create.to = TxKind::Create;
    assert_eq!(decode(&encoded(&sign(&signer, create))), Err(SkipReason::Create));
    let mut legacy_create = legacy(Some(CHAIN_ID));
    legacy_create.to = TxKind::Create;
    assert_eq!(decode(&encoded(&sign(&signer, legacy_create))), Err(SkipReason::Create));
}

#[test]
fn gas_limit_is_capped() {
    let signer = key(1);
    let with_gas = |gas_limit: u64| {
        let mut transaction = bridge_call(0, 50_000_000, RECIPIENT);
        transaction.gas_limit = gas_limit;
        encoded(&sign(&signer, transaction))
    };
    assert_eq!(FORCED_TX_GAS_CAP, 40_000);
    assert!(decode(&with_gas(FORCED_TX_GAS_CAP)).is_ok());
    assert!(decode(&with_gas(0)).is_ok(), "малый лимит — дело revm, а не формы");
    assert_eq!(decode(&with_gas(FORCED_TX_GAS_CAP + 1)), Err(SkipReason::GasLimitAboveCap));
    assert_eq!(decode(&with_gas(1_000_000)), Err(SkipReason::GasLimitAboveCap));
    assert_eq!(decode(&with_gas(u64::MAX)), Err(SkipReason::GasLimitAboveCap));
    // Предел — параметр проверки: с большим пределом та же транзакция годна.
    assert!(decode_forced_transaction(&with_gas(FORCED_TX_GAS_CAP + 1), CHAIN_ID, FORCED_TX_GAS_CAP + 1).is_ok());
}

#[test]
fn unrecoverable_and_malleable_signatures_are_skipped() {
    let signer = key(1);
    // s в верхней половине: подпись математически верна и восстанавливается в тот же адрес, но
    // EIP-2 её запрещает — узел такую транзакцию в блок не возьмёт.
    let high = sign_high_s(&signer, bridge_call(0, 50_000_000, RECIPIENT));
    assert_eq!(decode(&encoded(&high)), Err(SkipReason::Signature));
    let low = sign(&signer, bridge_call(0, 50_000_000, RECIPIENT));
    assert_ne!(encoded(&high), encoded(&low));
    assert!(decode(&encoded(&low)).is_ok());
    // Подпись, из которой ключ не восстановить.
    for (r, s) in [(U256::ZERO, U256::ZERO), (U256::from(1u8), U256::ZERO), (U256::ZERO, U256::from(1u8))] {
        let transaction: TransactionSigned =
            alloy_consensus::Signed::new_unhashed(bridge_call(0, 50_000_000, RECIPIENT), Signature::new(r, s, false)).into();
        assert_eq!(decode(&encoded(&transaction)), Err(SkipReason::Signature), "r = {r}, s = {s}");
    }
    // Подпись другой транзакции: восстанавливается, но в посторонний адрес — это уже не дело
    // формы (такой отправитель просто не найдётся в дереве либо не пройдёт по nonce и балансу).
    let foreign = signature_of(&signer, &bridge_call(1, 50_000_000, RECIPIENT));
    let transaction: TransactionSigned =
        alloy_consensus::Signed::new_unhashed(bridge_call(0, 50_000_000, RECIPIENT), foreign).into();
    let recovered = decode(&encoded(&transaction)).unwrap();
    assert_ne!(recovered, address_of(&signer));
}

/// Варианты кодировки той же обычной транзакции, которые строгий декодер принимать не должен:
/// каждый получен правкой байтов канонической кодировки.
fn non_canonical_variants(canonical: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
    // Обычная транзакция — список RLP с длинным заголовком: 0xf8 ‖ длина ‖ поля; nonce 3 — один байт.
    assert_eq!(canonical[0], 0xf8);
    assert_eq!(canonical[1] as usize, canonical.len() - 2);
    assert_eq!(canonical[2], 0x03, "первое поле — nonce 3");
    let mut variants = Vec::new();
    // Nonce с ведущим нулём: 0x82 0x00 0x03.
    let mut leading_zero = vec![0xf8, canonical[1] + 2, 0x82, 0x00, 0x03];
    leading_zero.extend_from_slice(&canonical[3..]);
    variants.push(("nonce с ведущим нулём", leading_zero));
    // Nonce одним байтом, записанный как строка из одного байта: 0x81 0x03.
    let mut long_single = vec![0xf8, canonical[1] + 1, 0x81, 0x03];
    long_single.extend_from_slice(&canonical[3..]);
    variants.push(("однобайтовое число строкой", long_single));
    // Длина списка в двух байтах вместо одного: 0xf9 0x00 длина.
    let mut wide_length = vec![0xf9, 0x00, canonical[1]];
    wide_length.extend_from_slice(&canonical[2..]);
    variants.push(("длина списка с ведущим нулём", wide_length));
    variants
}

#[test]
fn non_canonical_encodings_are_skipped() {
    // Узел получит ровно байты из очереди и сравнит их с транзакцией блока побайтно: кодировку,
    // которая не воспроизводится кодировщиком, в блок не поставить. Декодер alloy строгий и
    // сам отвергает известные неканонические формы; проверка «перекодировать и сравнить» в
    // программе — второй рубеж, и случая, который дошёл бы до неё, здесь построить не удалось.
    let canonical = encoded(&sign(&key(1), legacy(Some(CHAIN_ID))));
    assert!(decode(&canonical).is_ok());
    for (name, bytes) in non_canonical_variants(&canonical) {
        let outcome = decode(&bytes);
        assert!(
            matches!(outcome, Err(SkipReason::Undecodable | SkipReason::NonCanonicalEncoding)),
            "{name}: {outcome:?}"
        );
    }
}
