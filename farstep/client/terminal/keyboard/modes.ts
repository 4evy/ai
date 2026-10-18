export interface TerminalKeyboardModes {
  applicationCursor: boolean;
  applicationKeypad: boolean;
  kittyFlags: number;
  modifyOtherKeys: number;
  formatOtherKeys: number;
  otherKeysMask: number;
}

const KEYBOARD_STACK_LIMIT = 32;
const CSI_PARAMETER_LIMIT = 256;
const DEFAULT_MODES = {
  applicationCursor: false,
  applicationKeypad: false,
  modifyOtherKeys: 0,
  formatOtherKeys: 0,
  otherKeysMask: 0,
};

function unsignedParameter(value: string, omitted?: number): number | undefined {
  if (!value) return omitted;
  if (!/^[0-9]+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed <= 0xffffffff ? parsed : undefined;
}

class KeyboardReplay {
  readonly modes: TerminalKeyboardModes = {
    ...DEFAULT_MODES,
    kittyFlags: 0,
  };
  private readonly mainStack: number[] = [];
  private readonly alternateStack: number[] = [];
  private alternate = false;
  private state: "ground" | "escape" | "csi" | "osc" | "string" = "ground";
  private parameters = "";
  private intermediate = false;
  private invalid = false;
  private stringEscape = false;

  private reset(): void {
    Object.assign(this.modes, DEFAULT_MODES);
    this.mainStack.length = 0;
    this.alternateStack.length = 0;
    this.alternate = false;
  }

  private privateModes(parameters: string, enabled: boolean): void {
    const parsed = parameters
      .slice(1)
      .split(";")
      .map((value) => unsignedParameter(value, 0));
    if (!parsed.every((value) => value !== undefined)) return;
    for (const value of parsed) {
      switch (value) {
        case 1:
          this.modes.applicationCursor = enabled;
          break;
        case 66:
          this.modes.applicationKeypad = enabled;
          break;
        case 47:
        case 1047:
        case 1049:
          // Screen erasure on entry/exit does not erase its keyboard mode stack
          this.alternate = enabled;
          break;
      }
    }
  }

  private setKitty(stack: number[], set: RegExpExecArray): void {
    const flags = unsignedParameter(set[1] ?? "");
    const operation = unsignedParameter(set[2] ?? "", 1);
    if (
      flags === undefined ||
      operation === undefined ||
      operation < 1 ||
      operation > 3
    )
      return;
    const current = stack.at(-1) ?? 0;
    let updated: number;
    switch (operation) {
      case 1:
        updated = flags;
        break;
      case 2:
        updated = (current | flags) >>> 0;
        break;
      default:
        updated = (current & ~flags) >>> 0;
    }
    if (stack.length) stack[stack.length - 1] = updated;
    else stack.push(updated);
  }

  private kitty(parameters: string): void {
    const stack = this.alternate ? this.alternateStack : this.mainStack;
    const push = /^>([0-9]*)$/u.exec(parameters);
    if (push) {
      const flags = unsignedParameter(push[1] ?? "", 0);
      if (flags === undefined) return;
      if (!stack.length) stack.push(0);
      if (stack.length === KEYBOARD_STACK_LIMIT) stack.shift();
      stack.push(flags);
      return;
    }
    const pop = /^<([0-9]*)$/u.exec(parameters);
    if (pop) {
      const count = unsignedParameter(pop[1] ?? "", 1);
      if (count !== undefined) stack.length = Math.max(0, stack.length - count);
      return;
    }
    const set = /^=([0-9]+)(?:;([0-9]*))?$/u.exec(parameters);
    if (set) this.setKitty(stack, set);
  }

  private setXterm(parameters: string, final: string): void {
    const set = /^>([0-9]+)(?::([0-9]+))?(?:;([0-9]*)(?::([0-9]+))?)?$/u.exec(
      parameters,
    );
    if (!set || unsignedParameter(set[1] ?? "") !== 4) return;
    const parsed = this.xtermParameters(set);
    if (!parsed) return;
    const { selectorMask, levelMask, value } = parsed;
    const mask = set[2] === undefined ? levelMask : selectorMask;
    this.updateXterm(final, value, mask, set[2] !== undefined || set[4] !== undefined);
  }

  private xtermParameters(set: RegExpExecArray) {
    const selectorMask = unsignedParameter(set[2] ?? "", 0);
    const levelMask = unsignedParameter(set[4] ?? "", 0);
    const value = unsignedParameter(set[3] ?? "", 0);
    if (selectorMask === undefined || levelMask === undefined || value === undefined)
      return undefined;
    if (set[2] !== undefined && set[4] !== undefined && selectorMask !== levelMask)
      return undefined;
    return { selectorMask, levelMask, value };
  }

  private updateXterm(
    final: string,
    value: number,
    mask: number,
    masked: boolean,
  ): void {
    switch (final) {
      case "m":
        if (value <= 3) {
          this.modes.modifyOtherKeys = value;
          this.modes.otherKeysMask = mask;
        }
        break;
      case "f":
        if (!masked && value <= 1) this.modes.formatOtherKeys = value;
        break;
    }
  }

  // https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Alt-and-Meta-Keys
  private xterm(parameters: string, final: string): void {
    if (parameters === ">" && (final === "m" || final === "f")) {
      if (final === "m") {
        this.modes.modifyOtherKeys = 0;
        this.modes.otherKeysMask = 0;
      } else this.modes.formatOtherKeys = 0;
      return;
    }
    if (final === "n" && /^>0*4$/u.test(parameters)) {
      this.modes.modifyOtherKeys = 0;
      this.modes.otherKeysMask = 0;
      return;
    }
    if (final === "m" || final === "f") this.setXterm(parameters, final);
  }

  private applyCsi(parameters: string, final: string): void {
    switch (final) {
      case "h":
      case "l":
        if (parameters.startsWith("?")) {
          this.privateModes(parameters, final === "h");
          return;
        }
        break;
      case "u":
        this.kitty(parameters);
        return;
    }
    this.xterm(parameters, final);
  }

  private consumeString(code: number, character: string): void {
    if (
      (this.state === "osc" && code === 0x07) ||
      (this.stringEscape && character === "\\")
    ) {
      this.state = "ground";
      this.stringEscape = false;
    } else this.stringEscape = code === 0x1b;
  }

  private escapeFinal(character: string): void {
    switch (character) {
      case "[":
        this.state = "csi";
        this.parameters = "";
        this.invalid = false;
        break;
      case "]":
        this.state = "osc";
        this.stringEscape = false;
        break;
      case "P":
      case "X":
      case "^":
      case "_":
        this.state = "string";
        this.stringEscape = false;
        break;
      case "=":
        this.modes.applicationKeypad = true;
        break;
      case ">":
        this.modes.applicationKeypad = false;
        break;
      case "c":
        this.reset();
        break;
    }
  }

  private consumeEscape(code: number, character: string): void {
    if (code >= 0x20 && code <= 0x2f) {
      this.intermediate = true;
      return;
    }
    this.state = "ground";
    if (!this.intermediate) this.escapeFinal(character);
  }

  private consumeCsi(code: number, character: string): void {
    if (code >= 0x40 && code <= 0x7e) {
      if (!this.intermediate && !this.invalid)
        this.applyCsi(this.parameters, character);
      this.state = "ground";
      return;
    }
    if (code >= 0x20 && code <= 0x2f) {
      this.intermediate = true;
      return;
    }
    if (this.intermediate || this.parameters.length === CSI_PARAMETER_LIMIT)
      this.invalid = true;
    else if (!this.invalid) this.parameters += character;
  }

  consume(code: number, character: string): void {
    if (code === 0x18 || code === 0x1a) {
      this.state = "ground";
      this.stringEscape = false;
      return;
    }
    if (this.state === "osc" || this.state === "string") {
      this.consumeString(code, character);
      return;
    }
    if (code === 0x1b) {
      this.state = "escape";
      this.intermediate = false;
      return;
    }
    this.consumeControl(code, character);
  }

  private consumeControl(code: number, character: string): void {
    if (this.state === "ground" || code < 0x20 || code === 0x7f) return;
    // Decoded Unicode C1 code points are text, not raw 8-bit VT controls Only their
    // ESC-prefixed equivalents are recoverable from UTF-8 replay
    if (code > 0x7e) {
      this.state = "ground";
      return;
    }
    if (this.state === "escape") this.consumeEscape(code, character);
    else this.consumeCsi(code, character);
  }

  result(): TerminalKeyboardModes {
    // https://sw.kovidgoyal.net/kitty/keyboard-protocol/#progressive-enhancement
    this.modes.kittyFlags =
      (this.alternate ? this.alternateStack : this.mainStack).at(-1) ?? 0;
    return this.modes;
  }
}

// Replay starts at defaults; modes preceding a retained-output gap are unknowable
export function readKeyboardModes(terminalText?: string): TerminalKeyboardModes {
  const replay = new KeyboardReplay();
  const text = terminalText ?? "";
  for (let index = 0; index < text.length; index++)
    replay.consume(text.charCodeAt(index), text[index] ?? "");
  return replay.result();
}
