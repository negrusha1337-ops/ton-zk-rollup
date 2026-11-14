//! Проверки свидетеля состояния, которых нет в RSP.
//!
//! RSP рассчитан на то, что заголовок блока сверяется снаружи с настоящей цепочкой: неверно
//! прочитанное состояние дало бы корень «после», которого в цепочке нет. В rollup'е заголовок
//! целиком задаёт секвенсор, поэтому всё, что библиотека принимает из входа на веру, обязано
//! быть проверено здесь, ДО исполнения (находки 6-1 и 6-2 в `REVIEW.md`).
//!
//! Что проверяет сам RSP (`build_trie_db`): хеш корня дерева состояния равен корню состояния
//! родителя, корни деревьев хранилищ равны записанным в счетах. Корень родителя честный по
//! индукции, поэтому каждый раскрытый узел свидетеля обязан кодироваться ровно так же, как
//! узел настоящего дерева. Остаётся одно: разные узлы с ОДИНАКОВОЙ кодировкой.
use revm::state::Bytecode;
use rsp_mpt::{EthereumState, MptNode, MptNodeData};

use crate::EvmBatchError;

/// Длина пути до листа: ключи в деревьях состояния и хранилищ — 32-байтовые хеши.
const KEY_NIBBLES: usize = 64;

/// Пересобирает байткоды из их собственных байтов.
///
/// Байткод приходит из входа «уже разобранным»: байты с дополнением, длина исходного кода и
/// таблица допустимых переходов — и десериализация ничего из этого не проверяет. Хеш кода
/// покрывает только первые `длина` байт. Тот, кто готовит вход, мог бы объявить допустимым
/// любой адрес перехода (или ни одного) и дописать за концом кода свои инструкции — они
/// исполнились бы от имени контракта, чей код «проваливается за конец». Здесь от входа
/// остаются только байты, покрытые хешем; дополнение и таблица переходов строятся заново.
pub fn rebuild_bytecodes(bytecodes: &mut [Bytecode]) -> Result<(), EvmBatchError> {
    for code in bytecodes.iter_mut() {
        if code.len() > code.bytes_slice().len() {
            return Err(EvmBatchError::Witness("длина байткода больше самого байткода".into()));
        }
        // Любой код — обычный: в правилах Cancun делегирования EIP-7702 нет.
        *code = Bytecode::new_legacy(code.original_bytes());
    }
    Ok(())
}

/// Проверяет форму узлов дерева состояния и всех деревьев хранилищ из свидетеля.
pub fn check_state_tries(state: &EthereumState) -> Result<(), EvmBatchError> {
    check_trie(&state.state_trie)?;
    for trie in state.storage_tries.values() {
        check_trie(trie)?;
    }
    Ok(())
}

fn check_trie(root: &MptNode) -> Result<(), EvmBatchError> {
    match root.as_data() {
        // Пустое дерево.
        MptNodeData::Null => Ok(()),
        _ => check_node(root, 0).map_err(|reason| EvmBatchError::Witness(reason.into())),
    }
}

/// Узел на глубине `depth` полубайтов от корня.
///
/// Главное здесь — признак листа в пути. Лист с 32-байтовым значением и расширение, ведущее
/// в нераскрытый узел, кодируются одинаково, если не смотреть на признак: `[путь, 32 байта]`.
/// Дерево RSP при чтении признак не смотрит, поэтому расширение, выданное за лист, делало
/// все ключи под ним «доказуемо отсутствующими» при том же хеше узла. Признак входит в
/// кодировку пути, а значит и в хеш: потребовав, чтобы он соответствовал виду узла, мы
/// оставляем узлу единственное прочтение.
///
/// Остальное — канонический вид дерева: в ветке не меньше двух потомков и нет пустых узлов
/// (пустой потомок кодируется как отсутствующий, но при удалении считался бы оставшимся),
/// расширение непустое и ведёт в ветку, лист стоит ровно на глубине ключа.
fn check_node(node: &MptNode, depth: usize) -> Result<(), &'static str> {
    match node.as_data() {
        MptNodeData::Null => Err("пустой узел внутри дерева"),
        // Нераскрытое поддерево: чтение или запись под ним — ошибка, а не неверное значение.
        MptNodeData::Digest(_) => Ok(()),
        MptNodeData::Branch(children) => {
            if depth >= KEY_NIBBLES {
                return Err("ветка глубже длины ключа");
            }
            let mut present = 0;
            for child in children.iter().flatten() {
                present += 1;
                check_node(child, depth + 1)?;
            }
            if present < 2 {
                return Err("ветка меньше чем с двумя потомками");
            }
            Ok(())
        }
        MptNodeData::Leaf(path, value) => {
            let (is_leaf, nibbles) = decode_path(path)?;
            if !is_leaf {
                return Err("лист с признаком расширения в пути");
            }
            if depth + nibbles != KEY_NIBBLES {
                return Err("лист не на глубине ключа");
            }
            if value.is_empty() {
                return Err("лист без значения");
            }
            Ok(())
        }
        MptNodeData::Extension(path, child) => {
            let (is_leaf, nibbles) = decode_path(path)?;
            if is_leaf {
                return Err("расширение с признаком листа в пути");
            }
            if nibbles == 0 {
                return Err("расширение с пустым путём");
            }
            if depth + nibbles >= KEY_NIBBLES {
                return Err("расширение до глубины ключа");
            }
            match child.as_data() {
                MptNodeData::Branch(_) => check_node(child, depth + nibbles),
                MptNodeData::Digest(_) => Ok(()),
                _ => Err("расширение ведёт не в ветку"),
            }
        }
    }
}

