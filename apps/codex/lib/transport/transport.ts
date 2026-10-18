import { createInterface, type Interface } from "node:readline";
import { Readable } from "node:stream";
import { Queue } from "@ai/core/effect/queue/queue";
import { BoundedFrames } from "@ai/core/mcp/frames/frames";
import { isRecord } from "@ai/core/value/value";
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageWriter,
} from "vscode-jsonrpc/node";

// App-server uses newline-delimited JSON rather than Content-Length frames
export class AppServerReader extends AbstractMessageReader {
  #lines: Interface | undefined;
  private readonly stream: ReadableStream<Uint8Array>;

  constructor(stream: ReadableStream<Uint8Array>) {
    super();
    this.stream = stream;
  }

  listen(callback: DataCallback): Disposable {
    const bounded = new BoundedFrames(
      16 * 1024 * 1024,
      "Codex app-server message exceeds 16 MiB",
    );
    const input = Readable.fromWeb(this.stream);
    const fail = (error: Error) => {
      this.fireError(error);
      lines.close();
    };
    const lines = createInterface({
      input: input.pipe(bounded),
      crlfDelay: Infinity,
    });
    this.#lines = lines;
    input.on("error", fail);
    bounded.on("error", fail);
    void (async () => {
      try {
        for await (const line of lines) {
          const message: unknown = JSON.parse(line);
          if (!isRecord(message)) continue;
          // App-server omits the JSON-RPC version required by vscode-jsonrpc
          callback({ ...message, jsonrpc: "2.0" });
        }
      } catch (error) {
        this.fireError(error);
      } finally {
        lines.close();
        input.unpipe(bounded);
        input.off("error", fail);
        bounded.off("error", fail);
        this.fireClose();
      }
    })();
    return { dispose: () => lines.close() };
  }

  override dispose(): void {
    this.#lines?.close();
    super.dispose();
  }
}

export class AppServerWriter extends AbstractMessageWriter implements MessageWriter {
  readonly #writes = new Queue();
  private readonly sink: Bun.FileSink;

  constructor(sink: Bun.FileSink) {
    super();
    this.sink = sink;
  }

  write(message: Message): Promise<void> {
    return this.#writes.run(async () => {
      try {
        this.sink.write(`${JSON.stringify(message)}\n`);
        await this.sink.flush();
      } catch (error) {
        this.fireError(error, message);
        throw error;
      }
    });
  }

  end(): void {
    this.sink.end();
  }
}
