import { Option, Record as Records } from "effect";
import { closestMatch } from "leven";
import { TERMINAL_KEYS } from "#farstep/client/terminal/keys/keys";
import {
  KEY_MODIFIERS,
  TERMINAL_KEY_DEFINITIONS as KEYS,
  TERMINAL_KEY_ALIASES,
  type TerminalKeyDefinition,
  type TerminalKeyName,
} from "./keys";

const MODIFIERS: Readonly<Record<string, number>> = {
  shift: KEY_MODIFIERS.shift,
  alt: KEY_MODIFIERS.alt,
  option: KEY_MODIFIERS.alt,
  opt: KEY_MODIFIERS.alt,
  ctrl: KEY_MODIFIERS.ctrl,
  control: KEY_MODIFIERS.ctrl,
  ctl: KEY_MODIFIERS.ctrl,
  super: KEY_MODIFIERS.super,
  cmd: KEY_MODIFIERS.super,
  command: KEY_MODIFIERS.super,
  win: KEY_MODIFIERS.super,
  windows: KEY_MODIFIERS.super,
  hyper: KEY_MODIFIERS.hyper,
  meta: KEY_MODIFIERS.meta,
  capslock: KEY_MODIFIERS.capslock,
  numlock: KEY_MODIFIERS.numlock,
};

const CHARACTER_NAMES: Readonly<Record<string, string>> = {
  plus: "+",
  minus: "-",
  equal: "=",
  equals: "=",
  comma: ",",
  period: ".",
  dot: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  apostrophe: "'",
  backtick: "`",
  grave: "`",
  leftbracket: "[",
  rightbracket: "]",
};

// Shifted punctuation uses the US ASCII layout; Unicode literals need no layout
const SHIFTED: Readonly<Record<string, string>> = {
  "`": "~",
  "1": "!",
  "2": "@",
  "3": "#",
  "4": "$",
  "5": "%",
  "6": "^",
  "7": "&",
  "8": "*",
  "9": "(",
  "0": ")",
  "-": "_",
  "=": "+",
  "[": "{",
  "]": "}",
  "\\": "|",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
};
const UNSHIFTED: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SHIFTED).map(([base, shifted]) => [shifted, base]),
);
const KEY_NAMES = Records.keys(KEYS);

export interface TerminalKey {
  original: string;
  name: string;
  code: number;
  modifiers: number;
  explicitShift: boolean;
  literal: string | undefined;
  text: string | undefined;
  shiftedCode: number | undefined;
  definition: TerminalKeyDefinition | undefined;
}

function unknownKey(key: string, name: string): never {
  const suggested =
    name.length <= 32 ? closestMatch(name, KEY_NAMES, { maxDistance: 3 }) : undefined;
  throw new Error(
    `Unknown terminal key: ${key.slice(0, 128)}. ${
      suggested ? `Did you mean ${suggested}? ` : ""
    }Supported keys: ${TERMINAL_KEYS}`,
  );
}

function keyChord(original: string): { parts: string[]; token: string } {
  const parts =
    original === "+"
      ? []
      : original.endsWith("++")
        ? original.slice(0, -2).split("+")
        : original.split("+");
  const token = original === "+" || original.endsWith("++") ? "+" : (parts.pop() ?? "");
  return { parts, token };
}

function keyModifiers(original: string, parts: string[]): number {
  let modifiers = 0;
  for (const part of parts) {
    const modifier = part.toLowerCase().replace(/[\s_-]/gu, "");
    const bit = Object.hasOwn(MODIFIERS, modifier) ? MODIFIERS[modifier] : undefined;
    if (bit === undefined) unknownKey(original, modifier);
    if (modifiers & bit)
      throw new Error(`Duplicate terminal modifier ${part} in ${original}`);
    modifiers |= bit;
  }
  return modifiers;
}

function keyLiteral(
  original: string,
  token: string,
  name: string,
  definition?: TerminalKeyDefinition,
): string | undefined {
  const literal = Object.hasOwn(CHARACTER_NAMES, name)
    ? CHARACTER_NAMES[name]
    : definition?.code === KEYS.space.code
      ? " "
      : undefined;
  if (definition || literal !== undefined) return literal;
  const character = token.trim() || token;
  if (!validLiteral(character)) unknownKey(original, name);
  return character;
}