/// Разбирает путь в кодировке «hex-prefix»: возвращает признак листа и число полубайтов.
/// Старший полубайт первого байта — флаги (2 — лист, 1 — нечётная длина); при чётной длине
/// младший полубайт первого байта обязан быть нулём.
fn decode_path(path: &[u8]) -> Result<(bool, usize), &'static str> {
    let Some(&first) = path.first() else {
        return Err("пустая кодировка пути");
    };
    let flags = first >> 4;
    if flags > 3 {
        return Err("неизвестные флаги пути");
    }
    let odd = flags & 1 == 1;
    if !odd && first & 0x0f != 0 {
        return Err("лишний полубайт в пути чётной длины");
    }
    Ok((flags & 2 != 0, 2 * (path.len() - 1) + odd as usize))
}

#[cfg(test)]
mod tests {
    use alloy_primitives::{map::B256Map, Address, Bytes, B256, U256};
    use reth_primitives_traits::Account;
    use reth_trie::{HashedPostState, HashedStorage};
    use revm::bytecode::JumpTable;

    use super::*;

    fn node(data: MptNodeData) -> MptNode {
        data.into()
    }

    fn digest() -> Box<MptNode> {
        Box::new(node(MptNodeData::Digest(B256::repeat_byte(7))))
    }

    /// Путь в кодировке hex-prefix из чётного числа полубайтов.
    fn even_path(leaf: bool, nibbles: usize) -> Vec<u8> {
        assert_eq!(nibbles % 2, 0);
        let mut path = vec![if leaf { 0x20 } else { 0x00 }];
        path.extend(std::iter::repeat(0xab).take(nibbles / 2));
        path
    }

    fn branch(children: Vec<(usize, Box<MptNode>)>) -> MptNode {
        let mut slots: [Option<Box<MptNode>>; 16] = Default::default();
        for (index, child) in children {
            slots[index] = Some(child);
        }
        node(MptNodeData::Branch(slots))
    }

    fn reason(root: &MptNode) -> Result<(), EvmBatchError> {
        check_trie(root)
    }

    fn rejected(root: &MptNode, expected: &str) {
        assert_eq!(reason(root), Err(EvmBatchError::Witness(expected.into())));
    }

    #[test]
    fn canonical_shapes_are_accepted() {
        assert_eq!(reason(&node(MptNodeData::Null)), Ok(()));
        assert_eq!(reason(&digest()), Ok(()));
        // Дерево из одного ключа: лист в корне с путём во всю длину ключа.
        assert_eq!(reason(&node(MptNodeData::Leaf(even_path(true, 64), vec![1]))), Ok(()));
        // Расширение на два полубайта → ветка → лист на оставшиеся 61 и нераскрытый сосед.
        let mut odd_leaf_path = vec![0x3a];
        odd_leaf_path.extend([0xbc; 30]);
        let inner = branch(vec![(0, Box::new(node(MptNodeData::Leaf(odd_leaf_path, vec![1])))), (5, digest())]);
        assert_eq!(reason(&node(MptNodeData::Extension(even_path(false, 2), Box::new(inner)))), Ok(()));
    }

    #[test]
    fn extension_presented_as_a_leaf_is_rejected() {
        // Та самая подмена: «лист», чьё значение — 32 байта хеша поддерева, а путь несёт
        // признак расширения. Кодировка и хеш те же, что у расширения в нераскрытый узел.
        let fake_leaf = node(MptNodeData::Leaf(even_path(false, 2), vec![7u8; 32]));
        let honest = node(MptNodeData::Extension(even_path(false, 2), digest()));
        assert_eq!(fake_leaf.hash(), honest.hash(), "подмена не меняет хеш узла");
        rejected(&fake_leaf, "лист с признаком расширения в пути");
        // И внутри дерева, а не только в корне.
        rejected(&branch(vec![(1, Box::new(fake_leaf)), (2, digest())]), "лист с признаком расширения в пути");
        // Обратная подмена.
        rejected(
            &node(MptNodeData::Extension(even_path(true, 2), digest())),
            "расширение с признаком листа в пути",
        );
    }

