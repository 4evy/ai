const FRAME_END = 0x1f;
const MAX_CONTROL_LENGTH = 64;

/** Keep private control frames out of command output, including partial frames */
export class SudoFrames {
  #pending: Buffer = Buffer.alloc(0);
  #discardingControl = false;
  readonly #marker: Buffer;
  readonly #decoder = new TextDecoder();

  constructor(
    marker: string,
    private readonly output: (text: string) => void,
    private readonly control: (record: string) => void,
  ) {
    this.#marker = Buffer.from(marker);
  }

  #emit(bytes: Uint8Array): void {
    const text = this.#decoder.decode(bytes, { stream: true });
    if (text) this.output(text);
  }

  consume(bytes: Uint8Array, final = false): void {
    this.#pending = this.#pending.length
      ? Buffer.concat([this.#pending, bytes])
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (;;) {
      if (!this.#discardControl()) break;
      const index = this.#pending.indexOf(this.#marker);
      if (index < 0) {
        this.#flushUnframed(final);
        break;
      }
      if (index > 0) {
        this.#emit(this.#pending.subarray(0, index));
        this.#pending = this.#pending.subarray(index);
      }
      if (!this.#consumeControl(final)) break;
    }
    if (final) {
      this.#discardingControl = false;
      const text = this.#decoder.decode();
      if (text) this.output(text);
    }
  }
  #discardControl(): boolean {
    if (this.#discardingControl) {
      const end = this.#pending.indexOf(FRAME_END);
      if (end < 0) {
        this.#pending = Buffer.alloc(0);
        return false;
      }
      this.#pending = this.#pending.subarray(end + 1);
      this.#discardingControl = false;
    }
    return true;
  }

  #flushUnframed(final: boolean): void {
    let retained = Math.min(this.#marker.length - 1, this.#pending.length);
    if (final) {
      while (
        retained > 0 &&
        !this.#pending
          .subarray(this.#pending.length - retained)
          .equals(this.#marker.subarray(0, retained))
      )
        retained--;
    }
    this.#emit(this.#pending.subarray(0, this.#pending.length - retained));
    this.#pending = final
      ? Buffer.alloc(0)
      : this.#pending.subarray(this.#pending.length - retained);
  }

  #consumeControl(final: boolean): boolean {
    const end = this.#pending.indexOf(FRAME_END, this.#marker.length);
    if (end < 0) {
      if (final || this.#pending.length > this.#marker.length + MAX_CONTROL_LENGTH) {
        // Malformed private control frames are not user output
        this.#discardingControl = !final;
        this.#pending = Buffer.alloc(0);
      }
      return false;
    }
    if (end - this.#marker.length <= MAX_CONTROL_LENGTH)
      this.control(this.#pending.subarray(this.#marker.length, end).toString("ascii"));
    this.#pending = this.#pending.subarray(end + 1);
    return true;
  }
}
