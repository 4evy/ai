import { open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Queue } from "@ai/core/effect/queue/queue";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import {
  JOB_OUTPUT_MAX_BYTES,
  JOB_PTY_COLUMNS,
  JOB_PTY_ROWS,
  type JobTerminalEvent,
  type JobTerminalReplay,
} from "farstep/protocol/jobs/protocol";
import { atomicWrite } from "../../state";

const MAX_LOG_BYTES = 25 * 1024 * 1024;
const MAX_BACKLOG_BYTES = 1024 * 1024;
const MAX_BACKLOG_CHUNKS = 256;
const READ_BYTES = 2 * 1024 * 1024;

async function size(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isEnoent(error)) return 0;
    throw error;
  }
}

function replay(
  geometry: JobTerminalEvent[],
  start: number,
  end: number,
): JobTerminalReplay {
  let terminalSize = { columns: JOB_PTY_COLUMNS, rows: JOB_PTY_ROWS };
  for (const event of geometry) {
    if (event.offset <= start) terminalSize = event.terminalSize;
    else break;
  }
  return {
    terminalSize,
    events: geometry
      .filter((event) => event.offset >= start && event.offset <= end)
      .map((event) => ({ ...event, offset: event.offset - start })),
  };
}

export class JobLog {
  readonly path: string;
  readonly previous: string;
  #origin: number;
  #current: number;
  #end: number;
  #previousBytes: number;
  #queuedBytes = 0;
  #queuedChunks = 0;
  #peakQueuedBytes = 0;
  #peakQueuedChunks = 0;
  #rejectedBytes = 0;
  readonly #queue = new Queue();
  #writeFailure: { error: unknown } | undefined;
  #historicalFailure: string | undefined;

  private constructor(
    directory: string,
    origin: number,
    current: number,
    previous = 0,
  ) {
    this.path = join(directory, "output.log");
    this.previous = join(directory, "output.previous.log");
    this.#origin = origin;
    this.#current = current;
    this.#end = origin + current;
    this.#previousBytes = previous;
  }

  static async create(directory: string): Promise<JobLog> {
    const log = new JobLog(directory, 0, 0);
    await rm(log.previous, { force: true });
    await atomicWrite(log.path, "");
    await atomicWrite(`${log.path}.offset`, "0");
    return log;
  }

  static async recover(
    directory: string,
    history?: {
      peakQueuedBytes: number;
      peakQueuedChunks: number;
      rejectedBytes: number;
      failure?: string | undefined;
    },
  ): Promise<JobLog> {
    const path = join(directory, "output.log");
    let origin = 0;
    try {
      origin = Number(await Bun.file(`${path}.offset`).text());
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    if (!Number.isSafeInteger(origin) || origin < 0)
      throw new Error("Invalid job log origin");
    const log = new JobLog(
      directory,
      origin,
      await size(path),
      await size(join(directory, "output.previous.log")),
    );
    if (history) {
      log.#peakQueuedBytes = history.peakQueuedBytes;
      log.#peakQueuedChunks = history.peakQueuedChunks;
      log.#rejectedBytes = history.rejectedBytes;
      log.#historicalFailure = history.failure;
    }
    return log;
  }

  get end(): number {
    return this.#end;
  }

  // Metadata is retained indefinitely, only the two output generations rotate
  get storage() {
    return {
      backlogLimitBytes: MAX_BACKLOG_BYTES,
      backlogLimitChunks: MAX_BACKLOG_CHUNKS,
      queuedBytes: this.#queuedBytes,
      queuedChunks: this.#queuedChunks,
      peakQueuedBytes: this.#peakQueuedBytes,
      peakQueuedChunks: this.#peakQueuedChunks,
      acceptedBytes: this.#end,
      persistedBytes: this.#origin + this.#current,
      rejectedBytes: this.#rejectedBytes,
      retainedBytes: this.#previousBytes + this.#current,
      retentionLimitBytes: 2 * MAX_LOG_BYTES,
      failure: this.#writeFailure
        ? String(this.#writeFailure.error).slice(0, 1024)
        : this.#historicalFailure,
    };
  }

  append(value: string | Uint8Array): Promise<void> {
    const length = typeof value === "string" ? Buffer.byteLength(value) : value.length;
    if (this.#writeFailure) {
      this.#rejectedBytes += length;
      throw this.#writeFailure.error;
    }
    if (
      length > MAX_BACKLOG_BYTES - this.#queuedBytes ||
      this.#queuedChunks >= MAX_BACKLOG_CHUNKS
    ) {
      this.#rejectedBytes += length;
      const error = new Error(
        `Job output persistence backlog exceeded ${MAX_BACKLOG_BYTES} bytes or ${MAX_BACKLOG_CHUNKS} chunks`,
      );
      this.#writeFailure = { error };
      throw error;
    }
    const bytes = Buffer.from(value);
    this.#end += length;
    this.#queuedBytes += length;
    this.#queuedChunks++;
    this.#peakQueuedBytes = Math.max(this.#peakQueuedBytes, this.#queuedBytes);
    this.#peakQueuedChunks = Math.max(this.#peakQueuedChunks, this.#queuedChunks);
    return this.#queue.run(async () => {
      try {
        if (this.#writeFailure) throw this.#writeFailure.error;
        if (this.#current + length > MAX_LOG_BYTES) {
          await rm(this.previous, { force: true });
          await rename(this.path, this.previous);
          this.#previousBytes = this.#current;
          this.#origin += this.#current;
          this.#current = 0;
          await atomicWrite(`${this.path}.offset`, String(this.#origin));
        }
        await using file = await open(this.path, "a", 0o600);
        await file.writeFile(bytes);
        this.#current += length;
      } catch (error) {
        this.#writeFailure ??= { error };
        throw error;
      } finally {
        this.#queuedBytes -= length;
        this.#queuedChunks--;
      }
    });
  }

  #snapshot<T>(read: (end: number) => Promise<T>): Promise<T> {
    const end = this.#end;
    return this.#queue.run(async () => {
      // A storage failure remains visible to every reader and durability barrier
      const failure = this.#writeFailure;
      if (failure) throw failure.error;
      return read(end);
    });
  }