    #[test]
    fn deleting_next_to_an_unrevealed_node_is_an_error() {
        // Ветка из листа и нераскрытого соседа. После удаления листа сосед остался бы один, а
        // что под ним — неизвестно: правка в копии rsp-mpt требует раскрыть узел.
        let key = leaf_key();
        let mut trie = leaf_and_unrevealed_sibling();
        assert_eq!(reason(&trie), Ok(()));
        assert_eq!(trie.get(key.as_slice()).unwrap(), Some(&[1u8][..]));
        assert!(matches!(trie.delete(key.as_slice()), Err(rsp_mpt::Error::NodeNotResolved(_))));
    }

    /// Ключ листа из `leaf_and_unrevealed_sibling_with`: полубайты 0, a, затем байт `tail` × 31.
    fn leaf_key_with(tail: u8) -> B256 {
        let mut key = [tail; 32];
        key[0] = 0x0a;
        B256::from(key)
    }

    /// Ветка: под полубайтом 0 — лист с ключом `leaf_key_with(tail)`, под полубайтом 5 —
    /// нераскрытый сосед.
    fn leaf_and_unrevealed_sibling_with(tail: u8) -> MptNode {
        let mut leaf_path = vec![0x3a];
        leaf_path.extend([tail; 31]);
        branch(vec![(0, Box::new(node(MptNodeData::Leaf(leaf_path, vec![1])))), (5, digest())])
    }

    fn leaf_key() -> B256 {
        leaf_key_with(0xbc)
    }

    fn leaf_and_unrevealed_sibling() -> MptNode {
        leaf_and_unrevealed_sibling_with(0xbc)
    }

    #[test]
    fn insertions_go_before_deletions() {
        // Блок обнуляет слот-лист и пишет новый слот под ту же ветку. Если удалить первым, в ветке
        // останется один нераскрытый сосед — ошибка; если сначала вставить — всё корректно. Исход
        // не должен зависеть от порядка обхода HashMap: подбираем пару ключей так, чтобы обход
        // начинался с удаляемого, — без правки порядка такой вход паникует.
        let mut found = None;
        'search: for tail in 0u8..=255 {
            let deleted = leaf_key_with(tail);
            for candidate in 0u8..=255 {
                let mut key = [candidate; 32];
                key[0] = 0xf0;
                let key = B256::from(key);
                let mut storage = B256Map::default();
                storage.insert(deleted, U256::ZERO);
                storage.insert(key, U256::from(7u8));
                if storage.iter().next().unwrap().0 == &deleted {
                    found = Some((tail, deleted, key, storage));
                    break 'search;
                }
            }
        }
        let (tail, deleted, inserted, storage) =
            found.expect("нашлась пара ключей, при которой обход начинается с удаляемого");

        let account = B256::repeat_byte(0x42);
        let mut state = EthereumState { state_trie: node(MptNodeData::Null), storage_tries: Default::default() };
        state.storage_tries.insert(account, leaf_and_unrevealed_sibling_with(tail));
        let mut post_state = HashedPostState::default();
        post_state.accounts.insert(account, Some(Account { nonce: 1, balance: U256::ZERO, bytecode_hash: None }));
        post_state.storages.insert(account, HashedStorage { wiped: false, storage });

