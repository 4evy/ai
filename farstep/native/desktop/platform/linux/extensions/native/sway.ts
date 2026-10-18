import Gio from "gi://Gio";
import GLib from "gi://GLib";
import {
  command,
  NativeRouter,
  read,
  type Snapshot,
  SOURCE_HASH,
  type Window,
} from "./router";

interface Node {
  id: number;
  type: string;
  name: string;
  app_id: string | null;
  pid: number | null;
  focused: boolean;
  nodes: Node[];
  floating_nodes: Node[];
}
function ipc(type: string, payload = ""): unknown {
  const result: unknown = JSON.parse(
    command(["swaymsg", "--raw", "--type", type, "--", payload]),
  );
  if (
    type === "command" &&
    (!Array.isArray(result) || result.some((item) => item.success !== true))
  )
    throw new Error(`Sway rejected workspace routing: ${JSON.stringify(result)}`);
  return result;
}
export class SwayRouter extends NativeRouter {
  constructor() {
    super("sway");
    if (!GLib.getenv("SWAYSOCK")) throw new Error("Sway IPC socket is missing");
  }
  protected configured() {
    const path = this.verifyFile();
    const config = (ipc("get_config") as { config: string }).config;
    const first = config
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));
    if (first !== `include ${JSON.stringify(path)}`)
      throw new Error(
        `Sway prerequisite: put include ${JSON.stringify(path)} first in your Sway config`,
      );
    const markerPath = `${GLib.get_user_runtime_dir()}/farstep/sway-routing.json`;
    const file = Gio.File.new_for_path(markerPath);
    if (!file.query_exists(null))
      throw new Error(
        "Sway has not loaded the workspace rules; reload your compositor config",
      );
    const info = file.query_info(
      "standard::type,standard::size,unix::uid,unix::mode",
      Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
      null,
    );
    if (
      info.get_file_type() !== Gio.FileType.REGULAR ||
      info.get_size() > 4096 ||
      info.get_attribute_uint32("unix::uid") !==
        new Gio.Credentials().get_unix_user() ||
      (info.get_attribute_uint32("unix::mode") & 0o077) !== 0
    )
      throw new Error("Sway routing acknowledgement is not private and owned");
    const marker = JSON.parse(read(markerPath)) as {
      hash: string;
      socket: string;
      pid: number;
      startTime: string;
    };
    const socket = GLib.getenv("SWAYSOCK");
    if (!socket) throw new Error("Sway IPC socket is missing");
    const connection = new Gio.SocketClient({ timeout: 5 }).connect(
      new Gio.UnixSocketAddress({ path: socket }),
      null,
    );
    try {
      if (connection.get_socket().get_credentials().get_unix_pid() !== marker.pid)
        throw new Error(
          "Sway routing acknowledgement belongs to a previous compositor",
        );
    } finally {
      connection.close(null);
    }
    const stat = read(`/proc/${marker.pid}/stat`).split(") ")[1]?.split(" ")[19];
    if (
      marker.hash !== SOURCE_HASH ||
      marker.socket !== GLib.getenv("SWAYSOCK") ||
      marker.startTime !== stat
    )
      throw new Error(
        "Sway has not loaded this version of the workspace rules; reload your compositor config",
      );
  }
  protected snapshot(): Snapshot {
    const windows: Window[] = [];
    const names: string[] = [];
    let focusedWindow: number | null = null;
    const visit = (node: Node, workspace?: string) => {
      if (node.type === "workspace") {
        workspace = node.name;
        names.push(node.name);
      }
      if (workspace && node.type === "con" && (node.app_id || node.pid)) {
        if (node.focused) focusedWindow = node.id;
        windows.push({ id: node.id, pid: node.pid, label: node.app_id, workspace });
      }
      for (const child of [...node.nodes, ...node.floating_nodes])
        visit(child, workspace);
    };
    visit(ipc("get_tree") as Node);
    const workspaces = ipc("get_workspaces") as {
      name: string;
      focused: boolean;
      visible: boolean;
    }[];
    if (!workspaces.some((w) => w.visible))
      throw new Error("Sway has no active output");
    return {
      windows,
      workspaces: names,
      visible: workspaces.filter((w) => w.visible).map((w) => w.name),
      activeWorkspace: workspaces.find((w) => w.focused)?.name ?? null,
      focusedWindow,
    };
  }
  protected override attach(workspace: string) {
    if (this.nested) ipc("command", `workspace ${JSON.stringify(workspace)}`);
  }
  protected override remove(workspace: string) {
    if (this.nested && this.snapshot().visible.includes(workspace))
      ipc("command", 'workspace "Farstep home"');
  }
}
