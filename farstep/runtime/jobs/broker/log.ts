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
  readonly #queue = new Queue();
  #writeFailure: { error: unknown } | undefined;

  private constructor(directory: string, origin: number, current: number) {
    this.path = join(directory, "output.log");
    this.previous = join(directory, "output.previous.log");
    this.#origin = origin;
    this.#current = current;
    this.#end = origin + current;
  }

  static async create(directory: string): Promise<JobLog> {
    const log = new JobLog(directory, 0, 0);
    await rm(log.previous, { force: true });
    await atomicWrite(log.path, "");
    await atomicWrite(`${log.path}.offset`, "0");
    return log;
  }

  static async recover(directory: string): Promise<JobLog> {
    const path = join(directory, "output.log");
    let origin = 0;
    try {
      origin = Number(await Bun.file(`${path}.offset`).text());
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    if (!Number.isSafeInteger(origin) || origin < 0)
      throw new Error("Invalid job log origin");
    return new JobLog(directory, origin, await size(path));
  }

  get end(): number {
    return this.#end;
  }

  append(value: string | Uint8Array): Promise<void> {
    const bytes = Buffer.from(value);
    this.#end += bytes.length;
    return this.#queue.run(async () => {
      if (this.#writeFailure) throw this.#writeFailure.error;
      try {
        if (this.#current && this.#current + bytes.length > MAX_LOG_BYTES) {
          await rm(this.previous, { force: true });
          await rename(this.path, this.previous);
          this.#origin += this.#current;
          this.#current = 0;
          await atomicWrite(`${this.path}.offset`, String(this.#origin));
        }
        {
          await using file = await open(this.path, "a", 0o600);
          await file.writeFile(bytes);
        }
        this.#current += bytes.length;
      } catch (error) {
        this.#writeFailure = { error };
        throw error;
      }
    });
  }

  #snapshot<T>(read: (end: number) => Promise<T>): Promise<T> {
    const end = this.#end;
    return this.#queue.run(async () => {
      // A failed append rejects the next snapshot before reopening the write queue
      const failure = this.#writeFailure;
      this.#writeFailure = undefined;
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
      if (this.#writeFailure) throw this.#writeFailure.error;
      await using file = await open(this.path, "r");
      await file.sync();
    });
  }
}
