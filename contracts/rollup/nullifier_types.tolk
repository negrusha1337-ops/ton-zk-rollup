// Хранилище контракта-нуллификатора. Вынесено отдельно: rollup-контракт строит по
// нему начальное состояние дочернего контракта и вычисляет его адрес.

struct NullifierStorage {
  rollup: address
  leafIndex: uint32
  claimed: bool
}
