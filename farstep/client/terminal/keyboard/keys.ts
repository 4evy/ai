import { Record as Records } from "effect";

export interface TerminalKeyDefinition {
  code: number;
  legacy?: string;
  keypad?: string;
  modifier?: number;
}

export const KEY_MODIFIERS = {
  shift: 1,
  alt: 2,
  ctrl: 4,
  super: 8,
  hyper: 16,
  meta: 32,
  capslock: 64,
  numlock: 128,
} as const;

export const UNSUPPORTED_LEGACY_MODIFIERS =
  KEY_MODIFIERS.super |
  KEY_MODIFIERS.hyper |
  KEY_MODIFIERS.capslock |
  KEY_MODIFIERS.numlock;

export const XTERM_MODIFIERS = {
  shift: KEY_MODIFIERS.shift,
  alt: KEY_MODIFIERS.alt,
  ctrl: KEY_MODIFIERS.ctrl,
  meta: 8,
} as const;
export function xtermModifiers(modifiers: number): number {
  return (
    (modifiers & (KEY_MODIFIERS.shift | KEY_MODIFIERS.alt | KEY_MODIFIERS.ctrl)) +
    (modifiers & KEY_MODIFIERS.meta ? XTERM_MODIFIERS.meta : 0)
  );
}

// Kitty key identities, not the parameter numbers in legacy CSI sequences
// https://sw.kovidgoyal.net/kitty/keyboard-protocol/#functional
// Legacy and DECKPAM bytes follow xterm's function and VT102/VT220 keypad tables
// https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
export const TERMINAL_KEY_DEFINITIONS = {
  escape: { code: 27, legacy: "\x1b" },
  enter: { code: 13, legacy: "\r" },
  tab: { code: 9, legacy: "\t" },
  backspace: { code: 127, legacy: "\x7f" },
  space: { code: 32, legacy: " " },
  insert: { code: 57348, legacy: "\x1b[2~" },
  delete: { code: 57349, legacy: "\x1b[3~" },
  left: { code: 57350, legacy: "\x1b[D" },
  right: { code: 57351, legacy: "\x1b[C" },
  up: { code: 57352, legacy: "\x1b[A" },
  down: { code: 57353, legacy: "\x1b[B" },
  pageup: { code: 57354, legacy: "\x1b[5~" },
  pagedown: { code: 57355, legacy: "\x1b[6~" },
  home: { code: 57356, legacy: "\x1b[H" },
  end: { code: 57357, legacy: "\x1b[F" },
  capslock: { code: 57358 },
  scrolllock: { code: 57359 },
  numlock: { code: 57360 },
  printscreen: { code: 57361 },
  pause: { code: 57362 },
  menu: { code: 57363, legacy: "\x1b[29~" },
  f1: { code: 57364, legacy: "\x1bOP" },
  f2: { code: 57365, legacy: "\x1bOQ" },
  f3: { code: 57366, legacy: "\x1bOR" },
  f4: { code: 57367, legacy: "\x1bOS" },
  f5: { code: 57368, legacy: "\x1b[15~" },
  f6: { code: 57369, legacy: "\x1b[17~" },
  f7: { code: 57370, legacy: "\x1b[18~" },
  f8: { code: 57371, legacy: "\x1b[19~" },
  f9: { code: 57372, legacy: "\x1b[20~" },
  f10: { code: 57373, legacy: "\x1b[21~" },
  f11: { code: 57374, legacy: "\x1b[23~" },
  f12: { code: 57375, legacy: "\x1b[24~" },
  f13: { code: 57376, legacy: "\x1b[25~" },
  f14: { code: 57377, legacy: "\x1b[26~" },
  f15: { code: 57378, legacy: "\x1b[28~" },
  f16: { code: 57379, legacy: "\x1b[29~" },
  f17: { code: 57380, legacy: "\x1b[31~" },
  f18: { code: 57381, legacy: "\x1b[32~" },
  f19: { code: 57382, legacy: "\x1b[33~" },
  f20: { code: 57383, legacy: "\x1b[34~" },
  f21: { code: 57384 },
  f22: { code: 57385 },
  f23: { code: 57386 },
  f24: { code: 57387 },
  f25: { code: 57388 },
  f26: { code: 57389 },
  f27: { code: 57390 },
  f28: { code: 57391 },
  f29: { code: 57392 },
  f30: { code: 57393 },
  f31: { code: 57394 },
  f32: { code: 57395 },
  f33: { code: 57396 },
  f34: { code: 57397 },
  f35: { code: 57398 },
  kp0: { code: 57399, legacy: "0", keypad: "\x1bOp" },
  kp1: { code: 57400, legacy: "1", keypad: "\x1bOq" },
  kp2: { code: 57401, legacy: "2", keypad: "\x1bOr" },
  kp3: { code: 57402, legacy: "3", keypad: "\x1bOs" },
  kp4: { code: 57403, legacy: "4", keypad: "\x1bOt" },
  kp5: { code: 57404, legacy: "5", keypad: "\x1bOu" },
  kp6: { code: 57405, legacy: "6", keypad: "\x1bOv" },
  kp7: { code: 57406, legacy: "7", keypad: "\x1bOw" },
  kp8: { code: 57407, legacy: "8", keypad: "\x1bOx" },
  kp9: { code: 57408, legacy: "9", keypad: "\x1bOy" },
  kpdecimal: { code: 57409, legacy: ".", keypad: "\x1bOn" },
  kpdivide: { code: 57410, legacy: "/", keypad: "\x1bOo" },
  kpmultiply: { code: 57411, legacy: "*", keypad: "\x1bOj" },
  kpsubtract: { code: 57412, legacy: "-", keypad: "\x1bOm" },
  kpadd: { code: 57413, legacy: "+", keypad: "\x1bOk" },
  kpenter: { code: 57414, legacy: "\r", keypad: "\x1bOM" },
  kpequal: { code: 57415, legacy: "=", keypad: "\x1bOX" },
  kpseparator: { code: 57416, legacy: ",", keypad: "\x1bOl" },
  // Xterm's ordinary keyboard path treats these as navigation, not DECKPAM
  // https://github.com/ThomasDickey/xterm-snapshots/blob/master/input.c
  kpleft: { code: 57417, legacy: "\x1b[D" },
  kpright: { code: 57418, legacy: "\x1b[C" },
  kpup: { code: 57419, legacy: "\x1b[A" },
  kpdown: { code: 57420, legacy: "\x1b[B" },
  kppageup: { code: 57421, legacy: "\x1b[5~" },
  kppagedown: { code: 57422, legacy: "\x1b[6~" },
  kphome: { code: 57423, legacy: "\x1b[H" },
  kpend: { code: 57424, legacy: "\x1b[F" },
  kpinsert: { code: 57425, legacy: "\x1b[2~" },
  kpdelete: { code: 57426, legacy: "\x1b[3~" },
  kpbegin: { code: 57427, legacy: "\x1b[E" },
  mediaplay: { code: 57428 },
  mediapause: { code: 57429 },
  mediaplaypause: { code: 57430 },
  mediareverse: { code: 57431 },
  mediastop: { code: 57432 },
  mediafastforward: { code: 57433 },
  mediarewind: { code: 57434 },
  mediatracknext: { code: 57435 },
  mediatrackprevious: { code: 57436 },
  mediarecord: { code: 57437 },
  lowervolume: { code: 57438 },
  raisevolume: { code: 57439 },
  mutevolume: { code: 57440 },
  leftshift: { code: 57441, modifier: KEY_MODIFIERS.shift },
  leftcontrol: { code: 57442, modifier: KEY_MODIFIERS.ctrl },
  leftalt: { code: 57443, modifier: KEY_MODIFIERS.alt },
  leftsuper: { code: 57444, modifier: KEY_MODIFIERS.super },
  lefthyper: { code: 57445, modifier: KEY_MODIFIERS.hyper },
  leftmeta: { code: 57446, modifier: KEY_MODIFIERS.meta },
  rightshift: { code: 57447, modifier: KEY_MODIFIERS.shift },
  rightcontrol: { code: 57448, modifier: KEY_MODIFIERS.ctrl },
  rightalt: { code: 57449, modifier: KEY_MODIFIERS.alt },
  rightsuper: { code: 57450, modifier: KEY_MODIFIERS.super },
  righthyper: { code: 57451, modifier: KEY_MODIFIERS.hyper },
  rightmeta: { code: 57452, modifier: KEY_MODIFIERS.meta },
  isolevel3shift: { code: 57453 },
  isolevel5shift: { code: 57454 },
} as const satisfies Readonly<Record<string, TerminalKeyDefinition>>;

