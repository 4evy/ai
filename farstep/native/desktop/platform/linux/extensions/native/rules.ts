export const SLOT_COUNT = 32;
export type NativeDesktop = "sway" | "niri" | "hyprland";
export const label = (slot: number) => `farstep-slot-${slot}`;
export const workspace = (slot: number) => `Farstep ${slot}`;
export const marker = (hash: string) => `Farstep routing ${hash}`;
const DESKTOP_RULES = {
  sway: {
    extension: "conf",
    before: (_hash: string) => [],
    slot: (slot: number) => [
      `assign [app_id="^${label(slot)}$"] workspace ${JSON.stringify(workspace(slot))}`,
      `no_focus [app_id="^${label(slot)}$"]`,
    ],
    after: (hash: string) => [
      `exec_always --no-startup-id gjs -m "@PACKAGE@/share/farstep/native/ready.js" ${hash}`,
    ],
  },
  niri: {
    extension: "kdl",
    before: (hash: string) => [`workspace ${JSON.stringify(marker(hash))}`],
    slot: (slot: number) => [
      "window-rule {",
      `    match app-id=${JSON.stringify(`^${label(slot)}$`)}`,
      `    open-on-workspace ${JSON.stringify(workspace(slot))}`,
      "    open-focused false",
      "}",
    ],
    after: (_hash: string) => [],
  },
  hyprland: {
    extension: "lua",
    before: (_hash: string) => [],
    slot: (slot: number) => [
      `hl.window_rule { name = "farstep-slot-${slot}", match = { class = "^${label(slot)}$" }, workspace = "name:${workspace(slot)} silent", no_initial_focus = true }`,
    ],
    after: (hash: string) => [`farstep_workspace_rules = ${JSON.stringify(hash)}`],
  },
} satisfies Record<
  NativeDesktop,
  {
    extension: string;
    before(hash: string): string[];
    slot(slot: number): string[];
    after(hash: string): string[];
  }
>;

export const filename = (desktop: NativeDesktop) =>
  `workspaces.${DESKTOP_RULES[desktop].extension}`;

export function rules(desktop: NativeDesktop, hash: string): string {
  const policy = DESKTOP_RULES[desktop];
  return `${[
    ...policy.before(hash),
    ...Array.from({ length: SLOT_COUNT }, (_, index) => policy.slot(index + 1)).flat(),
    ...policy.after(hash),
  ].join("\n")}\n`;
}
