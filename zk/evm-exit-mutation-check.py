#!/usr/bin/env python3
"""Проверка тестов аварийного выхода EVM мутациями контракта.

    python3 zk/evm-exit-mutation-check.py

Убирает по одной защите из contracts/rollup/evm_exit.tolk и запускает из набора
tests/RollupEvmExit.spec.ts два теста: тот, что обязан эту мутацию убить, и контрольный,
который контракта не касается. Контрольный падает, только если мутант не собрался (сборка
идёт в общем beforeAll) — так «не собралась» не выдаётся за «убита». Мутация убита, если
контрольный прошёл, а её тест упал.

Исходник на время работы лежит копией рядом (*.orig): после сбоя следующий запуск вернёт его
сам. Пока копия лежит, в рабочем дереве — мутант: тесты в bench ничего не пишут
(tests/helpers/benchResults.ts), а другие прогоны jest в это время запускать нельзя. Итог —
bench/evm-exit-mutation-report.txt. Нагрузка: компиляция контракта и два теста на мутацию,
по одной.
"""
import datetime
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "contracts/rollup/evm_exit.tolk"
BACKUP = SOURCE.with_suffix(".tolk.orig")
REPORT = ROOT / "bench/evm-exit-mutation-report.txt"
CONTROL = "упаковщик отказывается от строки с хвостом после списка RLP"

POSITIVE = "счёт выходит по заголовку, доказательству и подписи: выплата получателю, один раз"
CONSENT = "val consent = evmExitConsent(storage.chainId, state.stateRoot, recipientHash);"
REJECTS = "получатель вне basechain, негодная подпись и нехватка монет отклоняются"

