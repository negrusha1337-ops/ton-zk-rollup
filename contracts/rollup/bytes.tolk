// Байтовые строки в сообщениях: «змейка» ячеек и keccak-256 от её содержимого.
//
// Строка (подписанная транзакция EVM, заголовок блока, узел дерева состояния) приходит цепочкой
// ячеек: в каждой — целое число байт и не больше одной ссылки на продолжение. Резать строку
// можно где угодно: хеш считается из прочитанных битов, поэтому от нарезки не зависит.
//
// Ячейки читаются через XCTOS, экзотические отвергаются. Обычное чтение (CTOS) вместо ссылки на
// библиотеку молча подставило бы содержимое библиотеки: байты пришли бы не из сообщения L1, и
// тот, кто собирает свидетель для программы zkVM по сообщениям, их бы не нашёл.
import "@stdlib/exotic-cells"

@pure fun keccak256OfBuilder(b: builder, count: int): uint256 asm "HASHEXT_KECCAK256"
/// keccak-256 склейки срезов: кортеж раскладывается на стек вместе с числом элементов.
/// В кортеже не больше 255 элементов — вызывающий ограничивает число ячеек строки.
@pure fun keccak256OfParts(parts: array<slice>): uint256 asm "255 PUSHINT EXPLODEVAR HASHEXT_KECCAK256"

/// Срезы «змейки» по порядку: только данные, без ссылок. Не больше `maxParts` ячеек
/// (и не больше 255: предел кортежа). Любое нарушение формы — исключение `errorCode`.
@inline_ref
fun byteParts(root: cell, maxParts: int, errorCode: int): array<slice> {
  var parts: array<slice> = [];
  var current = root;
  var more = true;
  while (more) {
    var (s, isExotic) = current.beginParseSpecial();
    assert (!isExotic) throw errorCode;
    val bits = s.remainingBitsCount();
    assert (bits % 8 == 0) throw errorCode;
    parts.push(s.loadBits(bits));
    assert (parts.size() <= maxParts) throw errorCode;
    val refs = s.remainingRefsCount();
    assert (refs <= 1) throw errorCode;
    if (refs == 1) {
      current = s.loadRef();
    } else {
      more = false;
    }
  }
  return parts;
}

/// Суммарная длина срезов «змейки» в битах.
@inline_ref
fun totalBits(parts: array<slice>): int {
  var bits = 0;
  var index = 0;
  while (index < parts.size()) {
    bits += parts.get(index).remainingBitsCount();
    index += 1;
  }
  return bits;
}
