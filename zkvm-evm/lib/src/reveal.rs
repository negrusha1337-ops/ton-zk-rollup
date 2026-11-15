//! Дополнение свидетеля состояния узлами доказательства счёта — работа ХОСТА, не программы.
//!
//! Зачем. Свидетель узла (`debug_executionWitness`) раскрывает только то, что читал и писал сам
//! блок. Принудительная транзакция, которую программа ПРОПУСКАЕТ (nonce, баланс, отправителя
//! нет), в блок не попала, и счёт её отправителя блок мог не трогать вовсе. Программа же обязана
//! этот счёт прочитать, чтобы решить «пропуск»: нераскрытый узел на пути — не «счёта нет», а
//! отказ (батч недоказуем). Хост берёт у узла `eth_getProof` счёта на состоянии родителя и
//! раскрывает этими узлами нераскрытые места дерева.
//!
//! Почему это безопасно. Узел подставляется только на место дайджеста с ТЕМ ЖЕ хешем
//! (keccak-256 от RLP узла), поэтому корень дерева не меняется, а раскрытое программа проверяет
//! так же, как остальной свидетель (`witness.rs`, `build_trie_db`). Дополнение ничего не
//! скрывает и не может сделать доказуемым то, чего в состоянии родителя нет.
use alloy_primitives::{keccak256, map::B256Map, B256};
use rsp_mpt::{EthereumState, MptNode, MptNodeData};

/// Раскрывает в дереве состояния узлы из `nodes` (RLP узлов, как в `accountProof` ответа
/// `eth_getProof`). Возвращает число раскрытых дайджестов; узлы, которым в дереве нет места
/// (уже раскрыты либо не от этого дерева), пропускаются.
pub fn reveal_account_nodes(state: &mut EthereumState, nodes: &[impl AsRef<[u8]>]) -> Result<usize, String> {
    let mut store: B256Map<MptNode> = B256Map::default();
    for encoded in nodes {
        let node = MptNode::decode(encoded.as_ref()).map_err(|error| format!("узел доказательства не разобран: {error}"))?;
        store.insert(keccak256(encoded.as_ref()), node);
    }
    let before = state.state_trie.hash();
    let mut revealed = 0;
    let trie = reveal(&state.state_trie, &store, &mut revealed);
    if trie.hash() != before {
        return Err("раскрытие узлов изменило корень дерева состояния".into());
    }
    state.state_trie = trie;
    Ok(revealed)
}

fn reveal(node: &MptNode, store: &B256Map<MptNode>, revealed: &mut usize) -> MptNode {
    match node.as_data() {
        MptNodeData::Null | MptNodeData::Leaf(_, _) => node.clone(),
        MptNodeData::Branch(children) => {
            let children: Vec<Option<Box<MptNode>>> = children
                .iter()
                .map(|child| child.as_ref().map(|child| Box::new(reveal(child, store, revealed))))
                .collect();
            MptNodeData::Branch(children.try_into().expect("в ветке шестнадцать мест")).into()
        }
        MptNodeData::Extension(path, child) => {
            MptNodeData::Extension(path.clone(), Box::new(reveal(child, store, revealed))).into()
        }
        MptNodeData::Digest(digest) => match store.get(digest) {
            Some(found) => {
                *revealed += 1;
                reveal(found, store, revealed)
            }
            None => node.clone(),
        },
    }
}

/// Раскрыт ли путь к ключу (хешу адреса) в дереве состояния: можно ли по свидетелю сказать,
/// есть счёт или его нет.
pub fn account_path_is_revealed(state: &EthereumState, hashed_address: B256) -> bool {
    state.state_trie.get(hashed_address.as_slice()).is_ok()
}

/// Спайк 1 (`PROTOCOL-V2.md`, 0.5): свидетель блока можно дополнить узлами `eth_getProof` счёта
/// пропущенного отправителя — существующего, отсутствующего и отсутствующего рядом с удалением
/// из того же блока. Доказательства здесь строит НЕЗАВИСИМАЯ реализация дерева (`HashBuilder`
/// из alloy-trie — на ней стоит сам Reth), ею же считаются ожидаемые корни.
#[cfg(test)]
mod tests {
    use alloy_primitives::{map::B256Map, U256};
    use reth_primitives_traits::Account;
    use alloy_trie::{proof::ProofRetainer, HashBuilder, Nibbles, EMPTY_ROOT_HASH};
    use reth_trie::{HashedPostState, TrieAccount};

    use super::*;
    use crate::witness::check_state_tries;

    fn account(nonce: u64, balance: u64) -> TrieAccount {
        TrieAccount {
            nonce,
            balance: U256::from(balance),
            storage_root: EMPTY_ROOT_HASH,
            code_hash: alloy_primitives::KECCAK256_EMPTY,
        }
    }

    /// Ключ из первых полубайтов `prefix` и заполнителя.
    fn key(prefix: &[u8], fill: u8) -> B256 {
        let mut nibbles = vec![fill & 0x0f; 64];
        nibbles[..prefix.len()].copy_from_slice(prefix);
        let mut bytes = [0u8; 32];
        for (index, pair) in nibbles.chunks(2).enumerate() {
            bytes[index] = (pair[0] << 4) | pair[1];
        }
        B256::from(bytes)
    }

