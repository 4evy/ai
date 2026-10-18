import { join } from "node:path";
import * as v from "valibot";
import { desktopHealth } from "#farstep/runtime/desktop";
import { inspectBusyJobs } from "#farstep/runtime/jobs/jobs";
import { exists, paths } from "#farstep/runtime/state";
import { command } from "./command";
import { UNIT } from "./locations";

import { installed } from "./state";

const workspaceBusySchema = v.object({
  data: v.strictTuple([v.pipe(v.number(), v.safeInteger(), v.minValue(0))]),
});
async function assertPrivateDesktopIdle(): Promise<void> {
  if (await exists(join(paths().runtime, "nested.json"))) {
    const record = await installed();
    if (!record) throw new Error("Private desktop has no owned installation record");
    const privateBusy = await command([
      join(record.current.packagePath, "bin/farstep-desktop"),
      "workspace",
      "busy",
    ]);
    if (
      v.parse(
        v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
        Number(privateBusy.stdout.trim()),
      ) !== 0
    )
      throw new Error(
        "Private desktop has live GUI workspace leases; release them before upgrade or uninstall",
      );
  }
}

async function assertWorkspaceIdle(): Promise<void> {
  await assertPrivateDesktopIdle();
  for (const service of ["org.gnome.Shell", "org.farstep.Workspaces"]) {
    const workspaces = await command(
      [
        "busctl",
        "--user",
        "--json=short",
        "call",
        service,
        "/org/farstep/Workspaces",
        "org.farstep.Workspaces1",
        "Busy",
      ],
      true,
    );
    if (workspaces.code === 0) {
      const busy = v.parse(workspaceBusySchema, JSON.parse(workspaces.stdout));
      if (busy.data[0] !== 0)
        throw new Error(
          "Helper has live GUI workspace leases; release them before upgrade or uninstall",
        );
    }
  }
}

export async function assertIdle(installationId: string): Promise<void> {
  await assertWorkspaceIdle();
  if (await inspectBusyJobs())
    throw new Error(
      "Helper has live managed jobs; stop them explicitly before upgrade or uninstall",
    );
  const active =
    (await command(["systemctl", "--user", "is-active", UNIT], true)).code === 0;
  if (active || (await exists(join(paths().runtime, "desktop.sock")))) {
    const health = await desktopHealth(installationId);
    if (health.controlLeaseActive || health.sessions !== 0)
      throw new Error(
        "Desktop sessions are active; release them explicitly before upgrade or uninstall",
      );
  }
}
