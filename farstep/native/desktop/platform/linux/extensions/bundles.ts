import { Struct } from "effect";

export type Desktop = keyof typeof resources;
export type Bundle = {
  desktop: Desktop;
  entry: string;
  output: string;
  qml?: boolean;
  hash?: { inputs: string[]; desktops: ("sway" | "niri" | "hyprland")[] };
};

export const bundles: Bundle[] = [
  { desktop: "gnome", entry: "gnome/extension.ts", output: "gnome/extension.js" },
  {
    desktop: "kde",
    entry: "kde/main.ts",
    output: "kde/contents/code/main.js",
    qml: true,
  },
  { desktop: "kde", entry: "kde/broker.ts", output: "kde/broker.js" },
  { desktop: "native", entry: "native/ready.ts", output: "native/ready.js" },
  {
    desktop: "native",
    entry: "native/broker.ts",
    output: "native/broker.js",
    hash: { inputs: ["native/ready.js"], desktops: ["sway", "niri", "hyprland"] },
  },
  { desktop: "native", entry: "nested/main.ts", output: "nested/main.js" },
  { desktop: "native", entry: "nested/ready.ts", output: "nested/ready.js" },
];

export const resources = {
  gnome: ["metadata.json"],
  kde: ["metadata.json", "contents/ui/main.qml", "farstep-workspaces.service.in"],
  native: [],
} satisfies Record<string, string[]>;

export const desktops = Struct.keys(resources);
