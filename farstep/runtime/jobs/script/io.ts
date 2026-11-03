import { Buffer } from "node:buffer";
import type { StdioOptions } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { attempt } from "@ai/runtime/effect/effect";
import { Effect, type Scope } from "effect";
import type { Options, ProcessOutput, ProcessPromise } from "zx";

export type CommandInput =
  | "ignore"
  | "inherit"
  | { text: string }
  | { bytes: Uint8Array }
  | { file: string }
  | { stream: Readable | ReadableStream<Uint8Array> };

export type CommandOutput =
  | "capture"
  | "ignore"
  | "inherit"
  | { file: string; append?: boolean }
  | { stream: Writable | WritableStream<Uint8Array> };

export interface CommandIO {
  stdin?: CommandInput;
  stdout?: CommandOutput;
  stderr?: CommandOutput;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: Uint8Array;
  readonly stderrBytes: Uint8Array;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly duration: number;
}

export interface PreparedIO {
  options: Partial<Options>;
  connect(process: ProcessPromise): Effect.Effect<void, unknown>;
  result(output: ProcessOutput): CommandResult;
}

function descriptor(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function filePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function webReadable(value: unknown): value is ReadableStream<Uint8Array> {
  return descriptor(value) && typeof value.getReader === "function";
}

function webWritable(value: unknown): value is WritableStream<Uint8Array> {
  return descriptor(value) && typeof value.getWriter === "function";
}

export function validateIO(io: CommandIO): void {
  if (!descriptor(io)) throw new Error("Command I/O must be an object");
  const input = io.stdin;
  if (input !== undefined && input !== "ignore" && input !== "inherit") {
    if (!descriptor(input) || Object.keys(input).length !== 1)
      throw new Error("Command stdin must have exactly one input descriptor");
    if (
      !("text" in input && typeof input.text === "string") &&
      !("bytes" in input && input.bytes instanceof Uint8Array) &&
      !("file" in input && filePath(input.file)) &&
      !(
        "stream" in input &&
        (input.stream instanceof Readable || webReadable(input.stream))
      )
    )
      throw new Error("Invalid command stdin descriptor");
  }
  for (const output of [io.stdout, io.stderr]) {
    if (
      output === undefined ||
      output === "capture" ||
      output === "ignore" ||
      output === "inherit"
    )
      continue;
    if (!descriptor(output)) throw new Error("Invalid command output descriptor");
    if (
      "file" in output &&
      filePath(output.file) &&
      (output.append === undefined || typeof output.append === "boolean") &&
      Object.keys(output).every((key) => key === "file" || key === "append")
    )
      continue;
    if (
      "stream" in output &&
      Object.keys(output).length === 1 &&
      (output.stream instanceof Writable || webWritable(output.stream))
    )
      continue;
    throw new Error("Invalid command output descriptor");
  }
}

// zx pushes every chunk to its channel and stdall stores. Discarding the latter
// avoids a second retention path and never interleaves independent UTF-8 decoders
function discardedChunks(): Buffer[] {
  const chunks: Buffer[] = [];
  chunks.push = () => 0;
  return chunks;
}

function captured(chunks: Buffer[]) {
  let bytes: Buffer | undefined;
  let text: string | undefined;
  return {
    bytes(): Buffer {
      bytes ??= chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      return bytes;
    },
    text(): string {
      if (text === undefined) {
        if (bytes !== undefined) text = bytes.toString("utf8");
        else {
          const decoder = new StringDecoder("utf8");
          const parts = chunks.map((chunk) => decoder.write(chunk));
          parts.push(decoder.end());
          text = parts.join("");
        }
      }
      return text;
    },
  };
}

function chunkBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  throw new Error("Command streams must carry text or byte chunks");
}

