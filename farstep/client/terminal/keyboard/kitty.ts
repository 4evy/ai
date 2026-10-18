import {
  KEY_MODIFIERS,
  TERMINAL_KEY_DEFINITIONS as KEYS,
  LEGACY_CONTROL_KEYS,
} from "./keys";
import { legacyKey } from "./legacy";
import type { TerminalKeyboardModes } from "./modes";
import type { TerminalKey } from "./parser";

const KITTY_FLAGS = {
  disambiguate: 1,
  reportEvents: 2,
  alternateKeys: 4,
  reportAllKeys: 8,
  associatedText: 16,
} as const;
const KITTY_DISAMBIGUATED_KEYS = KITTY_FLAGS.disambiguate | KITTY_FLAGS.reportAllKeys;
const KITTY_EXTENDED_KEYS = KITTY_DISAMBIGUATED_KEYS | KITTY_FLAGS.reportEvents;
const NON_TEXT_MODIFIERS =
  KEY_MODIFIERS.alt |
  KEY_MODIFIERS.ctrl |
  KEY_MODIFIERS.super |
  KEY_MODIFIERS.hyper |
  KEY_MODIFIERS.meta;
const LOCK_MODIFIERS = KEY_MODIFIERS.capslock | KEY_MODIFIERS.numlock;

const KITTY_FUNCTIONS: Readonly<Record<number, readonly [number, string]>> = {
  [KEYS.insert.code]: [2, "~"],
  [KEYS.delete.code]: [3, "~"],
  [KEYS.left.code]: [1, "D"],
  [KEYS.right.code]: [1, "C"],
  [KEYS.up.code]: [1, "A"],
  [KEYS.down.code]: [1, "B"],
  [KEYS.pageup.code]: [5, "~"],
  [KEYS.pagedown.code]: [6, "~"],
  [KEYS.home.code]: [1, "H"],
  [KEYS.end.code]: [1, "F"],
  [KEYS.f1.code]: [1, "P"],
  [KEYS.f2.code]: [1, "Q"],
  [KEYS.f3.code]: [13, "~"],
  [KEYS.f4.code]: [1, "S"],
  [KEYS.f5.code]: [15, "~"],
  [KEYS.f6.code]: [17, "~"],
  [KEYS.f7.code]: [18, "~"],
  [KEYS.f8.code]: [19, "~"],
  [KEYS.f9.code]: [20, "~"],
  [KEYS.f10.code]: [21, "~"],
  [KEYS.f11.code]: [23, "~"],
  [KEYS.f12.code]: [24, "~"],
  [KEYS.kpbegin.code]: [1, "E"],
};

type KeyFallback = { bytes: string | undefined };

function kittyLiteralFallback(
  key: TerminalKey,
  modes: TerminalKeyboardModes,
): KeyFallback | undefined {
  const flags = modes.kittyFlags;
  if (key.literal === undefined || flags & KITTY_DISAMBIGUATED_KEYS) return undefined;
  if (
    flags & KITTY_FLAGS.alternateKeys &&
    key.modifiers & KEY_MODIFIERS.shift &&
    key.shiftedCode !== undefined
  )
    return undefined;
  if (key.modifiers & KEY_MODIFIERS.shift && key.code !== KEYS.space.code)
    return undefined;
  const bytes = legacyKey(key, modes);
  return bytes === undefined ? undefined : { bytes };
}

function legacyKittyNamed(key: TerminalKey, flags: number): boolean {
  if (
    key.literal !== undefined ||
    flags & KITTY_EXTENDED_KEYS ||
    key.code >= KEYS.f13.code
  )
    return false;
  return (
    LEGACY_CONTROL_KEYS.has(key.code) ||
    (key.modifiers === 0 && Boolean(key.definition?.legacy))
  );
}

function kittyNamedFallback(
  key: TerminalKey,
  modes: TerminalKeyboardModes,
): KeyFallback | undefined {
  const flags = modes.kittyFlags;
  if (
    !(flags & KITTY_FLAGS.reportAllKeys) &&
    !(key.modifiers & ~LOCK_MODIFIERS) &&
    LEGACY_CONTROL_KEYS.has(key.code) &&
    key.code !== KEYS.escape.code
  )
    return { bytes: key.definition?.legacy };
  if (legacyKittyNamed(key, flags)) return { bytes: legacyKey(key, modes) };
  if (
    !(flags & KITTY_DISAMBIGUATED_KEYS) &&
    key.code >= KEYS.kp0.code &&
    key.code <= KEYS.kpbegin.code
  )
    return { bytes: legacyKey(key, modes) };
  return undefined;
}

function kittyText(key: TerminalKey, flags: number): string | undefined {
  if (
    !(flags & KITTY_FLAGS.reportAllKeys) ||
    !(flags & KITTY_FLAGS.associatedText) ||
    key.text === undefined ||
    key.modifiers & NON_TEXT_MODIFIERS
  )
    return undefined;
  return Array.from(key.text, (character) => character.codePointAt(0)).join(":");
}

function kittyAlternate(key: TerminalKey, flags: number): string {
  return flags & KITTY_FLAGS.alternateKeys &&
    key.modifiers & KEY_MODIFIERS.shift &&
    key.shiftedCode !== undefined
    ? `:${key.shiftedCode}`
    : "";
}

function kittyField(code: number, final: string, modifiers: number): string {
  return code === 1 && final !== "u" && modifiers === 0 ? "" : String(code);
}

function kittySequence(key: TerminalKey, flags: number): string {
  const functional = KITTY_FUNCTIONS[key.code];
  const legacyMenu = !(flags & KITTY_EXTENDED_KEYS) && key.code === KEYS.menu.code;
  const code = legacyMenu ? 29 : (functional?.[0] ?? key.code);
  const final = legacyMenu ? "~" : (functional?.[1] ?? "u");
  const alternate = kittyAlternate(key, flags);
  const text = kittyText(key, flags);
  const field = kittyField(code, final, key.modifiers);
  return `\x1b[${field}${alternate}${key.modifiers || text !== undefined ? `;${key.modifiers + 1}` : ""}${text === undefined ? "" : `;${text}`}${final}`;
}

export function kittyKey(
  key: TerminalKey,
  modes: TerminalKeyboardModes,
): string | undefined {
  const flags = modes.kittyFlags;
  if (
    key.code >= KEYS.leftshift.code &&
    key.code <= KEYS.isolevel5shift.code &&
    !(flags & KITTY_FLAGS.reportAllKeys)
  )
    return undefined;
  if (
    key.text !== undefined &&
    !(key.modifiers & NON_TEXT_MODIFIERS) &&
    !(flags & KITTY_FLAGS.reportAllKeys)
  )
    return key.text;
  const fallback = kittyLiteralFallback(key, modes) ?? kittyNamedFallback(key, modes);
  return fallback ? fallback.bytes : kittySequence(key, flags);
}
