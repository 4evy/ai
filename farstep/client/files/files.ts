import { isUtf8 } from "node:buffer";
import { hash as digest } from "node:crypto";
import { attempt, run } from "@ai/core/effect/effect";
import { quotePosixArgument } from "@ai/core/shell/shell";
import { Effect } from "effect";
import { MAX_FILE_BYTES } from "../../protocol/files/files";
import { type ScriptTransport, scriptCommandEffect } from "../execution/execution";

export interface FileTransport {
  stat(path: string, signal?: AbortSignal): Promise<string>;
  read(
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; truncated: boolean }>;
  write(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  list(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; isDirectory: boolean }[]>;
  command: ScriptTransport;
}

export function hash(bytes: Uint8Array): string {
  return digest("sha256", bytes);
}

export function checkHash(bytes: Uint8Array, expected?: string): void {
  if (expected !== undefined && hash(bytes) !== expected)
    throw new Error(
      "Remote file changed since the expected read; read it again before editing",
    );
}

export class RemoteFiles {
  constructor(private readonly transport: FileTransport) {}

  stat(path: string, signal?: AbortSignal) {
    return this.transport.stat(path, signal);
  }
  list(path: string, signal?: AbortSignal) {
    return this.transport.list(path, signal);
  }

  async read(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const result = await this.transport.read(path, MAX_FILE_BYTES, signal);
    if (result.truncated)
      throw new Error(
        `Remote file exceeds ${MAX_FILE_BYTES} bytes; use run with this connection's target for larger files`,
      );
    return result.bytes;
  }

  async write(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (bytes.length > MAX_FILE_BYTES)
      throw new Error("Content exceeds the 16 MiB transfer limit");
    await this.transport.write(path, bytes, signal);
  }

  edit<T>(
    path: string,
    expectedHash: string | undefined,
    edit: (original: Uint8Array) => Promise<{ result: T; bytes?: Uint8Array }>,
    signal?: AbortSignal,
  ): Promise<{ result: T; sha256?: string }> {
    return run(
      Effect.gen({ self: this }, function* () {
        const kind = yield* attempt((active) => this.stat(path, active));
        if (kind !== "file")
          return yield* Effect.fail(
            new Error("Edit requires an existing regular file"),
          );
        const original = yield* attempt((active) => this.read(path, active));
        yield* Effect.try({
          try: () => {
            checkHash(original, expectedHash);
            // Preserve the decoder's invalid-input error without materializing valid text
            if (!isUtf8(original))
              new TextDecoder("utf-8", { fatal: true }).decode(original);
            if (original.includes(0))
              throw new Error("Edit requires text without NUL bytes");
          },
          catch: (error) => error,
        });
        const { result, bytes } = yield* attempt(() => edit(original), {
          awaitOnInterrupt: true,
        });
        if (bytes === undefined) return { result };
        if (bytes.length > MAX_FILE_BYTES)
          return yield* Effect.fail(
            new Error("Edited file exceeds the 16 MiB transfer limit"),
          );
        const current = yield* attempt((active) => this.read(path, active));
        yield* Effect.try({
          try: () => checkHash(current, hash(original)),
          catch: (error) => error,
        });
        // Wait for an in-flight write to settle before reporting cancellation
        yield* attempt((active) => this.write(path, bytes, active), {
          awaitOnInterrupt: true,
        });
        return { result, sha256: hash(bytes) };
      }),
      signal,
    );
  }

  async delete(path: string, signal?: AbortSignal): Promise<void> {
    const quoted = quotePosixArgument(path);
    const script = `if [ -L ${quoted} ] || [ -f ${quoted} ]; then rm -- ${quoted}; else printf '%s\\n' 'Delete requires an existing file or symlink' >&2; exit 1; fi`;
    await run(scriptCommandEffect(this.transport.command, script), signal);
  }
}
