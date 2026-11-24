import { piComposerStyle } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { FG_RESET, fgAnsi, resolveVarRefs } from "@oh-my-pi/pi-tui/theme/color";
import { setThemeRulePolicy, type ThemeRulePolicy } from "@oh-my-pi/pi-tui/theme/rules";
import type { ColorMode, ThemeJson } from "@oh-my-pi/pi-tui/theme/schema";

const palettes = new WeakMap<
  Readonly<ThemeJson>,
  { mode: ColorMode; colors: readonly string[] }
>();

/** Paint foreground stripes without changing warning colors or backgrounds */
const compactRibbon: ThemeRulePolicy = (
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

const renderPiTop = piComposerStyle.renderTop;
const renderRibbonTop: typeof renderPiTop = (ctx) =>
  theme?.renderRule(ctx.box.horizontal, ctx.width) ??
  renderPiTop.call(piComposerStyle, ctx);

export function installCompactRibbon(): void {
  setThemeRulePolicy(compactRibbon);
  // Use the same built-in shape for saved settings and all composer previews
  piComposerStyle.renderTop = renderRibbonTop;
}
