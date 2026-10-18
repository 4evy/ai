import {
  KEY_MODIFIERS,
  TERMINAL_KEY_DEFINITIONS as KEYS,
  LEGACY_CONTROL_KEYS,
  UNSUPPORTED_LEGACY_MODIFIERS,
  xtermModifiers,
} from "./keys";
import type { TerminalKeyboardModes } from "./modes";
import type { TerminalKey } from "./parser";

const CONTROL_BYTES: Readonly<Record<string, number>> = {
  " ": 0,
  "2": 0,
  "3": 27,
  "4": 28,
  "5": 29,
  "6": 30,
  "7": 31,
  "8": 127,
  "@": 0,
  "[": 27,
  "\\": 28,
  "]": 29,
  "^": 30,
  _: 31,
  "/": 31,
  "?": 127,
  "~": 30,
};
function legacyLiteral(key: TerminalKey, prefix: string): string | undefined {
  if (key.literal === undefined || key.modifiers & KEY_MODIFIERS.meta) return undefined;
  if (!(key.modifiers & KEY_MODIFIERS.ctrl))
    return key.text === undefined ? undefined : prefix + key.text;
  if (key.explicitShift && key.literal !== " ") return undefined;
  const code = /^[a-z]$/u.test(key.literal)
    ? key.literal.charCodeAt(0) - 96
    : CONTROL_BYTES[key.literal];
  return code === undefined ? undefined : prefix + String.fromCharCode(code);
}

function legacyControl(
  key: TerminalKey,
  bytes: string,
  prefix: string,
): string | undefined {
  if (key.modifiers & KEY_MODIFIERS.meta) return undefined;
  if (key.code === KEYS.tab.code && key.modifiers & KEY_MODIFIERS.shift)
    return `${prefix}\x1b[Z`;
  if (key.code === KEYS.backspace.code && key.modifiers & KEY_MODIFIERS.ctrl)
    return `${prefix}\x08`;
  return prefix + bytes;
}

function legacyFunction(
  key: TerminalKey,
  modes: TerminalKeyboardModes,
  bytes: string,
  prefix: string,
): string | undefined {
  const modifiers = key.modifiers;
  const modifier = 1 + xtermModifiers(modifiers);
  // Cursor and function modifiers use xterm's CSI form, never an ESC prefix
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC sequences
  if (/^\x1b(?:\[|O)[A-HFP-S]$/u.test(bytes)) {
    if (modifiers !== 0) return `\x1b[1;${modifier}${bytes.at(-1)}`;
    return modes.applicationCursor &&
      /^(?:kp)?(?:up|down|left|right|home|end|begin)$/u.test(key.name)
      ? bytes.replace("[", "O")
      : bytes;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC sequences
  if (/^\x1b\[\d+~$/u.test(bytes))
    return modifiers === 0 ? bytes : bytes.replace("~", `;${modifier}~`);
  if (
    modifiers & KEY_MODIFIERS.meta ||
    key.explicitShift ||
    modifiers & KEY_MODIFIERS.ctrl
  )
    return undefined;
  return prefix + bytes;
}

export function legacyKey(
  key: TerminalKey,
  modes: TerminalKeyboardModes,
): string | undefined {
  const prefix = key.modifiers & KEY_MODIFIERS.alt ? "\x1b" : "";
  if (key.modifiers & UNSUPPORTED_LEGACY_MODIFIERS) return undefined;
  if (key.literal !== undefined) return legacyLiteral(key, prefix);
  const definition = key.definition;
  if (!definition?.legacy) return undefined;
  if (LEGACY_CONTROL_KEYS.has(key.code))
    return legacyControl(key, definition.legacy, prefix);
  if (definition.keypad && modes.applicationKeypad) {
    const modifier = 1 + xtermModifiers(key.modifiers);
    return key.modifiers === 0
      ? definition.keypad
      : `\x1b[1;${modifier}${definition.keypad.at(-1)}`;
  }
  return legacyFunction(key, modes, definition.legacy, prefix);
}
