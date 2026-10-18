import Gio from "gi://Gio";
import GLib from "gi://GLib";
import type { CompositorRouter } from "../shared/leases/leases";
import { filename, label, type NativeDesktop, SLOT_COUNT, workspace } from "./rules";

export const SOURCE_HASH = "@SOURCE_HASH@";
export interface Window {
  id: number | string;
  pid: number | null;
  label: string | null;
  workspace: string | null;
}
export interface Snapshot {
  windows: Window[];
  visible: string[];
  workspaces: string[];
  activeWorkspace: string | null;
  focusedWindow: number | string | null;
}
interface Lease {
  id: string;
  slot: number;
  workspace: string;
  released: boolean;
}
export function command(argv: string[]): string {
  const process = Gio.Subprocess.new(
    ["timeout", "--kill-after=1s", "5s", ...argv],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
  );
  const [, stdout, stderr] = process.communicate_utf8(null, null);
  if (!process.get_successful())
    throw new Error(`Compositor IPC failed: ${stderr?.trim() || stdout?.trim()}`);
  return stdout ?? "";
}
export function read(path: string): string {
  const [, bytes] = GLib.file_get_contents(path);
  return new TextDecoder().decode(bytes);
}

export abstract class NativeRouter implements CompositorRouter {
  readonly environment: Record<string, string> = {
    FARSTEP_WORKSPACE_SOCKET: "proxy",
    WAYLAND_DISPLAY: GLib.getenv("WAYLAND_DISPLAY") ?? "",
    DBUS_SESSION_BUS_ADDRESS: GLib.getenv("DBUS_SESSION_BUS_ADDRESS") ?? "",
    FARSTEP_WORKSPACE_SCOPE_PARENT:
      GLib.getenv("FARSTEP_WORKSPACE_SCOPE_PARENT") ??
      (GLib.getenv("INVOCATION_ID") ? "farstep-desktop.service" : ""),
  };
  protected leases = new Map<string, Lease>();
  protected nested = GLib.getenv("FARSTEP_NESTED_DESKTOP") === "cosmic";
  constructor(protected desktop: NativeDesktop) {
    this.environment.XDG_CURRENT_DESKTOP =
      desktop === "hyprland" ? "Hyprland" : desktop;
  }
  protected abstract snapshot(): Snapshot;
  protected abstract configured(): void;
  protected reserve(_slot: number, _state: Snapshot) {}
  protected attach(_workspace: string) {}
  protected remove(_workspace: string) {}
  protected sameWorkspace(actual: string | null, expected: string): boolean {
    return actual === expected;
  }
  protected configPath(): string {
    return (
      GLib.getenv("FARSTEP_WORKSPACE_RULES") ??
      `${GLib.get_user_config_dir()}/farstep/${filename(this.desktop)}`
    );
  }
  protected verifyFile(): string {
    const path = this.configPath();
    const packagePath = GLib.getenv("FARSTEP_PACKAGE_PATH");
    if (!packagePath) throw new Error("Workspace package path is missing");
    const expected = read(
      `${packagePath}/share/farstep/native/${filename(this.desktop)}`,
    ).replaceAll("@PACKAGE@", packagePath);
    if (read(path) !== expected)
      throw new Error(`Workspace rules are missing or stale: ${path}`);
    return path;
  }
  environmentForLease(id: string): Record<string, string> {
    const lease = this.leases.get(id);
    if (!lease) throw new Error("Workspace lease is missing");
    return { FARSTEP_WORKSPACE_LABEL: label(lease.slot) };
  }
  call(operation: string, request: { id: string; pid: number }): string {
    if (operation === "Inspect" || operation === "Reserve" || operation === "Attach")
      this.configured();
    const state = this.snapshot();
    switch (operation) {
      case "Inspect":
        return JSON.stringify({
          backend: this.nested
            ? "cosmic-nested-sway-workspace"
            : `${this.desktop}-workspace`,
          sourceSha256: SOURCE_HASH,
          activeWorkspace: state.activeWorkspace,
          focusedWindow: state.focusedWindow,
          leases: [...this.leases.values()].map((lease) => ({
            ...lease,
            windows: state.windows.filter(
              (window) => window.label === label(lease.slot),
            ),
          })),
        });
      case "Reserve":
        return this.reserveLease(request.id, state);
      case "Attach": {
        const lease = this.leases.get(request.id);
        if (!lease) throw new Error("Workspace lease is missing");
        this.attach(lease.workspace);
        return "true";
      }
      case "Release":
        return this.releaseLease(request.id, this.leases.get(request.id), state);
      default:
        throw new Error(`Unknown workspace operation: ${operation}`);
    }
  }
  private reserveLease(id: string, state: Snapshot): string {
    if (this.leases.has(id)) throw new Error("Reused workspace lease");
    // Reuse only absent, inactive workspaces with no remaining windows
    const used = new Set([...this.leases.values()].map((lease) => lease.slot));
    const slot = Array.from({ length: SLOT_COUNT }, (_, i) => i + 1).find(
      (slot) =>
        !used.has(slot) &&
        !state.workspaces.some((name) => this.sameWorkspace(name, workspace(slot))) &&
        !state.windows.some((window) => window.label === label(slot)),
    );
    if (!slot) throw new Error("All 32 isolated workspace slots are in use");
    this.reserve(slot, state);
    this.leases.set(id, {
      id: id,
      slot,
      workspace: workspace(slot),
      released: false,
    });
    return JSON.stringify({ workspace: workspace(slot) });
  }
  private releaseLease(id: string, lease: Lease | undefined, state: Snapshot): string {
    if (!lease) return "true";
    lease.released = true;
    if (
      state.windows.some(
        (window) =>
          this.sameWorkspace(window.workspace, lease.workspace) ||
          window.label === label(lease.slot),
      )
    )
      return "false";
    if (
      state.visible.some((name) => this.sameWorkspace(name, lease.workspace)) &&
      !this.nested
    )
      return "false";
    this.remove(lease.workspace);
    this.leases.delete(id);
    return "true";
  }
}
