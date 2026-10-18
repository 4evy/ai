import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { ManagedLeases } from "../shared/leases/leases";

export class WorkspaceLeases extends ManagedLeases {
  constructor(manager: Gio.DBusConnection) {
    super(manager, {
      call(operation, request) {
        const result = Gio.DBus.session.call_sync(
          "org.kde.KWin",
          "/org/farstep/Compositor",
          "org.farstep.Compositor1",
          "Call",
          new GLib.Variant("(ss)", [operation, JSON.stringify(request)]),
          new GLib.VariantType("(s)"),
          Gio.DBusCallFlags.NONE,
          5000,
          null,
        );
        return (result.deep_unpack() as [string])[0];
      },
    });
  }
}
