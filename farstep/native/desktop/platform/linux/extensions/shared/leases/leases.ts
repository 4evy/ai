import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { prepareLaunch } from "../launcher";
import { populated, stop, watchExit } from "../processes";
import type { ProcessLease } from "../types";

export interface CompositorRouter {
  call(operation: string, request: { id: string; pid: number }): string;
  environment?: Record<string, string>;
  environmentForLease?(id: string): Record<string, string>;
}

export class ManagedLeases {
  readonly leases = new Map<string, ProcessLease>();
  constructor(
    private manager: Gio.DBusConnection,
    private router: CompositorRouter,
  ) {}

  compositor(operation: string, id = "", pid = 0) {
    return this.router.call(operation, { id, pid });
  }

  ready(lease: ProcessLease) {
    this.compositor("Attach", lease.id, lease.pid);
  }

  sweep() {
    const compositor = JSON.parse(this.compositor("Inspect")) as {
      leases: { id: string; released: boolean }[];
    };
    for (const item of compositor.leases)
      if (item.released && !this.leases.has(item.id))
        this.compositor("Release", item.id);
    for (const [id, lease] of this.leases) if (lease.released) this.remove(id, lease);
  }

  inspect() {
    const compositor = JSON.parse(this.compositor("Inspect")) as {
      leases: { id: string }[];
    };
    return JSON.stringify({
      ...compositor,
      leases: compositor.leases.map((item) => ({
        ...item,
        pid: this.leases.get(item.id)?.pid ?? null,
        exited: this.leases.get(item.id)?.exited ?? true,
      })),
    });
  }

  busy() {
    const compositor = JSON.parse(this.compositor("Inspect")) as {
      leases: { id: string; windows: unknown[] }[];
    };
    return compositor.leases.filter((item) => {
      const lease = this.leases.get(item.id);
      return item.windows.length || (lease && (!lease.exited || populated(lease)));
    }).length;
  }

  launch(
    id: string,
    argv: string[],
    environment: Record<string, string>,
    cwd: string,
    invocation: Gio.DBusMethodInvocation,
    fds: number[] = [],
  ) {
    if (
      !GLib.find_program_in_path("setsid") ||
      !GLib.find_program_in_path("dbus-run-session")
    )
      throw new Error("setsid and dbus-run-session are required");
    const prepared = prepareLaunch(
      id,
      this.leases.has(id),
      argv,
      environment,
      cwd,
      invocation,
      fds,
    );
    try {
      prepared.launcher.setenv(
        "FARSTEP_WORKSPACE_SERVICE",
        "org.farstep.Workspaces",
        true,
      );
      prepared.launcher.setenv("FARSTEP_WORKSPACE_SOCKET", "display", true);
      for (const [key, value] of Object.entries(this.router.environment ?? {}))
        prepared.launcher.setenv(key, value, true);
      this.compositor("Reserve", id);
      try {
        for (const [key, value] of Object.entries(
          this.router.environmentForLease?.(id) ?? {},
        ))
          prepared.launcher.setenv(key, value, true);
        const process = prepared.launcher.spawnv(prepared.arguments);
        const pid = Number(process.get_identifier());
        const lease: ProcessLease = {
          id,
          pid,
          owner: invocation.get_sender(),
          process,
          unit: `omp-gui-${id}.scope`,
          ready: false,
          exited: false,
          status: 0,
          released: false,
          cgroup: null,
        };
        this.leases.set(id, lease);
        watchExit(lease, () => {
          if (lease.released) this.remove(id, lease);
        });
        invocation.return_value(new GLib.Variant("(u)", [pid]));
      } catch (error) {
        this.compositor("Release", id);
        throw error;
      }
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

  stop(lease: ProcessLease) {
    stop(this.manager, lease);
  }

  private removeSocket(id: string): void {
    if (this.router.environment?.FARSTEP_WORKSPACE_SOCKET === "proxy") {
      // SIGKILL bypasses the proxy's normal socket cleanup
      const directory = Gio.File.new_for_path(
        `${GLib.get_user_runtime_dir()}/farstep/workspaces/${id}`,
      );
      try {
        if (!directory.query_exists(null)) return;
        {
          const info = directory.query_info(
            "standard::type,unix::uid,unix::mode",
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null,
          );
          if (
            info.get_file_type() !== Gio.FileType.DIRECTORY ||
            info.get_attribute_uint32("unix::uid") !==
              new Gio.Credentials().get_unix_user() ||
            (info.get_attribute_uint32("unix::mode") & 0o077) !== 0
          )
            return;
          {
            const socket = directory.get_child("wayland");
            if (socket.query_exists(null)) {
              const socketInfo = socket.query_info(
                "unix::uid,unix::mode",
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null,
              );
              if (
                socketInfo.get_attribute_uint32("unix::uid") ===
                  new Gio.Credentials().get_unix_user() &&
                (socketInfo.get_attribute_uint32("unix::mode") & 0o170000) === 0o140000
              )
                socket.delete(null);
            }
            directory.delete(null);
          }
        }
      } catch (error) {
        console.warn(`Workspace socket cleanup deferred: ${String(error)}`);
      }
    }
  }

  remove(id: string, lease: ProcessLease) {
    if (!lease.exited || populated(lease)) return false;
    if (this.compositor("Release", id) !== "true") return false;
    this.removeSocket(id);
    this.leases.delete(id);
    return true;
  }
}