    /// Корень дерева счетов и узлы доказательств для `targets` — как их отдал бы узел.
    fn root_and_proofs(accounts: &[(B256, TrieAccount)], targets: &[B256]) -> (B256, Vec<Vec<u8>>) {
        let mut sorted = accounts.to_vec();
        sorted.sort_by_key(|(key, _)| *key);
        let retainer = ProofRetainer::new(targets.iter().map(|target| Nibbles::unpack(target)).collect());
        let mut builder = HashBuilder::default().with_proof_retainer(retainer);
        for (key, value) in &sorted {
            builder.add_leaf(Nibbles::unpack(key), &alloy_rlp::encode(value));
        }
        let root = builder.root();
        let nodes = builder.take_proof_nodes().into_nodes_sorted().into_iter().map(|(_, node)| node.to_vec()).collect();
        (root, nodes)
    }

    /// Свидетель блока: дерево, в котором раскрыты только пути к `touched`.
    fn witness(accounts: &[(B256, TrieAccount)], touched: &[B256]) -> EthereumState {
        let (root, nodes) = root_and_proofs(accounts, touched);
        let mut state =
            EthereumState { state_trie: MptNodeData::Digest(root).into(), storage_tries: Default::default() };
        reveal_account_nodes(&mut state, &nodes).unwrap();
        assert_eq!(state.state_trie.hash(), root);
        state
    }

    /// Счета сценария. Под полубайтами [a, b] — ветка ровно из двух листьев (`pair.0`, `pair.1`);
    /// остальные счета разбросаны по другим ветвям.
    fn scenario() -> (Vec<(B256, TrieAccount)>, (B256, B256)) {
        let pair = (key(&[0xa, 0xb, 0x1], 0x3), key(&[0xa, 0xb, 0x2], 0x4));
        let mut accounts = vec![(pair.0, account(1, 100)), (pair.1, account(2, 200))];
        for first in 0u8..16 {
            for second in [0x0u8, 0x5, 0xc] {
                if first == 0xa && second == 0xb {
                    continue;
                }
                accounts.push((key(&[first, second], first ^ second), account(first as u64, 1000 + second as u64)));
            }
        }
        (accounts, pair)
    }

    fn read(state: &EthereumState, key: &B256) -> Result<Option<TrieAccount>, rsp_mpt::Error> {
        state.state_trie.get_rlp::<TrieAccount>(key.as_slice())
    }

    #[test]
    fn existing_sender_is_revealed_by_its_account_proof() {
        let (accounts, _) = scenario();
        let touched = [accounts[5].0, accounts[9].0];
        let sender = accounts[20];
        let mut state = witness(&accounts, &touched);
        let root = state.state_trie.hash();
        // Блок счёт отправителя не трогал: в свидетеле узла его нет, и это не «счёта нет».
        assert!(matches!(read(&state, &sender.0), Err(rsp_mpt::Error::NodeNotResolved(_))));
        assert!(!account_path_is_revealed(&state, sender.0));

        let (_, proof) = root_and_proofs(&accounts, &[sender.0]);
        assert!(reveal_account_nodes(&mut state, &proof).unwrap() >= 1);
        assert_eq!(state.state_trie.hash(), root, "дополнение не меняет корень");
        assert_eq!(read(&state, &sender.0).unwrap(), Some(sender.1));
        assert!(account_path_is_revealed(&state, sender.0));
        // Прежнее читается как прежде, форма узлов — каноническая.
        assert_eq!(read(&state, &touched[0]).unwrap(), Some(accounts[5].1));
        assert_eq!(check_state_tries(&state), Ok(()));
        // Повторное дополнение ничего не раскрывает.
        assert_eq!(reveal_account_nodes(&mut state, &proof).unwrap(), 0);
    }

    #[test]
    fn absent_sender_is_proven_absent_by_its_account_proof() {
        let (accounts, pair) = scenario();
        let touched = [accounts[5].0];
        let mut state = witness(&accounts, &touched);
        let root = state.state_trie.hash();
        // Три вида отсутствия: пустое место в ветке корня не встречается (все 16 заняты), поэтому
        // — пустое место в ветке второго уровня; лист с другим хвостом; пустое место в глубокой ветке.
        let absent = [key(&[0x3, 0x7], 0x1), key(&[0x3, 0x5, 0xf], 0x1), key(&[0xa, 0xb, 0x9], 0x1)];
        for sender in absent {
            assert!(matches!(read(&state, &sender), Err(rsp_mpt::Error::NodeNotResolved(_))));
            let (_, proof) = root_and_proofs(&accounts, &[sender]);
            reveal_account_nodes(&mut state, &proof).unwrap();
            assert_eq!(state.state_trie.hash(), root);
            assert_eq!(read(&state, &sender).unwrap(), None, "счёта нет — доказуемо");
        }
        // Доказательство отсутствия не раскрывает чужих счетов сверх своего пути.
        assert!(matches!(read(&state, &accounts[30].0), Err(rsp_mpt::Error::NodeNotResolved(_))));
        assert!(read(&state, &pair.0).is_err(), "лист рядом с пустым местом остался нераскрытым");
        assert_eq!(check_state_tries(&state), Ok(()));
    }