function abortable<A>(pending: Promise<A>, signal: AbortSignal): Promise<A> {
  const { promise, resolve, reject } = Promise.withResolvers<A>();
  const cleanup = () => signal.removeEventListener("abort", abort);
  const abort = () => {
    cleanup();
    reject(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  pending.then(
    (value) => {
      cleanup();
      resolve(value);
    },
    (error) => {
      cleanup();
      reject(error);
    },
  );
  if (signal.aborted) abort();
  return promise;
}

async function readNode(
  source: Readable,
  consume: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let error: unknown;
  let pending = Promise.withResolvers<void>();
  const ready = () => pending.resolve();
  const failed = (cause: unknown) => {
    error = cause;
    ready();
  };
  source.pause();
  // Keep readable mode for the whole transfer. Removing the last readable
  // listener between chunks can resume zx's competing data listeners
  source.on("readable", ready);
  source.on("end", ready);
  source.on("close", ready);
  source.on("error", failed);
  signal.addEventListener("abort", ready, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      if (error !== undefined) throw error;
      const chunk: unknown = source.read();
      if (chunk !== null) {
        await consume(chunkBytes(chunk));
        continue;
      }
      if (source.readableEnded) return;
      if (source.destroyed) throw new Error("Command readable closed before EOF");
      pending = Promise.withResolvers<void>();
      if (
        signal.aborted ||
        error !== undefined ||
        source.readableEnded ||
        source.destroyed ||
        source.readableLength
      )
        ready();
      await pending.promise;
    }
  } finally {
    source.off("readable", ready);
    source.off("end", ready);
    source.off("close", ready);
    source.off("error", failed);
    signal.removeEventListener("abort", ready);
    source.pause();
  }
}

async function readStream(
  source: Readable | ReadableStream<Uint8Array>,
  consume: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (source instanceof Readable) return readNode(source, consume, signal);
  const reader = source.getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await abortable(reader.read(), signal);
      if (next.done) return;
      await consume(chunkBytes(next.value));
    }
  } finally {
    // Releasing a pending read rejects it, without cancelling the caller's source
    reader.releaseLock();
  }
}

function writeNode(
  sink: Writable,
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let returned = false;
  let written = false;
  let drained = false;
  let error: unknown;
  const cleanup = () => {
    sink.off("error", failed);
    sink.off("close", closed);
    sink.off("drain", drain);
    signal.removeEventListener("abort", settle);
  };
  const settle = () => {
    // Never abandon an issued write, even when the surrounding fiber aborts
    if (!returned || !written) return;
    if (error !== undefined || signal.aborted || drained) {
      cleanup();
      if (error !== undefined) reject(error);
      else if (signal.aborted) reject(signal.reason);
      else resolve();
    }
  };
  const failed = (cause: unknown) => {
    error = cause;
    settle();
  };
  const closed = () => failed(new Error("Command writable closed before completion"));
  const drain = () => {
    drained = true;
    settle();
  };
  sink.on("error", failed);
  sink.once("close", closed);
  sink.on("drain", drain);
  signal.addEventListener("abort", settle, { once: true });
  try {
    const accepted = sink.write(chunk, (cause?: Error | null) => {
      written = true;
      if (cause) error = cause;
      settle();
    });
    drained ||= accepted;
    returned = true;
    settle();
  } catch (cause) {
    cleanup();
    reject(cause);
  }
  return promise;
}

/** Connect owned process fds without zx's competing pipe-bus flow */
export function connectPipeline(
  source: Readable,
  sink: Writable,
): Effect.Effect<void, unknown> {
  return attempt(
    async (signal) => {
      const ended = new AbortController();
      const connected = AbortSignal.any([signal, ended.signal]);
      let failure: unknown;
      const close = () => {
        ended.abort();
        source.destroy();
      };
      const failed = (error: unknown) => {
        // The producer's real exit status represents an expected broken pipe
        if (!descriptor(error) || error.code !== "EPIPE") failure = error;
        close();
      };
      sink.on("error", failed);
      sink.once("close", () => {
        close();
        sink.off("error", failed);
      });
      if (sink.destroyed) {
        close();
        sink.off("error", failed);
        return;
      }
      try {
        await readNode(source, (chunk) => writeNode(sink, chunk, connected), connected);
        if (!sink.destroyed && !sink.writableEnded) sink.end();
      } catch (error) {
        source.destroy();
        if (signal.aborted) throw signal.reason;
        if (failure !== undefined) throw failure;
        if (!ended.signal.aborted && (!descriptor(error) || error.code !== "EPIPE"))
          throw error;
      }
    },
    { awaitOnInterrupt: true },
  );
}

async function forwardOutput(
  source: Readable,
  sink: Writable | WritableStream<Uint8Array>,
  signal: AbortSignal,
  writers: Map<WritableStream<Uint8Array>, WritableStreamDefaultWriter<Uint8Array>>,
): Promise<void> {
  if (sink instanceof Writable) {
    const failed = new AbortController();
    const connected = AbortSignal.any([signal, failed.signal]);
    const onError = (cause: unknown) => failed.abort(cause);
    sink.on("error", onError);
    try {
      await readNode(source, (chunk) => writeNode(sink, chunk, connected), connected);
    } finally {
      sink.off("error", onError);
    }
    return;
  }
  let writer = writers.get(sink);
  if (!writer) {
    writer = sink.getWriter();
    writers.set(sink, writer);
  }
  const output = writer;
  await readNode(
    source,
    async (chunk) => {
      await abortable(output.ready, signal);
      signal.throwIfAborted();
      // The caller owns the sink, so finish writes rather than aborting it
      await output.write(chunk);
      signal.throwIfAborted();
    },
    signal,
  );
}

