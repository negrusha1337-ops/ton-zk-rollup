pragma circom 2.2.2;

// Пример из документации TON: доказываем знание a и b таких, что a * b = c.
// a, b — приватные; c — единственный публичный сигнал.
template Multiplier() {
    signal input a;
    signal input b;
    signal output c;

    c <== a * b;
}

component main = Multiplier();
