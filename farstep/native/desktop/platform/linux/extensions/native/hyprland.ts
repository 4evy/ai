import GLib from "gi://GLib";
import { command, NativeRouter, type Snapshot, SOURCE_HASH } from "./router";

interface Workspace {
  id: number;
  name: string;
}
interface Monitor {
  activeWorkspace: Workspace;
  specialWorkspace: Workspace;
  focused: boolean;
}
interface Window {
  address: string;
  pid: number;
  class: string;
  workspace: Workspace;
  focusHistoryID: number;
}
const ipc = <T>(request: string): T =>
  JSON.parse(command(["hyprctl", "-j", request])) as T;
export class HyprlandRouter extends NativeRouter {
  constructor() {
    super("hyprland");
    if (!GLib.getenv("HYPRLAND_INSTANCE_SIGNATURE"))
      throw new Error("Hyprland IPC instance is missing");
  }
  protected configured() {
    this.verifyFile();
    // Lua rule errors are recorded without aborting the final hash assignment
    const errors = ipc<string[]>("configerrors");
    if (errors.length)
      throw new Error(
        `Hyprland workspace rules require a valid config: ${errors.join("; ")}`,
      );
    const loaded = command([
      "hyprctl",
      "repl",
      "return farstep_workspace_rules or ''",
    ]).trim();
    if (loaded !== SOURCE_HASH && loaded !== JSON.stringify(SOURCE_HASH))
      throw new Error(
        `Hyprland prerequisite: load ${this.configPath()} last with dofile in a stock Lua-config compositor`,
      );
  }
  protected snapshot(): Snapshot {
    const monitors = ipc<Monitor[]>("monitors");
    if (!monitors.length) throw new Error("Hyprland has no active output");
    const windows = ipc<Window[]>("clients");
    const workspaces = ipc<Workspace[]>("workspaces");
    const focused = ipc<Partial<Window>>("activewindow");
    return {
      windows: windows.map((w) => ({
        id: w.address,
        pid: w.pid,
        label: w.class,
        workspace: w.workspace.name,
      })),
      workspaces: workspaces.map((w) => w.name),
      visible: monitors.flatMap((m) => [
        m.activeWorkspace.name,
        m.specialWorkspace.name,
      ]),
      activeWorkspace: monitors.find((m) => m.focused)?.activeWorkspace.name ?? null,
      focusedWindow:
        focused.address && focused.address !== "0x0" ? focused.address : null,
    };
  }
}
