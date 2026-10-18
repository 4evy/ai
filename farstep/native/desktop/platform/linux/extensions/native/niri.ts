import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { NativeRouter, read, type Snapshot, SOURCE_HASH } from "./router";
import { marker, workspace } from "./rules";

interface Workspace {
  id: number;
  idx: number;
  name: string | null;
  output: string | null;
  is_active: boolean;
  is_focused: boolean;
}
interface Window {
  id: number;
  pid: number | null;
  app_id: string | null;
  workspace_id: number | null;
  is_focused: boolean;
}
function ipc(request: unknown): Record<string, unknown> {
  const path = GLib.getenv("NIRI_SOCKET");
  if (!path) throw new Error("niri IPC socket is missing");
  const connection = new Gio.SocketClient({ timeout: 5 }).connect(
    new Gio.UnixSocketAddress({ path }),
    null,
  );
  try {
    connection
      .get_output_stream()
      .write_all(new TextEncoder().encode(`${JSON.stringify(request)}\n`), null);
    const input = new Gio.DataInputStream({
      base_stream: connection.get_input_stream(),
    });
    const [line] = input.read_line_utf8(null);
    const response = JSON.parse(line ?? "null") as {
      Ok?: Record<string, unknown> | string;
      Err?: string;
    };
    if (response.Err || !response.Ok)
      throw new Error(`niri IPC failed: ${response.Err ?? "empty response"}`);
    return typeof response.Ok === "string" ? {} : response.Ok;
  } finally {
    connection.close(null);
  }
}
export class NiriRouter extends NativeRouter {
  constructor() {
    super("niri");
  }
  protected configured() {
    const path = this.verifyFile();
    const config =
      GLib.getenv("NIRI_CONFIG") ?? `${GLib.get_user_config_dir()}/niri/config.kdl`;
    const lines = read(config)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"));
    if (
      ![
        `include ${JSON.stringify(path)}`,
        `include ${JSON.stringify(path)} optional=true`,
      ].includes(lines.at(-1) ?? "")
    )
      throw new Error(
        `niri prerequisite: put include ${JSON.stringify(path)} last in ${config}`,
      );
    const workspaces = ipc("Workspaces").Workspaces as Workspace[];
    // niri removes this configured name if a reload drops our rules file
    if (!workspaces.some((w) => w.name === marker(SOURCE_HASH)))
      throw new Error("niri has not loaded this version of the workspace rules");
  }
  private workspaces() {
    return ipc("Workspaces").Workspaces as Workspace[];
  }
  protected override sameWorkspace(actual: string | null, expected: string): boolean {
    // niri resolves workspace names without regard to case
    return actual?.toLowerCase() === expected.toLowerCase();
  }
  protected snapshot(): Snapshot {
    const workspaces = this.workspaces();
    if (!workspaces.some((w) => w.is_focused && w.output))
      throw new Error("niri has no active output");
    const windows = ipc("Windows").Windows as Window[];
    return {
      windows: windows.map((w) => ({
        id: w.id,
        pid: w.pid,
        label: w.app_id,
        workspace: workspaces.find((ws) => ws.id === w.workspace_id)?.name ?? null,
      })),
      workspaces: workspaces.flatMap((w) => (w.name ? [w.name] : [])),
      visible: workspaces
        .filter((w) => w.is_active)
        .flatMap((w) => (w.name ? [w.name] : [])),
      activeWorkspace: workspaces.find((w) => w.is_focused)?.name ?? null,
      focusedWindow: windows.find((w) => w.is_focused)?.id ?? null,
    };
  }
  protected override reserve(slot: number, _state: Snapshot) {
    const workspaces = this.workspaces();
    const output = workspaces.find((w) => w.is_focused)?.output;
    const windows = ipc("Windows").Windows as Window[];
    const target = workspaces
      .filter((w) => w.output === output)
      .sort((a, b) => b.idx - a.idx)[0];
    if (
      !output ||
      !target ||
      target.name ||
      target.is_active ||
      windows.some((w) => w.workspace_id === target.id)
    )
      throw new Error(
        "niri needs an inactive empty trailing workspace on the focused output",
      );
    ipc({
      Action: {
        SetWorkspaceName: { name: workspace(slot), workspace: { Id: target.id } },
      },
    });
    // Action success also covers a missing target or a name already in use
    if (
      !this.workspaces().some((w) => w.id === target.id && w.name === workspace(slot))
    )
      throw new Error("niri did not reserve the requested workspace");
  }
  protected override remove(name: string) {
    const target = this.workspaces().find((w) => this.sameWorkspace(w.name, name));
    if (target) {
      ipc({ Action: { UnsetWorkspaceName: { reference: { Id: target.id } } } });
      if (
        this.workspaces().some(
          (w) => w.id === target.id && this.sameWorkspace(w.name, name),
        )
      )
        throw new Error("niri did not release the requested workspace");
    }
  }

  protected override attach(name: string) {
    // Missing open-on-workspace targets fall back to the user's active workspace
    const target = this.workspaces().find((w) => this.sameWorkspace(w.name, name));
    if (!target || target.is_active)
      throw new Error("niri workspace reservation is missing or visible");
  }
}
