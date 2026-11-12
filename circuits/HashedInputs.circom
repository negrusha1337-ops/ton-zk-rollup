pragma circom 2.2.2;

include "circomlib/circuits/sha256/sha256.circom";

// Вариант «один публичный вход»: схема принимает 4 значения по 256 бит
// (old state root, new state root, batch hash, withdrawals root) как
// ПРИВАТНЫЕ биты, считает SHA-256 от их конкатенации (128 байт) и отдаёт
// наружу единственный публичный сигнал h = sha256(...) mod 2^253.
//
// Обрезка до 253 бит нужна, потому что скалярное поле BLS12-381 (~2^255)
// не вмещает 256-битное значение. Контракт на TON повторяет то же самое:
// HASHEXT_SHA256 по тем же 128 байтам и маска 2^253 - 1.
//
// Порядок битов: big-endian, как в circomlib (in[0] — старший бит первого байта).
template HashedInputs(NVALUES) {
    var NBITS = NVALUES * 256;

    signal input preimage[NBITS];
    signal output h;

    component sha = Sha256(NBITS);
    for (var i = 0; i < NBITS; i++) {
        // circomlib Sha256 не проверяет, что входы — биты; делаем это сами.
        preimage[i] * (preimage[i] - 1) === 0;
        sha.in[i] <== preimage[i];
    }

    // sha.out[0] — старший бит дайджеста. Отбрасываем 3 старших бита.
    var acc = 0;
    var pow = 1;
    for (var i = 0; i < 253; i++) {
        acc += sha.out[255 - i] * pow;
        pow = pow * 2;
    }
    h <== acc;
}

component main = HashedInputs(4);
