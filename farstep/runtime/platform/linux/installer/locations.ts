import { dirname, join } from "node:path";
import { paths } from "#farstep/runtime/state";
export const UNIT = "farstep-desktop.service";
export const KDE_WORKSPACE_UNIT = "farstep-workspaces.service";
export const KDE_WORKSPACE_EXTENSION = "farstep-workspaces";
export const KDE_WORKSPACE_FILES = [
  "metadata.json",
  "contents/ui/main.qml",
  "contents/code/main.js",
  "broker.js",
];
export const WORKSPACE_EXTENSION_FILES = ["extension.js", "metadata.json"];
export const NATIVE_WORKSPACE_FILES = [
  "workspaces.conf",
  "workspaces.kdl",
  "workspaces.lua",
];
const APP = "org.farstep.Farstep.desktop";
export const WORKSPACE_EXTENSION = "workspaces@farstep.local";
export function locations() {
  const p = paths();
  return {
    ...p,
    unit: join(p.config, "systemd/user", UNIT),
    wants: join(p.config, "systemd/user/graphical-session.target.wants", UNIT),
    descriptor: join(dirname(p.data), "applications", APP),
    environment: join(p.state, "desktop.env"),
    workspaceExtension: join(
      dirname(p.data),
      "gnome-shell/extensions",
      WORKSPACE_EXTENSION,
    ),
    nativeRules: join(p.config, "farstep"),
    kdeExtension: join(dirname(p.data), "kwin/scripts", KDE_WORKSPACE_EXTENSION),
    kdeUnit: join(p.config, "systemd/user", KDE_WORKSPACE_UNIT),
    kdeWants: join(
      p.config,
      "systemd/user/graphical-session.target.wants",
      KDE_WORKSPACE_UNIT,
    ),
    record: join(p.state, "installer.json"),
    current: join(p.data, "current"),
    previous: join(p.data, "previous"),
    roots: join(p.state, "gcroots"),
    lock: join(p.state, "maintenance.lock"),
    preparation: join(p.state, "maintenance.lock", "preparation.json"),
  };
}

export type Locations = ReturnType<typeof locations>;
