import Gio from "gi://Gio";
import GLib from "gi://GLib";
import type { ManagedLeases } from "./leases/leases";
import { PATH, XML } from "./protocol/protocol";
import { WorkspaceService } from "./service";

type SignalAdd = (
  priority: number,
  signal: number,
  callback: GLib.SourceFunc,
) => number;

const MISSING_OWNER_ERRORS = new Set([
  "org.freedesktop.DBus.ServiceUnknown",
  "org.freedesktop.DBus.NameHasNoOwner",
  "org.freedesktop.DBus.UnknownObject",
]);

async function loadSignalAdd(): Promise<SignalAdd> {
  try {
    return (await import("gi://GLibUnix")).default.signal_add;
  } catch {
    return (GLib as typeof GLib & { unix_signal_add: SignalAdd }).unix_signal_add;
  }
}

function parentStat(parent: string | null): string | null {
  if (!parent || !/^[1-9][0-9]*$/.test(parent)) return null;
  try {
    const [, bytes] = GLib.file_get_contents(`/proc/${parent}/stat`);
    return new TextDecoder().decode(bytes).split(") ")[1]?.split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

class WorkspaceBroker {
  private readonly parent = GLib.getenv("FARSTEP_BROKER_PARENT");
  private readonly parentStart = parentStat(this.parent);
  private readonly service: Gio.DBusExportedObject;
  private readonly loop: GLib.MainLoop;
  private shuttingDown = false;
  private sweepError = "";

  constructor(
    private readonly leases: ManagedLeases,
    private readonly compositorName: string | undefined,
    private readonly stopOnSweepError: boolean,
  ) {
    this.service = Gio.DBusExportedObject.wrapJSObject(
      XML,
      new WorkspaceService(leases),
    );
    this.loop = new GLib.MainLoop(null, false);
  }

  private removeReleased(deadline: number): boolean {
    for (const [id, lease] of this.leases.leases) {
      try {
        this.leases.remove(id, lease);
      } catch {
        // A vanished compositor cannot acknowledge workspace removal
      }
    }
    if (!this.leases.leases.size || GLib.get_monotonic_time() >= deadline) {
      this.loop.quit();
      return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
  }

  private readonly shutdown = (): boolean => {
    if (this.shuttingDown) return GLib.SOURCE_REMOVE;
    this.shuttingDown = true;
    for (const lease of this.leases.leases.values()) {
      lease.released = true;
      this.leases.stop(lease);
    }
    this.service.unexport();
    if (!this.leases.leases.size) this.loop.quit();
    else {
      const deadline = GLib.get_monotonic_time() + 2_000_000;
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => this.removeReleased(deadline));
    }
    return GLib.SOURCE_REMOVE;
  };

  private ownerChanged(name: string, newOwner: string): void {
    if (name === this.compositorName && !newOwner) this.shutdown();
    if (!newOwner)
      for (const lease of this.leases.leases.values()) {
        if (lease.owner !== name) continue;
        this.leases.stop(lease);
        lease.released = true;
      }
  }

  private reportSweepError(error: unknown): void {
    const remote =
      error instanceof GLib.Error ? Gio.DBusError.get_remote_error(error) : null;
    if (!MISSING_OWNER_ERRORS.has(remote ?? "")) {
      const message = String(error);
      if (message !== this.sweepError) console.error(message);
      this.sweepError = message;
    }
  }

  private readonly sweep = (): boolean => {
    if (this.shuttingDown) return GLib.SOURCE_REMOVE;
    if (
      this.parent &&
      (!this.parentStart || parentStat(this.parent) !== this.parentStart)
    )
      return this.shutdown();
    try {
      this.leases.sweep();
      this.sweepError = "";
    } catch (error) {
      if (this.stopOnSweepError && this.leases.leases.size) return this.shutdown();
      this.reportSweepError(error);
    }
    return GLib.SOURCE_CONTINUE;
  };

  run(signalAdd: SignalAdd, manager: Gio.DBusConnection): void {
    const owner = Gio.bus_own_name(
      Gio.BusType.SESSION,
      "org.farstep.Workspaces",
      Gio.BusNameOwnerFlags.NONE,
      (connection) => this.service.export(connection, PATH),
      null,
      this.shutdown,
    );
    const watch = Gio.DBus.session.signal_subscribe(
      "org.freedesktop.DBus",
      "org.freedesktop.DBus",
      "NameOwnerChanged",
      "/org/freedesktop/DBus",
      null,
      Gio.DBusSignalFlags.NONE,
      (_bus, _sender, _path, _iface, _signal, parameters) => {
        const [name, , newOwner] = parameters.deep_unpack() as [string, string, string];
        this.ownerChanged(name, newOwner);
      },
    );
    const sweep = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, this.sweep);
    const signals = [2, 15].map((signal) =>
      signalAdd(GLib.PRIORITY_DEFAULT, signal, this.shutdown),
    );
    this.loop.run();
    for (const source of [...signals, sweep])
      if (GLib.MainContext.default().find_source_by_id(source))
        GLib.source_remove(source);
    Gio.DBus.session.signal_unsubscribe(watch);
    Gio.bus_unown_name(owner);
    manager.close_sync(null);
  }
}

export async function runBroker(
  createLeases: (manager: Gio.DBusConnection) => ManagedLeases,
  compositorName?: string,
  stopOnSweepError = false,
) {
  const signalAdd = await loadSignalAdd();
  const uid = new Gio.Credentials().get_unix_user();
  const manager = Gio.DBusConnection.new_for_address_sync(
    `unix:path=/run/user/${uid}/bus`,
    Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
      Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
    null,
    null,
  );
  const leases = createLeases(manager);
  new WorkspaceBroker(leases, compositorName, stopOnSweepError).run(signalAdd, manager);
}
