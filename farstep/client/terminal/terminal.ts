import { readText } from "@ai/toolkit/text/text";
import {
  JOB_PTY_COLUMNS,
  JOB_PTY_ROWS,
  type JobSnapshot,
  type JobTerminalSize,
  parseJobTerminalSize,
} from "../../protocol/jobs/protocol";
import { kittyKey } from "./keyboard/kitty";
import { readKeyboardModes } from "./keyboard/modes";
import type { TerminalKey } from "./keyboard/parser";
import { xtermKey } from "./keyboard/xterm";

export { parseTerminalKeys } from "./keyboard/parser";

export function keyBytes(keys: TerminalKey[], terminalText?: string): string {
  const modes = readKeyboardModes(terminalText);
  return keys
    .map((key) => {
      const bytes =
        (modes.kittyFlags & 31) !== 0 ? kittyKey(key, modes) : xtermKey(key, modes);
      if (bytes === undefined)
        throw new Error(
          readText(new URL("./terminal/terminal.md", import.meta.url), "key", {
            KEY: String(key.original),
          }),
        );
      return bytes;
    })
    .join("");
}

export function terminalSize(daemon: JobSnapshot): JobTerminalSize {
  const size = daemon.terminalSize;
  if (!size) return { columns: JOB_PTY_COLUMNS, rows: JOB_PTY_ROWS };
  return parseJobTerminalSize(size);
}
