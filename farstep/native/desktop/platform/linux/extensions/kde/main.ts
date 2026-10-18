import { SOURCE_HASH } from "../shared/protocol/protocol";
import type { Bridge, Desktop, Window, Workspace } from "./types";

interface Lease {
  id: string;
  desktop: Desktop;
  activity: string;
  windows: Map<Window, () => void>;
  released: boolean;
}

type Request = { id: string; pid: number };
const ASSIGNMENT_SIGNALS = [
  "desktopsChanged",
  "activitiesChanged",
  "transientChanged",
] as const;

class WorkspaceRouter {
  private readonly leases = new Map<string, Lease>();
  private readonly pending = new Map<Window, () => void>();
  private repairing = false;
  private readonly operations = new Map<string, (request: Request) => string>([
    ["Inspect", () => this.inspect()],
    ["Reserve", (request) => this.reserve(request.id)],
    ["Attach", (request) => this.attach(request)],
    ["Release", (request) => this.releaseLease(request.id)],
  ]);

  constructor(
    private readonly workspace: Workspace,
    private readonly bridge: Bridge,
  ) {
    if (!bridge.available) throw new Error("KWin Wayland bridge is unavailable");
    bridge.windowCreated.connect((window) => this.track(window));
    bridge.windowMapped.connect((window) => this.restore(window));
    bridge.ownerLost.connect(() => {
      for (const lease of this.leases.values()) lease.released = true;
    });
    workspace.desktopsChanged.connect(() => this.repair());
    bridge.handler = (operation, payload) => this.call(operation, payload);
  }

  private createDesktop(id: string): Desktop {
    const previous = this.workspace.desktops.map((desktop) => desktop.id);
    this.workspace.createDesktop(
      this.workspace.desktops.length,
      `Farstep ${id.slice(0, 8)}`,
    );
    const desktop = this.workspace.desktops.find((item) => !previous.includes(item.id));
    if (!desktop) throw new Error("KWin could not reserve a virtual desktop");
    return desktop;
  }

  private assign(window: Window, lease: Lease): void {
    if (window.desktops.length !== 1 || window.desktops[0]?.id !== lease.desktop.id)
      window.desktops = [lease.desktop];
    if (
      lease.activity &&
      (window.activities.length !== 1 || window.activities[0] !== lease.activity)
    )
      window.activities = [lease.activity];
  }

  private hold(window: Window): void {
    // Keep the window minimized until KWin skips its initial activation,
    // then restore it in the same compositor turn before the first frame
    if (window.minimizable && !window.popupWindow) {
      const minimized = window.minimized;
      const hold = () => {
        if (!window.minimized) window.minimized = true;
      };
      window.minimizedChanged.connect(hold);
      hold();
      this.pending.set(window, () => {
        window.minimizedChanged.disconnect(hold);
        window.minimized = minimized;
      });
    }
  }

  private restore(window: Window): void {
    this.pending.get(window)?.();
    this.pending.delete(window);
  }

  private track(window: Window): void {
    const unit = this.bridge.scope(window.pid);
    const lease = [...this.leases.values()].find(
      (item) =>
        unit === `omp-gui-${item.id}.scope` ||
        (window.transientFor !== null && item.windows.has(window.transientFor)),
    );
    if (!lease || lease.windows.has(window)) return;
    const assign = () => this.assign(window, lease);
    this.hold(window);
    lease.windows.set(window, assign);
    for (const signal of ASSIGNMENT_SIGNALS) window[signal].connect(assign);
    window.closed.connect(() => {
      for (const signal of ASSIGNMENT_SIGNALS) window[signal].disconnect(assign);
      this.restore(window);
      lease.windows.delete(window);
    });
    assign();
  }

  private repair(): void {
    if (this.repairing) return;
    this.repairing = true;
    try {
      for (const lease of this.leases.values()) {
        if (this.workspace.desktops.some((desktop) => desktop.id === lease.desktop.id))
          continue;
        lease.desktop = this.createDesktop(lease.id);
        for (const assign of lease.windows.values()) assign();
      }
    } finally {
      this.repairing = false;
    }
  }

  private releaseLease(id: string): string {
    const lease = this.leases.get(id);
    if (!lease) return "true";
    lease.released = true;
    if (
      lease.windows.size ||
      this.bridge.populated(lease.id) ||
      this.workspace.currentDesktop.id === lease.desktop.id ||
      Array.from(this.workspace.windows).some(
        (window) =>
          window.desktops.length === 0 ||
          window.desktops.some((desktop) => desktop.id === lease.desktop.id),
      )
    )
      return "false";
    // Remove the lease first so desktopsChanged cannot recreate it
    this.leases.delete(id);
    this.workspace.removeDesktop(lease.desktop);
    this.bridge.forget(id);
    return "true";
  }

  private inspect(): string {
    return JSON.stringify({
      backend: "kde-kwin-workspace",
      sourceSha256: SOURCE_HASH,
      activeWorkspace: this.workspace.currentDesktop.x11DesktopNumber - 1,
      focusedWindow: this.workspace.activeWindow?.internalId ?? null,
      leases: [...this.leases.values()].map((lease) => ({
        id: lease.id,
        workspace: lease.desktop.x11DesktopNumber - 1,
        released: lease.released,
        windows: [...lease.windows.keys()].map((window) => ({
          id: window.internalId,
          pid: window.pid,
          minimized: window.minimized,
          workspace: window.desktops[0]
            ? window.desktops[0].x11DesktopNumber - 1
            : null,
          transientFor: window.transientFor?.internalId ?? null,
        })),
      })),
    });
  }

  private reserve(id: string): string {
    if (this.leases.has(id)) throw new Error("Reused workspace lease");
    const desktop = this.createDesktop(id);
    this.bridge.retain(id);
    this.leases.set(id, {
      id,
      desktop,
      activity: this.workspace.currentActivity,
      windows: new Map(),
      released: false,
    });
    return JSON.stringify({ desktop: desktop.id });
  }

  private attach(request: Request): string {
    if (!this.leases.has(request.id) || !this.bridge.attach(request.id, request.pid))
      throw new Error("KWin could not verify the launch process scope");
    return "true";
  }

  private call(operation: string, payload: string): string {
    const request = JSON.parse(payload) as Request;
    const handle = this.operations.get(operation);
    if (!handle) throw new Error(`Unknown compositor operation: ${operation}`);
    return handle(request);
  }

  shutdown(): void {
    for (const lease of this.leases.values()) this.bridge.stop(lease.id);
  }
}

export function createRouter(workspace: Workspace, bridge: Bridge) {
  const router = new WorkspaceRouter(workspace, bridge);
  return { shutdown: () => router.shutdown() };
}