# (название, что заменить, на что, тест, который обязан упасть)
MUTATIONS = [
    # --- условия выхода ---
    ("заморозка не проверяется",
     "  assert (state.frozen) throw RollupErrors.RollupNotFrozen;\n  assert (valueCoins >= evmExitMinValue())",
     "  assert (valueCoins >= evmExitMinValue())", "до заморозки выхода нет"),
    ("минимум монет не проверяется",
     "  assert (valueCoins >= evmExitMinValue()) throw RollupErrors.NotEnoughValue;\n", "", REJECTS),
    ("запас газа шага — прежние 400 тыс.",
     "const EVM_EXIT_STEP_GAS: int = 500000", "const EVM_EXIT_STEP_GAS: int = 400000",
     "глубокое дерево: десять полных веток и лист"),
    ("получатель вне basechain допустим",
     "  assert (workchain == BASECHAIN) throw RollupErrors.WrongRecipient;\n\n  // Заголовок", "\n  // Заголовок", REJECTS),
    ("нулевой баланс выходит",
     "  assert (amount > 0) throw RollupErrors.NothingToExit;\n", "", "баланс меньше нанотона"),
    ("баланс не делится на цену нанотона",
     "val amount = balance / EVM_WEI_PER_NANOTON;", "val amount = balance;", POSITIVE),
    ("деньги контракта не сверяются с суммой выхода",
     "  assertCanPay(amount as coins, valueCoins);\n", "", "баланс больше денег контракта"),

    # --- подпись и согласие ---
    ("получатель не входит в согласие", CONSENT,
     "val consent = evmExitConsent(storage.chainId, state.stateRoot, 0);", POSITIVE),
    ("хеш блока не входит в согласие", CONSENT,
     "val consent = evmExitConsent(storage.chainId, 0, recipientHash);", POSITIVE),
    ("chainId не входит в согласие", CONSENT,
     "val consent = evmExitConsent(0, state.stateRoot, recipientHash);", POSITIVE),
    ("адрес счёта — не из подписи, а нулевой",
     "val key = keccak256OfBuilder(beginCell().storeUint(account, 160), 1);",
     "val key = keccak256OfBuilder(beginCell().storeUint(0, 160), 1);", POSITIVE),
    ("негодная подпись принимается",
     "  assert (recovered) throw EvmExitErrors.BadSignature;\n", "", REJECTS),

    # --- цепочка хешей ---
    ("хеш заголовка не сверяется со словом состояния",
     "  assert (keccak256OfParts(headerParts) == state.stateRoot) throw EvmExitErrors.WrongBlockHeader;\n", "",
     "чужой заголовок не подходит"),
    ("хеш узла не сверяется",
     "    assert (keccak256OfParts(parts) == expected) throw EvmExitErrors.WrongNodeHash;\n", "",
     "изменённый узел доказательства не подходит"),

    # --- раскладка по ячейкам и чтение ---
    ("строка не обязана состоять из целых байтов",
     "    assert (bits % 8 == 0) throw EvmExitErrors.BadEncoding;\n", "",
     "лишний бит: строка не из целых байтов"),
    ("число ячеек строки не ограничено",
     "    assert (parts.size() <= EVM_MAX_PARTS) throw EvmExitErrors.BadEncoding;\n", "",
     "узел в двенадцати ячейках принимается, в тринадцати — нет"),
    ("у ячейки строки может быть больше одной ссылки",
     "    assert (refs <= 1) throw EvmExitErrors.BadEncoding;\n", "",
     "две ссылки у ячейки узла: продолжение неоднозначно"),
    ("чтение за концом строки не проверяется",
     "    assert (self.next < self.parts.size()) throw EvmExitErrors.BadNode;\n", "",
     "ветка из двух элементов"),
    ("единица может быть разрезана ячейками",
     "  assert (self.current.remainingBitsCount() >= bytes * 8) throw EvmExitErrors.BadEncoding;\n", "",
     "узел, разрезанный посреди читаемой единицы, отвергается"),
    ("конец строки — конец текущей ячейки, остальные не смотрятся",
     "  return self.current.isEndOfBits() && (self.next == self.parts.size());",
     "  return self.current.isEndOfBits();",
     "пустая ячейка в конце строки: узел не кончился там, где кончились байты"),

    # --- признаки RLP ---
    ("признак списка не проверяется",
     "    assert ((b >= 0xc0) && (b <= 0xf7)) throw EvmExitErrors.BadRlp;\n", "",
     "узел начинается не с признака списка"),
    ("длина длинного списка читается одним байтом вместо двух",
     "  } else if (b == 0xf9) {\n    self.take(2);", "  } else if (b == 0xf9) {\n    self.take(1);", POSITIVE),
    ("признак хеша не проверяется",
     "  assert (b == 0xa0) throw EvmExitErrors.BadRlp;\n", "",
     "лист с признаком расширения в пути листом не считается"),
    ("длина строки пути не ограничена",
     "  assert ((b >= 0x81) && (b <= 0xa1)) throw EvmExitErrors.BadRlp;\n", "",
     "узел с пустой строкой вместо пути"),
    ("путь из одного байта читается неверно",
     "    return (1, b, 0);", "    return (1, 0, b);", "расширение на один полубайт, ветка и лист"),
    ("длина числа не ограничена 32 байтами",
     "  assert (b <= 0xa0) throw EvmExitErrors.BadRlp;\n", "", "nonce длиной 33 байта"),

    # --- значение счёта ---
    ("признак строки у значения листа не проверяется",
     "    assert ((b >= 0x80) && (b <= 0xb7)) throw EvmExitErrors.BadRlp;\n", "",
     "перед списком счёта лишний байт вместо признака строки"),
    ("длина значения листа не читается",
     "  if (b == 0xb8) {\n    self.take(1);\n  } else {", "  if (b == 0xb8) {\n  } else {", POSITIVE),
    ("nonce читается одним байтом",
     "  self.scalar();\n  val balance = self.scalar();", "  self.take(1);\n  val balance = self.scalar();",
     "большой nonce и баланс больше 2^64 wei"),
    ("корень хранилища счёта может быть пуст",
     "  assert (self.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  assert (self.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  return balance;",
     "  self.hashOrEmpty();\n  assert (self.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  return balance;",
     "корень хранилища счёта пуст"),
    ("хеш кода счёта может быть пуст",
     "  assert (self.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  assert (self.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  return balance;",
     "  assert (self.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  self.hashOrEmpty();\n  return balance;",
     "хеш кода счёта пуст"),

    # --- заголовок ---
    ("хеш родителя в заголовке может быть пуст",
     "  assert (reader.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  assert (reader.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  assert (reader.take(1) == 0x94)",
     "  reader.hashOrEmpty();\n  assert (reader.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  assert (reader.take(1) == 0x94)",
     "заголовок без хеша родителя"),
    ("хеш «дядей» в заголовке может быть пуст",
     "  assert (reader.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  assert (reader.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  assert (reader.take(1) == 0x94)",
     "  assert (reader.hashOrEmpty() != -1) throw EvmExitErrors.BadRlp;\n  reader.hashOrEmpty();\n  assert (reader.take(1) == 0x94)",
     "заголовок без хеша «дядей»"),
    ("признак получателя наград в заголовке не проверяется",
     "  assert (reader.take(1) == 0x94) throw EvmExitErrors.BadRlp;", "  reader.take(1);",
     "заголовок со списком на месте получателя наград"),
    ("корень состояния в заголовке может быть пуст",
     "  assert (root != -1) throw EvmExitErrors.BadRlp;\n", "", "заголовок без корня состояния"),

    # --- ветка ---
    ("ветка допустима и после конца ключа",
     "      assert (depth < 64) throw EvmExitErrors.KeyNotInTrie;\n", "",
     "расширение на 64 полубайта и ветка под ним"),
    ("семнадцатый элемент ветки не обязан быть пустым",
     "      assert (reader.take(1) == 0x80) throw EvmExitErrors.BadNode;", "      reader.take(1);",
     "ветка с непустым семнадцатым элементом"),
    ("ветка не обязана кончаться на семнадцатом элементе",
     "      assert (reader.atEnd()) throw EvmExitErrors.BadNode;\n      assert (child != -1)", "      assert (child != -1)",
     "ветка с восемнадцатью элементами"),
    ("пустой потомок ветки на пути ключа допустим",
     "      assert (child != -1) throw EvmExitErrors.KeyNotInTrie;\n      expected = child;\n      depth += 1;",
     "      expected = child;\n      depth += 1;", "пустой потомок ветки на пути ключа"),

    # --- путь ---
    ("признаки пути больше трёх допустимы",
     "      assert (flags <= 3) throw EvmExitErrors.BadNode;\n", "", "путь с неизвестным признаком"),
    ("добавочный полубайт чётного пути не обязан быть нулём",
     "      assert (odd || ((first & 15) == 0)) throw EvmExitErrors.BadNode;\n", "",
     "чётный путь с ненулевым добавочным полубайтом"),
    ("путь может выйти за конец ключа",
     "      assert (depth + nibbles <= 64) throw EvmExitErrors.KeyNotInTrie;\n", "",
     "под двумя ветками лист, чей путь выходит за конец ключа"),
    ("путь узла не сверяется с ключом",
     "      assert (pathValue == keyPart) throw EvmExitErrors.KeyNotInTrie;\n", "", "лист чужого ключа"),
    ("признак листа не смотрится: любой узел с путём — лист",
     "      if ((flags & 2) == 2) {", "      if (true) {", "расширение с нечётным путём, ветка и лист"),
    ("признак листа не смотрится: любой узел с путём — расширение",
     "      if ((flags & 2) == 2) {", "      if (false) {", "единственный счёт: лист в корне с путём во весь ключ"),

    # --- лист и расширение ---
    ("лист не обязан стоять на глубине ключа",
     "        assert (depth == 64) throw EvmExitErrors.KeyNotInTrie;\n", "", "лист с путём не до конца ключа"),
    ("лист не обязан кончаться на значении счёта",
     "        assert (reader.atEnd()) throw EvmExitErrors.BadNode;\n        assert (step.next == null)",
     "        assert (step.next == null)", "лист с третьим элементом"),
    ("после листа допустимы ещё узлы",
     "        assert (step.next == null) throw EvmExitErrors.BadNode;\n", "",
     "оборванное и продолженное доказательство не подходят"),
    ("расширение с пустым путём допустимо",
     "      assert (nibbles > 0) throw EvmExitErrors.BadNode;\n", "", "расширение с пустым путём"),
    ("расширение без потомка допустимо",
     "      assert (child != -1) throw EvmExitErrors.BadNode;\n", "", "расширение без потомка"),
    ("расширение не обязано кончаться на потомке",
     "      assert (reader.atEnd()) throw EvmExitErrors.BadNode;\n      expected = child;\n    }", "      expected = child;\n    }",
     "расширение с третьим элементом"),
    ("доказательство может оборваться до листа",
     "    assert (step.next != null) throw EvmExitErrors.KeyNotInTrie;\n", "",
     "оборванное и продолженное доказательство не подходят"),
]

