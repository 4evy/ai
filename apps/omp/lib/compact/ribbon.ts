import { type ColorDepth, FG_DEFAULT, fgSgr } from "@oh-my-pi/pi-tui/theme/color";
import { setThemeRulePolicy, type ThemeRulePolicy } from "@oh-my-pi/pi-tui/theme/rules";
import type { ThemeJson } from "@oh-my-pi/pi-tui/theme/schema";
import { resolveColorValue } from "@oh-my-pi/pi-tui/theme/theme";

const palettes = new WeakMap<
  Readonly<ThemeJson>,
  { depth: ColorDepth; colors: readonly string[] }
>();

/** Paint foreground stripes without changing warning colors or backgrounds */
const compactRibbon: ThemeRulePolicy = (
  source,
  depth,
  glyph,
  width,
  offset,
  totalWidth,
) => {
  if (!source.ribbon) return undefined;
  let cached = palettes.get(source);
  if (!cached || cached.depth !== depth) {
    cached = {
      depth,
      colors: source.ribbon.map((color) =>
        fgSgr(resolveColorValue(color, source.vars ?? {}), depth),
      ),
    };
    palettes.set(source, cached);
  }
  const colors = cached.colors;
  let result = "";
  for (let index = 0; index < colors.length; index++) {
    const start = Math.max(offset, Math.floor((index * totalWidth) / colors.length));
    const end = Math.min(
      offset + width,
      Math.floor(((index + 1) * totalWidth) / colors.length),
    );
    if (end > start) result += colors[index] + glyph.repeat(end - start);
  }
  return result ? result + FG_DEFAULT : "";
};

export function installCompactRibbon(): void {
  setThemeRulePolicy(compactRibbon);
}
