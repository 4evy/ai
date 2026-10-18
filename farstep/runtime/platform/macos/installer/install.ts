import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { quotePosixArgument as quote } from "@ai/core/shell/shell";
import type * as v from "valibot";
import { verifyBrokerRuntime } from "../../../jobs/jobs";
import { atomicWrite, loadIdentity, privateDirectory } from "../../../state";
import { disableSystem, enableSystem, systemExec } from "../../../system/system";
import { activateDesktop, removeDesktop, requestPermissions } from "../desktop/desktop";
import { artifact, retain } from "../package/package";

import {
  assertIdle,
  assertOwned,
  installed,
  installerLock,
  locations,
  type Preparation,
  type recordSchema,
} from "./state";
import { status } from "./status";

function assertInstallAction(
  action: "install" | "upgrade",
  old: v.InferOutput<typeof recordSchema> | undefined,
  pending: Preparation | undefined,
): void {
  if (action === "install" && old)
    throw new Error("Helper is already installed; use upgrade");
  if (action === "upgrade" && !old)
    throw new Error("Helper is not installed; use install");
  if (pending && !isDeepStrictEqual(old?.current, pending.original))
    throw new Error("Original activation no longer matches the pending upgrade");
}

export async function install(
  action: "install" | "upgrade",
  packagePath: string,
  waylandDisplay?: string,
  token?: string,
) {
  if (waylandDisplay)
    throw new Error("Wayland desktop activation is unavailable on macOS");
  await loadIdentity();
  await installerLock(token, async (pending) => {
    const p = locations();
    await privateDirectory(p.data);
    const old = await installed();
    assertInstallAction(action, old, pending);
    await assertOwned(old);
    await assertIdle();
    const current = await artifact(packagePath);
    await verifyBrokerRuntime();
    const previous =
      old && old.current.packagePath !== current.packagePath
        ? old.current
        : old?.previous;
    const rollback = async () => {
      if (old) await retain(p.current, old.current.packagePath);
      else await rm(p.current, { force: true });
      if (old?.previous) await retain(p.previous, old.previous.packagePath);
      else await rm(p.previous, { force: true });
      if (old) await atomicWrite(p.record, `${JSON.stringify(old)}\n`);
      else await rm(p.record, { force: true });
      if (old) await activateDesktop(old.current.packagePath, current.packagePath);
      else await removeDesktop(current.packagePath);
    };
    try {
      await retain(p.current, current.packagePath);
      if (previous) await retain(p.previous, previous.packagePath);
      else await rm(p.previous, { force: true });
      await atomicWrite(
        p.record,
        `${JSON.stringify({ version: 1, current, ...(previous ? { previous } : {}) })}\n`,
      );
      await activateDesktop(current.packagePath, old?.current.packagePath);
    } catch (error) {
      await rollback();
      throw error;
    }
  });
  await enableSystem();
  const executable = join(packagePath, "share/Farstep.app/Contents/MacOS/Farstep");
  const firewall = await systemExec({
    command: [executable, join(packagePath, "bin/bun")]
      .map(
        (path) =>
          `/usr/libexec/ApplicationFirewall/socketfilterfw --add ${quote(path)} && /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp ${quote(path)}`,
      )
      .join(" && "),
    cwd: "/",
    timeout: 60,
  });
  if (firewall.exitCode !== 0)
    throw new Error(`Farstep firewall setup failed: ${firewall.stderr}`);
  if (action === "install") await requestPermissions(packagePath);
  return status();
}

export async function uninstall(token?: string) {
  return installerLock(token, async () => {
    const record = await installed();
    if (!record) return { installed: false, status: "not-installed" };
    await assertOwned(record);
    await assertIdle();
    await disableSystem();
    await removeDesktop(record.current.packagePath);
    const p = locations();
    for (const path of [p.current, p.previous, p.record])
      await rm(path, { force: true });
    return { installed: false, status: "uninstalled", historyRetained: true };
  });
}
