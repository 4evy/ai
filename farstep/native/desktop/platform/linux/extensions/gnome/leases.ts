import type Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import { prepareLaunch } from "../shared/launcher";
import { populated, stop, watchExit } from "../shared/processes";
import { SOURCE_HASH } from "../shared/protocol/protocol";
import type { Lease } from "./types";
import { trackWindow } from "./windows";

// Rust owns leases; this adapter invokes Mutter and emergency systemd operations
export class WorkspaceLeases {
  private disabled = false;
  readonly leases = new Map<string, Lease>();
  constructor(
    private manager: Gio.DBusConnection,
    private settings: Gio.Settings,
  ) {}

  shutdown() {
    for (const lease of this.leases.values()) {
      lease.released = true;
      this.stop(lease);
    }
    this.disabled = true;
    for (const lease of this.leases.values()) {
      for (const [window, signals] of lease.signals)
        for (const signal of signals) window.disconnect(signal);
      lease.signals.clear();
      this.remove(lease.id, lease);
    }
    this.leases.clear();
  }

  ready(_lease: Lease) {}

  stop(lease: Lease) {
    stop(this.manager, lease);
  }

  prerequisite() {
    if (!global.context.get_wayland_compositor())
      throw new Error("Wayland GNOME 50 or 51 is required");
    if (this.settings.get_boolean("dynamic-workspaces"))
      throw new Error("Farstep isolation requires static GNOME workspaces");
    if (this.settings.get_boolean("workspaces-only-on-primary"))
      throw new Error("Farstep isolation requires workspaces on every monitor");
    if (
      !GLib.find_program_in_path("setsid") ||
      !GLib.find_program_in_path("dbus-run-session")
    )
      throw new Error("setsid and dbus-run-session must be available to GNOME Shell");
  }

  inspect() {
    this.prerequisite();
    return JSON.stringify({
      backend: "gnome-mutter-workspace",
      sourceSha256: SOURCE_HASH,
      activeWorkspace: global.workspace_manager.get_active_workspace_index(),
      focusedWindow: global.display.focus_window?.get_stable_sequence() ?? null,
      leases: [...this.leases].map(([id, lease]) => ({
        id,
        workspace: lease.workspace.index(),
        pid: lease.pid,
        exited: lease.exited,
        released: lease.released,
        windows: [...lease.windows].map((window) => ({
          id: window.get_stable_sequence(),
          workspace: window.get_workspace()?.index() ?? null,
          transientFor: window.get_transient_for()?.get_stable_sequence() ?? null,
          pid: window.get_pid(),
        })),
      })),
    });
  }

  busy() {
    return this.leases
      .values()
      .reduce(
        (count, lease) =>
          count + Number(!lease.exited || lease.windows.size > 0 || populated(lease)),
        0,
      );
  }

  track(window: Meta.Window) {
    trackWindow(window, this.leases, (id, lease) => this.remove(id, lease));
  }

  launch(
    id: string,
    argv: string[],
    environment: Record<string, string>,
    cwd: string,
    invocation: Gio.DBusMethodInvocation,
    fds: number[] = [],
  ) {
    this.prerequisite();
    const prepared = prepareLaunch(
      id,
      this.leases.has(id),
      argv,
      environment,
      cwd,
      invocation,
      fds,
    );
    const manager = global.workspace_manager;
    let workspace: Lease["workspace"] | undefined;
    try {
      workspace = manager.append_new_workspace(false, global.get_current_time());
      prepared.launcher.setenv("FARSTEP_WORKSPACE_SERVICE", "org.gnome.Shell", true);
      prepared.launcher.setenv("FARSTEP_WORKSPACE_SOCKET", "inherited", true);
      const client = Meta.WaylandClient.new_subprocess(
        global.context,
        prepared.launcher,
        prepared.arguments,
      );
      const process = client.get_subprocess();
      const pid = Number(process.get_identifier());
      const lease: Lease = {
        id,
        owner: invocation.get_sender(),
        workspace,
        client,
        process,
        pid,
        unit: `omp-gui-${id}.scope`,
        ready: false,
        windows: new Set(),
        signals: new Map(),
        exited: false,
        status: 0,
        released: false,
        cgroup: null,
      };
      this.leases.set(id, lease);
      watchExit(lease, () => {
        if (lease.released && !this.disabled) this.remove(id, lease);
      });
      invocation.return_value(new GLib.Variant("(u)", [pid]));
    } catch (error) {
      if (
        workspace &&
        workspace.list_windows().length === 0 &&
        manager.get_active_workspace() !== workspace
      )
        manager.remove_workspace(workspace, global.get_current_time());
      throw error;
    } finally {
      prepared.launcher.close();
    }
  }

  owned(id: string, invocation: Gio.DBusMethodInvocation) {
    const lease = this.leases.get(id);
    if (!lease || lease.owner !== invocation.get_sender())
      throw new Error("Workspace lease is missing or belongs to another connection");
    return lease;
  }

  remove(id: string, lease: Lease) {
    if (!lease.exited || lease.windows.size !== 0 || populated(lease)) return false;
    const manager = global.workspace_manager;
    // Never delete the user's active workspace or one with unrelated windows
    if (manager.get_workspace_by_index(lease.workspace.index()) === lease.workspace) {
      if (
        lease.workspace.list_windows().length ||
        manager.get_active_workspace() === lease.workspace
      )
        return false;
      manager.remove_workspace(lease.workspace, global.get_current_time());
    }
    this.leases.delete(id);
    return true;
  }
}
