import { FG_RESET, fgAnsi, resolveVarRefs } from "@oh-my-pi/pi-tui/theme/color";
import type { ThemeRulePolicy } from "@oh-my-pi/pi-tui/theme/rules";
import type { ColorMode, ThemeJson } from "@oh-my-pi/pi-tui/theme/schema";

const palettes = new WeakMap<
  Readonly<ThemeJson>,
  { mode: ColorMode; colors: readonly string[] }
>();

/** Paint foreground stripes without changing warning colors or backgrounds */
export const compactRibbon: ThemeRulePolicy = (
  source,
  mode,
  glyph,
  width,
  offset,
  totalWidth,
) => {
  if (!source.ribbon) return undefined;
  let cached = palettes.get(source);
  if (!cached || cached.mode !== mode) {
    cached = {
      mode,
      colors: source.ribbon.map((color) =>
        fgAnsi(resolveVarRefs(color, source.vars ?? {}), mode),
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
  return result ? result + FG_RESET : "";
};