    /// Корень дерева после изменений — независимым построителем.
    fn expected_root(accounts: &[(B256, TrieAccount)]) -> B256 {
        root_and_proofs(accounts, &[]).0
    }

    #[test]
    fn absent_sender_next_to_a_deletion_in_the_same_block() {
        // Блок удаляет счёт pair.0; в ветке остаётся один сосед pair.1, и ветка сворачивается.
        // Свидетель узла для такого блока раскрывает и соседа (REVIEW.md, 7-1). Отправитель
        // пропущенной транзакции — отсутствующий счёт под ТОЙ ЖЕ веткой: его доказательство
        // отсутствия кончается в ветке, которую блок потом сворачивает.
        let (accounts, pair) = scenario();
        let sender = key(&[0xa, 0xb, 0x9], 0x1);
        let mut state = witness(&accounts, &[pair.0, pair.1]);
        let (_, proof) = root_and_proofs(&accounts, &[sender]);
        reveal_account_nodes(&mut state, &proof).unwrap();
        assert_eq!(read(&state, &sender).unwrap(), None);

        let mut post_state = HashedPostState::default();
        post_state.accounts.insert(pair.0, None);
        state.update(&post_state);
        let remaining: Vec<_> = accounts.iter().copied().filter(|(key, _)| *key != pair.0).collect();
        assert_eq!(state.state_root(), expected_root(&remaining), "корень после удаления — как у узла");
        assert_eq!(read(&state, &sender).unwrap(), None);
        assert_eq!(check_state_tries(&state), Ok(()));
    }

    #[test]
    fn supplement_does_not_replace_the_node_witness_for_the_deletion() {
        // Тот же блок, но свидетель «как у eth_getProof»: сосед удаляемого не раскрыт. Дополнение
        // доказательством отсутствия отправителя соседа не раскрывает — удаление остаётся
        // ошибкой (правка 2 копии rsp-mpt), а не превращается в неверный корень.
        let (accounts, pair) = scenario();
        let sender = key(&[0xa, 0xb, 0x9], 0x1);
        let mut state = witness(&accounts, &[pair.0]);
        let (_, proof) = root_and_proofs(&accounts, &[sender]);
        reveal_account_nodes(&mut state, &proof).unwrap();
        assert_eq!(read(&state, &sender).unwrap(), None);
        assert!(read(&state, &pair.1).is_err());
        assert!(matches!(state.state_trie.delete(pair.0.as_slice()), Err(rsp_mpt::Error::NodeNotResolved(_))));
    }

    #[test]
    fn absent_sender_credited_and_neighbour_deleted_in_the_same_block() {
        // Отправителя нет, принудительная транзакция пропущена, а в конце того же блока ему
        // зачисляется депозит (счёт создаётся) и рядом удаляется счёт. Порядок обновления в
        // копии rsp-mpt: сначала вставки, потом удаления.
        let (accounts, pair) = scenario();
        let sender = key(&[0xa, 0xb, 0x9], 0x1);
        let mut state = witness(&accounts, &[pair.0, pair.1]);
        let (_, proof) = root_and_proofs(&accounts, &[sender]);
        reveal_account_nodes(&mut state, &proof).unwrap();

        let mut post_state = HashedPostState::default();
        let mut changed: B256Map<Option<Account>> = B256Map::default();
        changed.insert(pair.0, None);
        changed.insert(sender, Some(Account { nonce: 0, balance: U256::from(300u64), bytecode_hash: None }));
        post_state.accounts = changed;
        state.update(&post_state);

        let mut after: Vec<_> = accounts.iter().copied().filter(|(key, _)| *key != pair.0).collect();
        after.push((sender, account(0, 300)));
        assert_eq!(state.state_root(), expected_root(&after));
        assert_eq!(read(&state, &sender).unwrap(), Some(account(0, 300)));
    }

    #[test]
    fn foreign_and_malformed_nodes_do_not_change_the_trie() {
        let (accounts, _) = scenario();
        let mut state = witness(&accounts, &[accounts[5].0]);
        let before = state.clone();
        // Узлы другого дерева: им нет места — ни один дайджест не совпадёт.
        let mut other = accounts.clone();
        other[20].1.balance += U256::from(1u8);
        let (_, foreign) = root_and_proofs(&other, &[other[20].0]);
        // Корень другого дерева не совпадает с дайджестами нашего; узлы ниже корня, не задетые
        // правкой, совпали бы — но до них без своего корня не дойти.
        let foreign_root_only = &foreign[..1];
        assert_eq!(reveal_account_nodes(&mut state, foreign_root_only).unwrap(), 0);
        assert!(state == before);
        assert!(reveal_account_nodes(&mut state, &[vec![0xffu8, 0x00, 0x01]]).is_err());
        assert!(state == before);
    }
}
