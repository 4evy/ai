import { Stream } from "effect";

// Allocate decoder state per run and flush incomplete trailing bytes at EOF
export function decodeUtf8<E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Stream.Stream<string, E, R> {
  return Stream.suspend(() => {
    const decoder = new TextDecoder();
    return stream.pipe(
      Stream.map((bytes) => decoder.decode(bytes, { stream: true })),
      Stream.concat(Stream.suspend(() => Stream.succeed(decoder.decode()))),
    );
  });
}
