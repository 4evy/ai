// Bound decoded text as well as input bytes because malformed UTF-8 can expand
export function boundedText(
  bytes: Uint8Array,
  limit: number,
): { text: string; limited: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError("Text byte limit must be a nonnegative safe integer");
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    bytes.subarray(0, limit),
  );
  if (Buffer.byteLength(text) <= limit)
    return { text, limited: bytes.byteLength > limit };
  // encodeInto stops before a code point would exceed the destination capacity
  const encoded = new Uint8Array(Math.min(limit, Buffer.byteLength(text)));
  const { written } = new TextEncoder().encodeInto(text, encoded);
  return {
    text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      encoded.subarray(0, written),
    ),
    limited: true,
  };
}
