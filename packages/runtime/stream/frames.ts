import { Transform, type TransformCallback } from "node:stream";

// Bound each SDK JSONL frame before decoding, excluding its LF terminator
export class BoundedFrames extends Transform {
  private bytes = 0;
  private readonly limit: number;
  private readonly errorMessage: string;
  constructor(limit: number, errorMessage = "Helper frame exceeds byte limit") {
    super();
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RangeError("Frame byte limit must be a nonnegative safe integer");
    this.limit = limit;
    this.errorMessage = errorMessage;
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      this.bytes += end - start;
      if (this.bytes > this.limit) return callback(new Error(this.errorMessage));
      this.bytes = 0;
      start = end + 1;
    }
    this.bytes += chunk.length - start;
    if (this.bytes > this.limit) return callback(new Error(this.errorMessage));
    callback(null, chunk);
  }
}
