import type { ColorMode, ThemeJson } from "@oh-my-pi/pi-tui/theme/schema";

export type ThemeRuleRenderer = (
  glyph: string,
  width: number,
  offset: number,
  totalWidth: number,
) => string | undefined;

export type ThemeRulePolicy = (
  source: Readonly<ThemeJson>,
  mode: ColorMode,
  glyph: string,
  width: number,
  offset: number,
  totalWidth: number,
) => string | undefined;

let rulePolicy: ThemeRulePolicy | undefined;

/** Install before drawing chrome, including themes constructed before loading */
export function setThemeRulePolicy(policy: ThemeRulePolicy | undefined): void {
  rulePolicy = policy;
}

export function createThemeRuleRenderer(
  source: Readonly<ThemeJson>,
  mode: ColorMode,
): ThemeRuleRenderer {
  return (glyph, width, offset, totalWidth) =>
    rulePolicy?.(source, mode, glyph, width, offset, totalWidth);
}
