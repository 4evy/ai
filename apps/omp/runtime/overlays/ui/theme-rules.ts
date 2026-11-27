import type { ColorDepth } from "@oh-my-pi/pi-tui/theme/color";
import type { ThemeJson } from "@oh-my-pi/pi-tui/theme/schema";

export type ThemeRulePolicy = (
  source: Readonly<ThemeJson>,
  depth: ColorDepth,
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

export function renderThemeRule(
  source: Readonly<ThemeJson>,
  depth: ColorDepth,
  glyph: string,
  width: number,
  offset: number,
  totalWidth: number,
): string | undefined {
  return source.ribbon
    ? rulePolicy?.(source, depth, glyph, width, offset, totalWidth)
    : undefined;
}
