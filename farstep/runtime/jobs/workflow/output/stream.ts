import { attempt } from "@ai/runtime/effect/effect";
import { Deferred, Effect, Stream } from "effect";
import type { WorkflowOutputPolicy } from "#farstep/protocol/workflow/workflow";
import { errorText } from "./parsing";
import type { CaptureState, Sink } from "./types";

const DECODE_BYTES = 16 * 1024;

export class StreamCapture {
  private readonly preview: Uint8Array;
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  private bytes = 0;
  private previewBytes = 0;
  private retainedBytes = 0;
  private failure: string | undefined;
  private writable: boolean;
  constructor(
    private readonly stream: ReadableStream<Uint8Array>,
    private readonly name: "stdout" | "stderr",
    private readonly sink: Sink | undefined,
    private readonly policy: WorkflowOutputPolicy,
    private readonly state: CaptureState,
  ) {
    this.preview = new Uint8Array(policy.maxBytes);
    this.writable = sink !== undefined;
  }

  private previewChunk(chunk: Uint8Array): void {
    const count = Math.min(
      chunk.byteLength,
      this.preview.byteLength - this.previewBytes,
    );
    if (count > 0) {
      this.preview.set(chunk.subarray(0, count), this.previewBytes);
      this.previewBytes += count;
    }
    for (let offset = 0; offset < chunk.byteLength; offset += DECODE_BYTES) {
      this.state.emit(
        this.decoder.decode(chunk.subarray(offset, offset + DECODE_BYTES), {
          stream: true,
        }),
      );
    }
  }

  private retainChunk(chunk: Uint8Array) {
    return Effect.gen({ self: this }, function* () {
      const sink = this.sink;
      if (!this.writable || !sink) return;
      const keep = Math.min(
        chunk.byteLength,
        this.policy.maxCaptureBytes - this.retainedBytes,
      );
      yield* Effect.gen({ self: this }, function* () {
        let offset = 0;
        while (offset < keep) {
          const written = yield* attempt(
            () => sink.file.write(chunk, offset, keep - offset),
            { awaitOnInterrupt: true },
          );
          if (written.bytesWritten === 0)
            return yield* Effect.fail(new Error("Artifact write made no progress"));
          offset += written.bytesWritten;
          this.retainedBytes += written.bytesWritten;
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            this.failure = `Cannot write ${this.name} artifact: ${errorText(error)}`;
            this.writable = false;
          }),
        ),
      );
    });
  }

  private closeArtifact() {
    const sink = this.sink;
    if (!sink) return Effect.void;
    return attempt(() => sink.file.sync()).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          this.failure ??= `Cannot flush ${this.name} artifact: ${errorText(error)}`;
        }),
      ),
      Effect.ensuring(
        attempt(() => sink.file.close()).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              this.failure ??= `Cannot close ${this.name} artifact: ${errorText(error)}`;
            }),
          ),
        ),
      ),
    );
  }

  runEffect() {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.scoped(
        Effect.gen({ self: this }, function* () {
          yield* Effect.addFinalizer(() => this.closeArtifact());
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              this.failure ??= this.state.aborted;
              this.state.emit(this.decoder.decode());
            }),
          );
          yield* Stream.fromReadableStream({
            evaluate: () => this.stream,
            onError: (error) => error,
          }).pipe(
            Stream.interruptWhen(Deferred.await(this.state.stopped)),
            // Keep draining after reaching either capture limit
            Stream.runForEach((chunk) =>
              Effect.gen({ self: this }, function* () {
                this.bytes += chunk.byteLength;
                yield* Effect.try({
                  try: () => this.previewChunk(chunk),
                  catch: (error) => error,
                });
                yield* this.retainChunk(chunk);
              }),
            ),
          );
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            this.failure = `Cannot read ${this.name}: ${errorText(error)}`;
          }),
        ),
      );
      this.failure ??= this.state.aborted;
      return {
        bytes: this.bytes,
        preview: this.preview.subarray(0, this.previewBytes),
        ...(this.sink
          ? {
              artifact: {
                path: this.sink.path,
                bytes: this.bytes,
                retainedBytes: this.retainedBytes,
                truncated:
                  this.retainedBytes < this.bytes || this.state.aborted !== undefined,
              },
            }
          : {}),
        ...(this.failure ? { error: this.failure } : {}),
      };
    });
  }
}