  async #range(start: number, end: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    const previousSize = await size(this.previous);
    for (const [path, origin, length] of [
      [this.previous, this.#origin - previousSize, previousSize],
      [this.path, this.#origin, this.#current],
    ] as const) {
      const from = Math.max(start, origin);
      const to = Math.min(end, origin + length);
      if (to <= from) continue;
      await using file = await open(path, "r");
      const part = Buffer.alloc(to - from);
      let read = 0;
      while (read < part.length) {
        const result = await file.read(
          part,
          read,
          part.length - read,
          from - origin + read,
        );
        if (!result.bytesRead) throw new Error("Job log changed during a bounded read");
        read += result.bytesRead;
      }
      parts.push(part);
    }
    return Buffer.concat(parts);
  }

  output(cursor: number) {
    return this.#snapshot(async (availableEnd) => {
      const availableStart = this.#origin - (await size(this.previous));
      const startCursor = Math.max(cursor, availableStart);
      if (startCursor > availableEnd)
        throw new Error("Output cursor is ahead of this job");
      const end = Math.min(availableEnd, startCursor + JOB_OUTPUT_MAX_BYTES);
      const bytes = await this.#range(startCursor, end);
      return {
        data: bytes.toString("base64"),
        startCursor,
        cursor: end,
        availableStart,
        availableEnd,
      };
    });
  }

  logs(head: boolean, lines: number, grep?: string, events?: JobTerminalEvent[]) {
    const geometry = events?.slice();
    return this.#snapshot(async (cursor) => {
      const availableStart = this.#origin - (await size(this.previous));
      let start = head ? availableStart : Math.max(availableStart, cursor - READ_BYTES);
      const end = head ? Math.min(cursor, start + READ_BYTES) : cursor;
      const bytes = await this.#range(start, end);
      let skip = 0;
      while (skip < bytes.length && ((bytes[skip] ?? 0) & 0xc0) === 0x80) skip++;
      start += skip;
      const raw = new TextDecoder().decode(bytes.subarray(skip), { stream: true });
      let rows = sanitizeText(raw).replace(/\r\n/g, "\n").split("\n");
      if (grep) {
        const pattern = new RegExp(grep, "u");
        rows = rows.filter((row) => pattern.test(row));
      }
      const text = (head ? rows.slice(0, lines) : rows.slice(-lines)).join("\n");
      return {
        text,
        terminalText: geometry && !grep ? raw : undefined,
        terminalReplay: geometry ? replay(geometry, start, end) : undefined,
        cursor,
      };
    });
  }

  flush(): Promise<void> {
    return this.#queue.run(async () => {
      try {
        if (this.#writeFailure) throw this.#writeFailure.error;
        await using file = await open(this.path, "r");
        await file.sync();
      } catch (error) {
        this.#writeFailure ??= { error };
        throw error;
      }
    });
  }
}
