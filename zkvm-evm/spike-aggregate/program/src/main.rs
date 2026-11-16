//! Гость-агрегатор (спайк, НЕ протокол): один пруф на N подряд идущих блоков EVM.
//!
//! Вход (по порядку): дайджест ключа программы EVM (`[u32; 8]`, `HashableKey::hash_u32`), число
//! блоков N, затем N раз — 352 байта публичных значений блока (`write_vec`). Сжатые пруфы блоков
//! хост кладёт в поток отложенных пруфов (`SP1Stdin::write_proof`); `verify_sp1_proof` берёт
//! следующий из них и требует, чтобы он был пруфом программы с этим ключом и с этими публичными
//! значениями (дайджест — sha256, как у `commit_slice`). Сама проверка происходит в рекурсии
//! при сжатии агрегата: исполнитель лишь копит дайджест отложенных пруфов.
//!
//! Выход — те же 11 слов протокола v2 «от первого prev до последнего new»; `batchHash` агрегата —
//! sha256 сцепки batchHash'ей блоков (набросок: контракту пришлось бы хранить данные всех блоков).
#![no_main]
sp1_zkvm::entrypoint!(main);

use sha2::{Digest, Sha256};

/// Ключ программы EVM (`programVKey` 0x0044524c…b239d94d из fixtures/evm_batches/program.json),
/// разложенный обратно в 8 слов KoalaBear: `bytes32` — это Σ wᵢ·2^(31·(7−i)) (sp1-hypercube,
/// `koalabears_to_bn254`), слова меньше 2³¹, разложение однозначно. Хост сверяет его с ключом,
/// который SDK выводит из ELF программы EVM. Константа в ELF агрегатора: ключ агрегатора
/// привязывает и программу блоков — иначе агрегатор принял бы пруфы любой программы.
const EVM_PROGRAM_VKEY: [u32; 8] =
    [573122128, 1916503089, 32984431, 822869928, 1576904526, 629969851, 1875121723, 842651981];

const WORD: usize = 32;
const PUBLIC_VALUES_BYTES: usize = 11 * WORD;
/// Верхняя граница спайка: больше 8 блоков не мерили.
const MAX_BLOCKS: u32 = 64;

/// Слова публичных значений (PROTOCOL-V2.md, раздел 2).
const CHAIN_ID: usize = 0;
const PREV_STATE: usize = 1;
const NEW_STATE: usize = 2;
const BATCH_HASH: usize = 3;
const PREV_WITHDRAWALS_ROOT: usize = 4;
const WITHDRAWALS_ROOT: usize = 5;
const PREV_DEPOSIT_HASH: usize = 6;
const NEW_DEPOSIT_HASH: usize = 7;
const PREV_WITHDRAWALS_COUNT: usize = 8;
const WITHDRAWALS_COUNT: usize = 9;
const BLOCK_TIMESTAMP: usize = 10;

fn word(values: &[u8], index: usize) -> &[u8] {
    &values[index * WORD..(index + 1) * WORD]
}

/// Слово-число (u64 в младших байтах big-endian), старшие 24 байта — нули.
fn number(values: &[u8], index: usize) -> u64 {
    let bytes = word(values, index);
    assert!(bytes[..24].iter().all(|byte| *byte == 0), "слово {index} не число u64");
    u64::from_be_bytes(bytes[24..].try_into().unwrap())
}

/// Блок `next` продолжает блок `prev`.
fn assert_linked(prev: &[u8], next: &[u8], position: usize) {
    for (left, right, name) in [
        (CHAIN_ID, CHAIN_ID, "chainId"),
        (NEW_STATE, PREV_STATE, "слово состояния"),
        (WITHDRAWALS_ROOT, PREV_WITHDRAWALS_ROOT, "корень выводов"),
        (NEW_DEPOSIT_HASH, PREV_DEPOSIT_HASH, "хеш очереди"),
        (WITHDRAWALS_COUNT, PREV_WITHDRAWALS_COUNT, "счётчик выводов"),
    ] {
        assert_eq!(word(prev, left), word(next, right), "блок {position}: не сцепляется ({name})");
    }
    assert!(
        number(next, BLOCK_TIMESTAMP) >= number(prev, BLOCK_TIMESTAMP),
        "блок {position}: время убывает"
    );
}

pub fn main() {
    let vkey: [u32; 8] = sp1_zkvm::io::read();
    assert_eq!(vkey, EVM_PROGRAM_VKEY, "ключ программы EVM не тот");
    let count: u32 = sp1_zkvm::io::read();
    assert!((1..=MAX_BLOCKS).contains(&count), "число блоков вне 1..={MAX_BLOCKS}");

    let mut blocks: Vec<Vec<u8>> = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let values = sp1_zkvm::io::read_vec();
        assert_eq!(values.len(), PUBLIC_VALUES_BYTES, "публичные значения блока — не 352 байта");
        let digest: [u8; 32] = Sha256::digest(&values).into();
        sp1_zkvm::lib::verify::verify_sp1_proof(&vkey, &digest);
        blocks.push(values);
    }
    for (index, pair) in blocks.windows(2).enumerate() {
        assert_linked(&pair[0], &pair[1], index + 1);
    }

    let first = &blocks[0];
    let last = &blocks[blocks.len() - 1];
    let mut batch_hashes = Sha256::new();
    for block in &blocks {
        batch_hashes.update(word(block, BATCH_HASH));
    }
    let batch_hash: [u8; 32] = batch_hashes.finalize().into();

    let mut out = Vec::with_capacity(PUBLIC_VALUES_BYTES);
    for (source, index) in [
        (first, CHAIN_ID),
        (first, PREV_STATE),
        (last, NEW_STATE),
    ] {
        out.extend_from_slice(word(source, index));
    }
    out.extend_from_slice(&batch_hash);
    for (source, index) in [
        (first, PREV_WITHDRAWALS_ROOT),
        (last, WITHDRAWALS_ROOT),
        (first, PREV_DEPOSIT_HASH),
        (last, NEW_DEPOSIT_HASH),
        (first, PREV_WITHDRAWALS_COUNT),
        (last, WITHDRAWALS_COUNT),
        (last, BLOCK_TIMESTAMP),
    ] {
        out.extend_from_slice(word(source, index));
    }
    sp1_zkvm::io::commit_slice(&out);
}
