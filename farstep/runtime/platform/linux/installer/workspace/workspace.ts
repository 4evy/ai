import { readFileSync as readResource } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Struct } from "effect";
import * as v from "valibot";
import { command } from "../command";
import {
  KDE_WORKSPACE_EXTENSION,
  KDE_WORKSPACE_UNIT,
  locations,
  WORKSPACE_EXTENSION,
} from "../locations";

const settingsScript = readResource(new URL("./settings.js", import.meta.url), "utf8");

const sources = {
  "gnome-mutter-workspace": ["workspaceExtension", "extension.js"],
  "kde-kwin-workspace": ["kdeExtension", "contents/code/main.js"],
  "sway-workspace": ["package", "share/farstep/native/broker.js"],
  "niri-workspace": ["package", "share/farstep/native/broker.js"],
  "hyprland-workspace": ["package", "share/farstep/native/broker.js"],
  "cosmic-nested-sway-workspace": ["package", "share/farstep/native/broker.js"],
} as const;

const workspaceIsolationSchema = v.looseObject({
  sourceSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  backend: v.picklist(Struct.keys(sources)),
});

export const GNOME_SHELL_VERSION = [
  "busctl",
  "--user",
  "--json=short",
  "get-property",
  "org.gnome.Shell",
  "/org/gnome/Shell",
  "org.gnome.Shell.Extensions",
  "ShellVersion",
];
export async function workspaceExtensionEnabled(enable: boolean): Promise<void> {
  await command([
    "gjs",
    "-c",
    settingsScript,
    WORKSPACE_EXTENSION,
    enable ? "enable" : "disable",
  ]);
}

export async function kdeSession(): Promise<boolean> {
  const result = await command(
    [
      "busctl",
      "--user",
      "--json=short",
      "call",
      "org.freedesktop.DBus",
      "/org/freedesktop/DBus",
      "org.freedesktop.DBus",
      "NameHasOwner",
      "s",
      "org.kde.KWin",
    ],
    true,
  );
  if (result.code !== 0) return false;
  const value = v.parse(
    v.object({ data: v.strictTuple([v.boolean()]) }),
    JSON.parse(result.stdout),
  );
  return value.data[0];
}

export async function kdeExtensionEnabled(enable: boolean): Promise<void> {
  await command([
    "kwriteconfig6",
    "--file",
    "kwinrc",
    "--group",
    "Plugins",
    "--key",
    `${KDE_WORKSPACE_EXTENSION}Enabled`,
    enable ? "true" : "false",
  ]);
  const active = await kdeSession();
  if (active) {
    await command([
      "busctl",
      "--user",
      "call",
      "org.kde.KWin",
      "/KWin",
      "org.kde.KWin",
      "reconfigure",
    ]);
  }
  await command([
    "systemctl",
    "--user",
    enable ? "enable" : "disable",
    ...(!enable || active ? ["--now"] : []),
    KDE_WORKSPACE_UNIT,
  ]);
}

export async function workspaceIsolation(packagePath: string) {
  const result = await command(
    [join(packagePath, "bin/farstep-desktop"), "workspace", "inspect"],
    true,
  );
  if (result.code !== 0)
    return {
      status: "prerequisite" as const,
      reason: result.stderr.trim() || "The workspace adapter is not active",
    };
  const active = v.parse(workspaceIsolationSchema, JSON.parse(result.stdout));
  const p = locations();
  const [root, file] = sources[active.backend];
  const source = join(root === "package" ? packagePath : p[root], file);
  const installedSource = await readFile(source, "utf8");
  // Match the digest because minifiers rename and inline SOURCE_HASH
  if (!installedSource.includes(active.sourceSha256))
    return {
      status: "prerequisite" as const,
      reason:
        "The compositor is still running the previous workspace adapter; log out and back in to activate this version",
    };
  return { status: "ready" as const, backend: active.backend };
}