export type TerminalKeyName = keyof typeof TERMINAL_KEY_DEFINITIONS;

export const LEGACY_CONTROL_KEYS: ReadonlySet<number> = new Set([
  TERMINAL_KEY_DEFINITIONS.enter.code,
  TERMINAL_KEY_DEFINITIONS.escape.code,
  TERMINAL_KEY_DEFINITIONS.tab.code,
  TERMINAL_KEY_DEFINITIONS.backspace.code,
]);

const KEYPAD_PREFIXES = ["keypad", "numpad"] as const;
const keypadAliases: Record<string, TerminalKeyName> = {};
for (const name of Records.keys(TERMINAL_KEY_DEFINITIONS)) {
  if (!name.startsWith("kp")) continue;
  for (const prefix of KEYPAD_PREFIXES)
    keypadAliases[`${prefix}${name.slice(2)}`] = name;
}

export const TERMINAL_KEY_ALIASES = {
  ...keypadAliases,
  esc: "escape",
  return: "enter",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  ins: "insert",
  del: "delete",
  bs: "backspace",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  prtsc: "printscreen",
  prtscr: "printscreen",
  prtscrn: "printscreen",
  print: "printscreen",
  apps: "menu",
  contextmenu: "menu",
  volumedown: "lowervolume",
  volumeup: "raisevolume",
  volumemute: "mutevolume",
  mute: "mutevolume",
  play: "mediaplay",
  playpause: "mediaplaypause",
  stop: "mediastop",
  fastforward: "mediafastforward",
  rewind: "mediarewind",
  nexttrack: "mediatracknext",
  previoustrack: "mediatrackprevious",
  medianext: "mediatracknext",
  mediaprevious: "mediatrackprevious",
  record: "mediarecord",
  kpperiod: "kpdecimal",
  kpplus: "kpadd",
  kpminus: "kpsubtract",
  kpequals: "kpequal",
  kpcomma: "kpseparator",
  kppgup: "kppageup",
  kppgdn: "kppagedown",
  kppgdown: "kppagedown",
  kpins: "kpinsert",
  kpdel: "kpdelete",
  lshift: "leftshift",
  rshift: "rightshift",
  lctrl: "leftcontrol",
  rctrl: "rightcontrol",
  leftctrl: "leftcontrol",
  rightctrl: "rightcontrol",
  lalt: "leftalt",
  ralt: "rightalt",
  leftoption: "leftalt",
  rightoption: "rightalt",
  lsuper: "leftsuper",
  rsuper: "rightsuper",
  leftcommand: "leftsuper",
  rightcommand: "rightsuper",
  leftwin: "leftsuper",
  rightwin: "rightsuper",
  lhyper: "lefthyper",
  rhyper: "righthyper",
  lmeta: "leftmeta",
  rmeta: "rightmeta",
  altgr: "isolevel3shift",
} as const satisfies Readonly<Record<string, TerminalKeyName>>;
