import {
  KEY_MODIFIERS,
  LEGACY_CONTROL_KEYS,
  UNSUPPORTED_LEGACY_MODIFIERS,
  XTERM_MODIFIERS,
  xtermModifiers,
} from "./keys";
import { legacyKey } from "./legacy";
import type { TerminalKeyboardModes } from "./modes";
import type { TerminalKey } from "./parser";

function xtermEligible(key: TerminalKey): boolean {
  const ordinary = key.literal !== undefined || LEGACY_CONTROL_KEYS.has(key.code);
  return (
    ordinary &&
    !(key.modifiers & UNSUPPORTED_LEGACY_MODIFIERS) &&
    (key.literal === undefined ||
      !(key.modifiers & KEY_MODIFIERS.shift) ||
      key.text !== undefined)
  );
}

function xtermLevel(
  level: number,
  effective: number,
  legacy: string | undefined,
): boolean {
  switch (level) {
    case 3:
      return true;
    case 2:
      return effective !== 0;
    case 1:
      return Boolean(
        effective & (XTERM_MODIFIERS.alt | XTERM_MODIFIERS.meta) ||
          (effective === XTERM_MODIFIERS.ctrl && legacy === undefined),
      );
    default:
      return false;
  }
}

export function xtermKey(
  key: TerminalKey,
  modes: TerminalKeyboardModes,
): string | undefined {
  const modifiers = xtermModifiers(key.modifiers);
  const effective = modifiers & ~modes.otherKeysMask;
  const legacy = legacyKey(key, modes);
  if (!xtermEligible(key) || !xtermLevel(modes.modifyOtherKeys, effective, legacy))
    return legacy;
  const code = key.text?.codePointAt(0) ?? key.code;
  return modes.formatOtherKeys === 1
    ? `\x1b[${code};${effective + 1}u`
    : `\x1b[27;${effective + 1};${code}~`;
}
