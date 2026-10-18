import { run } from "@ai/core/effect/effect";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import xterm, { type BufferCell, type Terminal } from "@oh-my-pi/pi-utils/vterm";
import { Effect } from "effect";
import {
  JOB_PTY_COLUMNS,
  JOB_PTY_ROWS,
  type JobTerminalEvent,
} from "farstep/protocol/jobs/protocol";
import type { JobLogs } from "#farstep/protocol/jobs/gateway";

const COLOR_CHANNELS = [
  { sgr: 38, rgb: "isFgRGB", palette: "isFgPalette", color: "getFgColor" },
  { sgr: 48, rgb: "isBgRGB", palette: "isBgPalette", color: "getBgColor" },
] as const;
const RENDITION_ATTRIBUTES = [
  [1, "isBold"],
  [2, "isDim"],
  [3, "isItalic"],
  [4, "isUnderline"],
  [7, "isInverse"],
  [9, "isStrikethrough"],
  [53, "isOverline"],
] as const;
const TERMINAL_SCROLLBACK_LINES = 4096;

function colorAttributes(
  cell: BufferCell,
  channel: (typeof COLOR_CHANNELS)[number],
): number[] {
  const rgb = cell[channel.rgb]();
  const palette = cell[channel.palette]();
  if (!rgb && !palette) return [];
  const color = cell[channel.color]();
  return rgb
    ? [channel.sgr, 2, (color >>> 16) & 255, (color >>> 8) & 255, color & 255]
    : [channel.sgr, 5, color];
}

function rendition(cell: BufferCell): string {
  const attributes: number[] = [];
  for (const [code, attribute] of RENDITION_ATTRIBUTES)
    if (cell[attribute]()) attributes.push(code);
  for (const channel of COLOR_CHANNELS)
    attributes.push(...colorAttributes(cell, channel));
  return attributes.length ? `\x1b[${attributes.join(";")}m` : "";
}

function screenRows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const reusable = buffer.getNullCell();
  return Array.from({ length: terminal.rows }, (_, row) => {
    const line = buffer.getLine(buffer.viewportY + row);
    if (!line) return "";
    const cells: { text: string; style: string }[] = [];
    let last = -1;
    for (let column = 0; column < line.length; ) {
      const cell = line.getCell(column, reusable);
      if (!cell) break;
      const text = sanitizeText(cell.getChars());
      cells.push({ text: text || " ", style: rendition(cell) });
      if (text.trim()) last = cells.length - 1;
      column += Math.max(1, cell.getWidth());
    }
    let previous: string | undefined;
    return cells
      .slice(0, last + 1)
      .map((cell) => {
        const prefix = previous === cell.style ? "" : `\x1b[0m${cell.style}`;
        previous = cell.style;
        return prefix + cell.text;
      })
      .join("");
  });
}

function write(terminal: Terminal, bytes: Uint8Array): Promise<void> {
  return run(
    Effect.callback<void>((resume) => {
      terminal.write(bytes, () => resume(Effect.void));
    }),
  );
}

class ScreenReplay {
  private readonly options;
  private terminal: Terminal;

  constructor(initial: NonNullable<JobLogs["terminalSize"]>) {
    this.options = {
      cols: initial.columns,
      rows: initial.rows,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      allowProposedApi: true,
    };
    this.terminal = new xterm.Terminal(this.options);
  }

  async replay(bytes: Uint8Array, events: JobTerminalEvent[]): Promise<void> {
    let offset = 0;
    for (const event of events) {
      if (event.offset > bytes.length) break;
      if (event.offset > offset)
        await write(this.terminal, bytes.subarray(offset, event.offset));
      if (event.reset && event.offset > 0) {
        this.terminal.dispose();
        this.terminal = new xterm.Terminal({
          ...this.options,
          cols: event.terminalSize.columns,
          rows: event.terminalSize.rows,
        });
      } else this.terminal.resize(event.terminalSize.columns, event.terminalSize.rows);
      offset = event.offset;
    }
    if (offset < bytes.length) await write(this.terminal, bytes.subarray(offset));
  }

  rows(): string[] {
    return screenRows(this.terminal);
  }

  close(): void {
    this.terminal.dispose();
  }
}

export async function styledScreen(logs: JobLogs): Promise<void> {
  if (logs.terminalText === undefined) return;
  const initial = logs.terminalReplay?.terminalSize ??
    logs.terminalSize ?? {
      columns: JOB_PTY_COLUMNS,
      rows: JOB_PTY_ROWS,
    };
  const screen = new ScreenReplay(initial);
  try {
    await screen.replay(
      Buffer.from(logs.terminalText, "utf8"),
      logs.terminalReplay?.events ?? [],
    );
    logs.terminalRows = screen.rows();
    logs.terminalStyleRows = logs.terminalRows;
  } finally {
    screen.close();
  }
}
