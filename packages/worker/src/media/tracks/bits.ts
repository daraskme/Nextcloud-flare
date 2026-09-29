import { valid } from "../images/reader";

/** Small codec headers only; work and bounds are checked before every bit access. */
export class TrackBits {
  #at = 0;
  #reads = 0;
  constructor(
    private bytes: Uint8Array,
    private little = false,
  ) {}
  get remaining() {
    return this.bytes.length * 8 - this.#at;
  }
  get position() {
    return this.#at;
  }
  read(count: number): number {
    valid(
      Number.isInteger(count) &&
        count >= 0 &&
        count <= 32 &&
        count <= this.remaining &&
        ++this.#reads <= 131072,
    );
    let value = 0;
    for (let i = 0; i < count; i++) {
      const bit =
        (this.bytes[this.#at >> 3]! >> (this.little ? this.#at & 7 : 7 - (this.#at & 7))) & 1;
      value = this.little ? value + bit * 2 ** i : value * 2 + bit;
      this.#at++;
    }
    return value;
  }
  skip(count: number) {
    valid(Number.isSafeInteger(count) && count >= 0 && count <= this.remaining);
    this.#at += count;
  }
  padding() {
    valid(this.remaining < 8);
    valid(this.read(this.remaining) === 0);
  }
}
