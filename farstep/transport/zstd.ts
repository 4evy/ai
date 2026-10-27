import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { constants, zstdCompress, zstdDecompress } from "node:zlib";
import { ConcatSink } from "@oh-my-pi/pi-utils/stream";

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);
const HEADER_BYTES = 8;
const ZSTD_MAGIC = 0xfd2fb528;
const FRAME_OVERHEAD = 131072;

function frameStream(
  convert: (source: AsyncIterable<Buffer>) => AsyncIterable<Buffer>,
) {
  const input = new PassThrough();
  // Bun's native duplex pair masks framing errors as aborts
  return Duplex.fromWeb({
    writable: Writable.toWeb(input),
    readable: Readable.toWeb(Readable.from(convert(input), { objectMode: false })),
  });
}

// Each JSONL message is an independent frame, so interactive replies flush
// immediately; native generator streams handle demand and destruction
export function zstdFrames(limit: number): Duplex {
  return frameStream(async function* (source: AsyncIterable<Buffer>) {
    const buffer = new ConcatSink();
    let bytes = 0;
    for await (const chunk of source) {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const piece = chunk.subarray(start, end + 1);
        bytes += piece.length;
        if (bytes > limit + 1) throw new Error("Helper frame exceeds byte limit");
        buffer.append(piece);
        const raw = buffer.flush();
        if (!raw) throw new Error("Missing helper frame");
        const encoded = await compress(raw, {
          maxOutputLength: limit + FRAME_OVERHEAD,
        });
        const header = Buffer.allocUnsafe(HEADER_BYTES);
        header.writeUInt32BE(encoded.length, 0);
        header.writeUInt32BE(bytes, 4);
        buffer.clear();
        bytes = 0;
        yield header;
        yield encoded;
        start = end + 1;
      }
      bytes += chunk.length - start;
      if (bytes > limit) throw new Error("Helper frame exceeds byte limit");
      buffer.append(chunk.subarray(start));
    }
    if (bytes) throw new Error("Truncated helper JSONL frame");
  });
}

export function unzstdFrames(limit: number): Duplex {
  return frameStream(async function* (source: AsyncIterable<Buffer>) {
    const buffer = new ConcatSink();
    let bytes = 0;
    let compressedBytes = 0;
    let rawBytes = 0;
    for await (const chunk of source) {
      let offset = 0;
      while (offset < chunk.length) {
        const expected = compressedBytes || HEADER_BYTES;
        const count = Math.min(expected - bytes, chunk.length - offset);
        buffer.append(chunk.subarray(offset, offset + count));
        bytes += count;
        offset += count;
        if (bytes !== expected) continue;
        const encoded = frameContents(buffer.flush());
        if (!compressedBytes) {
          ({ compressedBytes, rawBytes } = frameLengths(encoded, limit));
        } else {
          const raw = await decodeFrame(encoded, rawBytes);
          compressedBytes = 0;
          yield raw;
        }
        buffer.clear();
        bytes = 0;
      }
    }
    if (bytes || compressedBytes) throw new Error("Truncated zstd helper frame");
  });
}

function frameContents(contents: Uint8Array | undefined): Buffer {
  if (!contents) throw new Error("Missing zstd helper frame");
  return Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength);
}

function frameLengths(encoded: Buffer, limit: number) {
  const compressedBytes = encoded.readUInt32BE(0);
  const rawBytes = encoded.readUInt32BE(4);
  if (
    compressedBytes < 4 ||
    compressedBytes > limit + FRAME_OVERHEAD ||
    rawBytes < 1 ||
    rawBytes > limit + 1
  )
    throw new Error("Invalid zstd helper frame length");
  return { compressedBytes, rawBytes };
}

async function decodeFrame(encoded: Buffer, rawBytes: number): Promise<Buffer> {
  if (encoded.readUInt32LE(0) !== ZSTD_MAGIC)
    throw new Error("Expected zstd helper frame");
  const raw = await decompress(encoded, {
    maxOutputLength: rawBytes,
    params: { [constants.ZSTD_d_windowLogMax]: 26 },
  });
  if (
    raw.length !== rawBytes ||
    raw[raw.length - 1] !== 10 ||
    raw.subarray(0, -1).includes(10)
  )
    throw new Error("Invalid decoded helper JSONL frame");
  return raw;
}