function validLiteral(character: string): boolean {
  const code = character.codePointAt(0);
  return (
    code !== undefined &&
    String.fromCodePoint(code) === character &&
    code >= 32 &&
    !(code >= 127 && code <= 159) &&
    !(code >= 0xd800 && code <= 0xdfff)
  );
}

function shiftedCharacter(base: string): string | undefined {
  if (Object.hasOwn(SHIFTED, base)) return SHIFTED[base];
  if (/^[a-z]$/u.test(base)) return base.toUpperCase();
  return base === " " ? " " : undefined;
}

function literalText(
  base: string,
  literal: string,
  shifted: string | undefined,
  modifiers: number,
): string | undefined {
  if (/^[a-z]$/u.test(base)) {
    const upper =
      Boolean(modifiers & KEY_MODIFIERS.shift) !==
      Boolean(modifiers & KEY_MODIFIERS.capslock);
    return upper ? base.toUpperCase() : base;
  }
  if (modifiers & KEY_MODIFIERS.shift) return shifted;
  return modifiers & KEY_MODIFIERS.capslock && !/^[\x20-\x7e]$/u.test(base)
    ? undefined
    : literal;
}

function literalKey(key: TerminalKey, literal: string, bare: boolean): TerminalKey {
  const lower = /^[A-Z]$/u.test(literal) ? literal.toLowerCase() : literal;
  const base = Object.hasOwn(UNSHIFTED, lower) ? (UNSHIFTED[lower] ?? lower) : lower;
  // Letter names in chords are case-insensitive; bare uppercase is literal
  if ((bare && /^[A-Z]$/u.test(literal)) || Object.hasOwn(UNSHIFTED, literal))
    key.modifiers |= KEY_MODIFIERS.shift;
  const shifted = shiftedCharacter(base);
  return {
    ...key,
    code: base.codePointAt(0) ?? 0,
    literal: lower,
    text: literalText(base, literal, shifted, key.modifiers),
    shiftedCode: shifted?.codePointAt(0),
  };
}

function namedKey(key: TerminalKey): TerminalKey {
  const definition = key.definition;
  if (!definition) unknownKey(key.original, key.name);
  return {
    ...key,
    code: definition.code,
    modifiers: key.modifiers | (definition.modifier ?? 0),
    text:
      definition.code >= KEYS.kp0.code &&
      definition.code <= KEYS.kpseparator.code &&
      definition.code !== KEYS.kpenter.code &&
      !(key.modifiers & KEY_MODIFIERS.shift)
        ? definition.legacy
        : undefined,
  };
}

function parseTerminalKey(original: string): TerminalKey {
  if (typeof original !== "string")
    throw new Error("keys must contain terminal key strings");
  const { parts, token } = keyChord(original);
  const modifiers = keyModifiers(original, parts);
  const name = token.toLowerCase().replace(/[\s_-]/gu, "");
  const canonical =
    Option.getOrUndefined(
      Records.get<string, TerminalKeyName>(TERMINAL_KEY_ALIASES, name),
    ) ?? name;
  const definition = Option.getOrUndefined(
    Records.get<string, TerminalKeyDefinition>(KEYS, canonical),
  );
  const literal = keyLiteral(original, token, name, definition);
  const key: TerminalKey = {
    original,
    name: canonical,
    code: 0,
    modifiers,
    explicitShift: Boolean(modifiers & KEY_MODIFIERS.shift),
    literal: undefined,
    text: undefined,
    shiftedCode: undefined,
    definition,
  };
  return literal === undefined
    ? namedKey(key)
    : literalKey(key, literal, parts.length === 0);
}

export function parseTerminalKeys(keys: string[] | undefined): TerminalKey[] {
  if (!Array.isArray(keys) || keys.length === 0)
    throw new Error("keys requires a nonempty array of terminal keys");
  return keys.map(parseTerminalKey);
}
