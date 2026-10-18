import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const EFFORT_SHORTCUTS = [
  {
    key: "alt+,",
    direction: -1,
    description: "Decrease thinking effort",
  },
  {
    key: "alt+.",
    direction: 1,
    description: "Increase thinking effort",
  },
] as const;

const UNSELECTED_LEVELS = new Set<ThinkingLevel>([
  ThinkingLevel.Off,
  ThinkingLevel.Inherit,
]);

function effortIndex(
  levels: readonly ThinkingLevel[],
  current: ThinkingLevel | undefined,
  defaultLevel: ThinkingLevel | undefined,
): number {
  const index =
    current === undefined || UNSELECTED_LEVELS.has(current)
      ? -1
      : levels.indexOf(current);
  if (index >= 0) return index;
  return Math.max(0, defaultLevel === undefined ? -1 : levels.indexOf(defaultLevel));
}

export default function thinking(api: ExtensionAPI) {
  for (const { key, direction, description } of EFFORT_SHORTCUTS) {
    api.registerShortcut(key, {
      description,
      handler: (ctx) => step(api, ctx, direction),
    });
  }
}

function step(api: ExtensionAPI, ctx: ExtensionContext, direction: -1 | 1): void {
  // The setter applies the session ceiling and emits OMP's normal UI updates
  const levels = ctx.model?.reasoning ? (ctx.model.thinking?.efforts ?? []) : [];
  if (!levels.length) {
    ctx.ui.notify("Current model does not support adjustable thinking effort", "info");
    return;
  }
  const index = effortIndex(
    levels,
    api.getThinkingLevel(),
    ctx.model?.thinking?.defaultLevel,
  );
  const next = levels[index + direction];
  if (next === undefined) {
    ctx.ui.notify(
      `Thinking effort is already at the ${direction < 0 ? "lowest" : "highest"} level (${levels[index]})`,
      "info",
    );
    return;
  }
  if (direction > 0 && next === ThinkingLevel.Max) {
    ctx.ui.notify("Max effort is available under /model", "info");
    return;
  }
  api.setThinkingLevel(next);
  if (api.getThinkingLevel() !== next)
    ctx.ui.notify("Thinking effort is already at the session ceiling", "info");
}