export function prepareIO(
  io: CommandIO,
  cwd: string,
): Effect.Effect<PreparedIO, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    yield* Effect.try({ try: () => validateIO(io), catch: (error) => error });
    const input = io.stdin ?? "ignore";
    const stdout = io.stdout ?? "capture";
    const stderr = io.stderr ?? "capture";
    const options: Partial<Options> = {};
    // Clear inherited zx input without feeding or prematurely closing stdin
    Reflect.set(options, "input", undefined);
    const stdin: "ignore" | "inherit" | "pipe" | number =
      typeof input === "string"
        ? input
        : "file" in input
          ? (yield* Effect.acquireRelease(
              attempt(() => open(resolve(cwd, input.file), "r")),
              (file) => attempt(() => file.close()).pipe(Effect.orDie),
            )).fd
          : "pipe";
    if (typeof input !== "string") {
      if ("text" in input) options.input = Buffer.from(input.text);
      else if ("bytes" in input)
        options.input = Buffer.from(
          input.bytes.buffer,
          input.bytes.byteOffset,
          input.bytes.byteLength,
        );
    }
    const stdio: Exclude<StdioOptions, string> = [stdin];
    for (const output of [stdout, stderr]) {
      if (typeof output === "string")
        stdio.push(output === "capture" ? "pipe" : output);
      else if ("file" in output) {
        const file = yield* Effect.acquireRelease(
          attempt(() => open(resolve(cwd, output.file), output.append ? "a" : "w")),
          (file) => attempt(() => file.close()).pipe(Effect.orDie),
        );
        stdio.push(file.fd);
      } else stdio.push("pipe");
    }
    options.stdio = stdio;
    const outChunks: Buffer[] = stdout === "capture" ? [] : discardedChunks();
    const errChunks: Buffer[] = stderr === "capture" ? [] : discardedChunks();
    options.store = { stdout: outChunks, stderr: errChunks, stdall: discardedChunks() };
    const out = captured(outChunks);
    const err = captured(errChunks);
    return {
      options,
      connect(command: ProcessPromise) {
        return attempt(
          async (signal) => {
            command.run();
            const stopped = new AbortController();
            const connected = AbortSignal.any([signal, command.signal, stopped.signal]);
            const tasks: Promise<void>[] = [];
            const writers = new Map<
              WritableStream<Uint8Array>,
              WritableStreamDefaultWriter<Uint8Array>
            >();
            const inputDone = new AbortController();
            const stopInput = () => inputDone.abort();
            const child = command.child;
            child?.once("close", stopInput);
            command.stdin?.once("close", stopInput);
            try {
              if (typeof input !== "string" && "stream" in input) {
                const inputSignal = AbortSignal.any([connected, inputDone.signal]);
                tasks.push(
                  (async () => {
                    try {
                      const sink = command.stdin;
                      if (!sink) throw new Error("Command stdin is unavailable");
                      await readStream(
                        input.stream,
                        (chunk) => writeNode(sink, chunk, inputSignal),
                        inputSignal,
                      );
                      if (!sink.destroyed && !sink.writableEnded) sink.end();
                    } catch (error) {
                      // An early-exiting child owns the lifetime of its stdin pipe
                      if (!inputDone.signal.aborted) throw error;
                    }
                  })(),
                );
              }
              for (const [output, source] of [
                [stdout, command.stdout],
                [stderr, command.stderr],
              ] as const) {
                if (typeof output !== "string" && "stream" in output) {
                  tasks.push(
                    source
                      ? forwardOutput(source, output.stream, connected, writers)
                      : Promise.reject(new Error("Command output is unavailable")),
                  );
                }
              }
              const results = await Promise.allSettled(
                tasks.map((task) =>
                  task.catch((error) => {
                    stopped.abort(error);
                    throw error;
                  }),
                ),
              );
              const failure = results.find((result) => result.status === "rejected");
              if (failure?.status === "rejected") throw failure.reason;
            } finally {
              stopped.abort();
              child?.off("close", stopInput);
              command.stdin?.off("close", stopInput);
              for (const writer of writers.values()) writer.releaseLock();
            }
          },
          { awaitOnInterrupt: true },
        );
      },
      result(output: ProcessOutput): CommandResult {
        return {
          get stdout() {
            return out.text();
          },
          get stderr() {
            return err.text();
          },
          get stdoutBytes() {
            return out.bytes();
          },
          get stderrBytes() {
            return err.bytes();
          },
          exitCode: output.exitCode,
          signal: output.signal,
          duration: output.duration,
        };
      },
    };
  });
}