# Проверки, чьё снятие поведения не меняет: мутировать их бессмысленно, перечислены для отчёта.
EQUIVALENT = [
    "верхняя граница суммы (amount < 2^120): то же отвергает сверка с деньгами контракта, тем же кодом",
    "ноль как 0x80 в числе RLP: без отдельной ветви читается ноль байт — тот же ноль (с точностью до "
    "негодной раскладки с пустой ячейкой сразу после 0x80: байты и хеш те же)",
    "число из одного байта (< 0x80): nonce не используется, а баланс меньше 128 wei не выходит",
    "приведение v = 27/28 к номеру восстановления 0/1: в Sandbox наблюдалось, что без этой строки "
    "выход с v = 27/28 проходит так же (одно наблюдение, поведение ECRECOVER не описано); строка "
    "оставлена, чтобы формат подписи от опкода не зависел",
]


def run_tests(names):
    """Запускает тесты с этими именами (None — весь набор); возвращает (код, прошедшие, упавшие)."""
    command = ["nice", "-n", "15", "npx", "jest", "tests/RollupEvmExit.spec.ts", "--runInBand"]
    if names is not None:
        command += ["-t", "|".join(re.escape(name) + "$" for name in names)]
    result = subprocess.run(
        command, cwd=ROOT, capture_output=True, text=True, env={**os.environ, "EVM_EXIT_NO_BENCH": "1"},
    )
    output = result.stdout + result.stderr
    passed = {name.strip() for name in re.findall(r"✓ (.+?)(?: \(\d+ ms\))?$", output, re.M)}
    failed = {name.strip() for name in re.findall(r"✕ (.+?)(?: \(\d+ ms\))?$", output, re.M)}
    return result.returncode, passed, failed