        state.update(&post_state);
        let trie = &state.storage_tries[&account];
        assert_eq!(trie.get(deleted.as_slice()).unwrap(), None);
        assert!(trie.get(inserted.as_slice()).unwrap().is_some());
        assert_eq!(check_state_tries(&state), Ok(()));
    }

    #[test]
    fn storage_tries_are_checked_too() {
        // Дерево состояния честное (пустое), подмена — в дереве хранилища.
        let mut state = EthereumState { state_trie: node(MptNodeData::Null), storage_tries: Default::default() };
        assert_eq!(check_state_tries(&state), Ok(()));
        state.storage_tries.insert(B256::repeat_byte(1), leaf_and_unrevealed_sibling());
        assert_eq!(check_state_tries(&state), Ok(()));
        state.storage_tries.insert(B256::repeat_byte(2), node(MptNodeData::Leaf(even_path(false, 2), vec![7u8; 32])));
        assert_eq!(
            check_state_tries(&state),
            Err(EvmBatchError::Witness("лист с признаком расширения в пути".into()))
        );
    }

    #[test]
    fn node_under_an_extension_is_checked() {
        // Подмена не в корне и не прямо под веткой корня, а под «расширение → ветка».
        let fake_leaf = Box::new(node(MptNodeData::Leaf(even_path(false, 2), vec![7u8; 32])));
        let inner = branch(vec![(0, fake_leaf), (5, digest())]);
        rejected(
            &node(MptNodeData::Extension(even_path(false, 2), Box::new(inner))),
            "лист с признаком расширения в пути",
        );
    }

    #[test]
    fn rebuilt_bytecode_depends_only_on_the_hashed_bytes() {
        // Код: JUMPDEST, PUSH1 0x5b, STOP. Байт 0x5b внутри PUSH — данные, а не точка перехода.
        let original = Bytes::from_static(&[0x5b, 0x60, 0x5b, 0x00]);
        let honest = Bytecode::new_legacy(original.clone());
        // Во входе: тот же код, но за ним дописаны инструкции, а таблица переходов объявляет
        // допустимым любой адрес, включая данные PUSH.
        let mut padded = original.to_vec();
        padded.extend_from_slice(&[0x60, 0x01, 0x5f, 0x55]);
        padded.extend_from_slice(&[0u8; 33]);
        let everything_is_a_jumpdest = JumpTable::from_slice(&vec![0xff; padded.len().div_ceil(8)], padded.len());
        let tampered = Bytecode::new_analyzed(Bytes::from(padded), original.len(), everything_is_a_jumpdest);
        assert_eq!(tampered.hash_slow(), honest.hash_slow(), "подмена не меняет хеш кода");
        assert_ne!(tampered.bytes_slice(), honest.bytes_slice());
        assert_ne!(tampered.legacy_jump_table(), honest.legacy_jump_table());

        let mut codes = [tampered];
        rebuild_bytecodes(&mut codes).unwrap();
        assert_eq!(codes[0].bytes_slice(), honest.bytes_slice());
        assert_eq!(codes[0].legacy_jump_table(), honest.legacy_jump_table());
        assert_eq!(codes[0].len(), original.len());
    }

    #[test]
    fn bytecode_with_delegation_marker_becomes_ordinary_code() {
        // В правилах Cancun делегирований нет: код вида 0xef0100‖адрес — обычный код.
        let mut codes = [Bytecode::new_eip7702(Address::repeat_byte(9))];
        let original = codes[0].original_bytes();
        assert!(!codes[0].is_legacy());
        rebuild_bytecodes(&mut codes).unwrap();
        assert!(codes[0].is_legacy());
        assert_eq!(codes[0].original_bytes(), original);
    }

    #[test]
    fn bytecode_longer_than_its_bytes_is_rejected() {
        // Длину исходного кода больше самого буфера нельзя задать через конструкторы — только
        // через десериализацию входа. В bincode: номер варианта (4 байта), длина и байты
        // буфера, затем длина исходного кода (8 байт).
        let honest = Bytecode::new_legacy(Bytes::from_static(&[0x60, 0x01, 0x00]));
        let padded_len = honest.bytes_slice().len();
        let mut encoded = bincode::serialize(&honest).unwrap();
        let offset = 4 + 8 + padded_len;
        assert_eq!(encoded[offset..offset + 8], (honest.len() as u64).to_le_bytes());
        encoded[offset..offset + 8].copy_from_slice(&(padded_len as u64 + 1).to_le_bytes());
        let mut codes = [bincode::deserialize::<Bytecode>(&encoded).unwrap()];
        assert_eq!(
            rebuild_bytecodes(&mut codes),
            Err(EvmBatchError::Witness("длина байткода больше самого байткода".into()))
        );
    }

    #[test]
    fn non_canonical_shapes_are_rejected() {
        rejected(&branch(vec![(3, digest())]), "ветка меньше чем с двумя потомками");
        rejected(
            &branch(vec![(3, digest()), (4, Box::new(node(MptNodeData::Null)))]),
            "пустой узел внутри дерева",
        );
        rejected(&node(MptNodeData::Leaf(even_path(true, 62), vec![1])), "лист не на глубине ключа");
        rejected(&node(MptNodeData::Leaf(even_path(true, 64), vec![])), "лист без значения");
        rejected(&node(MptNodeData::Extension(even_path(false, 0), digest())), "расширение с пустым путём");
        rejected(&node(MptNodeData::Extension(even_path(false, 64), digest())), "расширение до глубины ключа");
        let leaf_child = Box::new(node(MptNodeData::Leaf(even_path(true, 62), vec![1])));
        rejected(&node(MptNodeData::Extension(even_path(false, 2), leaf_child)), "расширение ведёт не в ветку");
        rejected(&node(MptNodeData::Leaf(vec![], vec![1])), "пустая кодировка пути");
        rejected(&node(MptNodeData::Leaf(vec![0x40], vec![1])), "неизвестные флаги пути");
        rejected(&node(MptNodeData::Leaf(vec![0x2f], vec![1])), "лишний полубайт в пути чётной длины");
    }
}