def main() -> int:
    if BACKUP.exists():
        # Копия осталась от прерванного запуска. Возвращаем её, только если в исходнике лежит
        # она же или она с одной из мутаций: иначе там чьи-то правки, и затирать их нельзя.
        saved, current = BACKUP.read_text(), SOURCE.read_text()
        if current != saved and all(current != saved.replace(old, new) for _, old, new, _ in MUTATIONS):
            print(f"Найдена копия {BACKUP.name}, но исходник — не она и не она с мутацией: разберись вручную.")
            return 2
        print("Найдена копия исходника от прерванного запуска — возвращаю её.")
        SOURCE.write_text(saved)
        BACKUP.unlink()
    original = SOURCE.read_text()
    code, _, failed = run_tests(None)
    if code != 0:
        print("Тесты падают и без мутаций:", *sorted(failed), sep="\n  ")
        return 2
    lines, bad = [], 0
    BACKUP.write_text(original)
    try:
        for name, old, new, expected in MUTATIONS:
            if original.count(old) != 1:
                verdict = f"НЕ ПРИМЕНЕНА (образец найден {original.count(old)} раз)"
            else:
                SOURCE.write_text(original.replace(old, new))
                _, passed, failed = run_tests([expected, CONTROL])
                SOURCE.write_text(original)
                if CONTROL not in passed:
                    verdict = "НЕ СОБРАЛАСЬ"
                elif expected in failed:
                    verdict = "убита"
                elif expected in passed:
                    verdict = "ВЫЖИЛА"
                else:
                    verdict = "ТЕСТ НЕ НАЙДЕН"
            if verdict != "убита":
                bad += 1
            line = f"{verdict:<13} {name}  [тест «{expected}»]"
            print(line, flush=True)
            lines.append(line)
    finally:
        SOURCE.write_text(original)
        BACKUP.unlink()
    code, _, failed = run_tests(None)
    if code != 0:
        print("После возврата исходника тесты падают — результатам верить нельзя.")
        return 2
    summary = f"Мутаций: {len(MUTATIONS)}, не убито ожидаемым тестом: {bad}"
    print("\n" + summary)
    REPORT.write_text(
        f"Проверка тестов аварийного выхода EVM мутациями контракта, {datetime.date.today().isoformat()}\n"
        "Команда: python3 zk/evm-exit-mutation-check.py\n"
        "На каждую мутацию запускаются её тест и контрольный (контракта не касается: падает, только\n"
        "если мутант не собрался). «убита» — контрольный прошёл, тест мутации упал.\n\n"
        + "\n".join(lines)
        + "\n\nНе мутируются — снятие проверки поведения не меняет:\n"
        + "\n".join(f"  - {item}" for item in EQUIVALENT)
        + "\n\n" + summary + "\n"
    )
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
