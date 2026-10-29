import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@ai/values/error/error";
import { claimUpgradeOperation } from "#farstep/runtime/installer/shared";
import { atomicWrite, loadIdentity, privateDirectory } from "#farstep/runtime/state";
import { healthyDesktop } from "./activation";
import { assertIdle } from "./busy";
import { command } from "./command";
import { locations, UNIT } from "./locations";
import { assertOwned } from "./ownership";
import { packageOwnership } from "./packages";
import type { InstallationRecord, Preparation } from "./schemas";
import { installed, installerLock } from "./state";
import { status } from "./status";

// This gate survives the package transaction and the process that prepared it
// Failed activation keeps it closed until explicit retry, cancellation or removal
export async function prepareUpgrade() {
  const p = locations();
  await privateDirectory(p.state);
  await mkdir(p.lock, { mode: 0o700 });
  let preparation: Preparation | undefined;
  try {
    await claimUpgradeOperation(p.lock);
    const record = await installed();
    if (!record) throw new Error("Helper is not installed; use install");
    await assertOwned(record);
    const ownership = await packageOwnership(record.current);
    if (!ownership.owned) throw new Error(ownership.error);
    const identity = await loadIdentity();
    await assertIdle(identity.installationId);
    const pending: Preparation = {
      version: 1,
      maintenanceToken: randomUUID(),
      original: record.current,
      wasActive:
        (await command(["systemctl", "--user", "is-active", UNIT], true)).code === 0,
      wasEnabled:
        (await command(["systemctl", "--user", "is-enabled", UNIT], true)).code === 0,
    };
    await atomicWrite(p.preparation, `${JSON.stringify(pending)}\n`);
    preparation = pending;
    await command(["systemctl", "--user", "disable", "--now", UNIT]);
    await rm(join(p.lock, "operation"), { recursive: true });
    return {
      status: "prepared",
      maintenanceToken: preparation.maintenanceToken,
      packagePath: record.current.packagePath,
      manager: record.current.manager,
    };
  } catch (error) {
    if (preparation) {
      await rm(join(p.lock, "operation"), { recursive: true, force: true });
      throw new Error(
        `Preparation failed: ${errorMessage(error)}; maintenance remains held, recover with token ${preparation.maintenanceToken}`,
        { cause: error },
      );
    }
    await rm(p.lock, { recursive: true });
    throw error;
  }
}

function assertOriginalActivation(
  record: InstallationRecord | undefined,
  preparation: Preparation | undefined,
): asserts record is InstallationRecord {
  if (
    !record ||
    !preparation ||
    record.current.packagePath !== preparation.original.packagePath ||
    record.current.manager !== preparation.original.manager ||
    record.current.version !== preparation.original.version
  )
    throw new Error("Original activation no longer matches the pending upgrade");
}

export async function cancelUpgrade(maintenanceToken: string) {
  await installerLock(maintenanceToken, async (preparation) => {
    const record = await installed();
    if (!preparation)
      throw new Error("Original activation no longer matches the pending upgrade");
    assertOriginalActivation(record, preparation);
    await assertOwned(record);
    const ownership = await packageOwnership(record.current);
    if (!ownership.owned)
      throw new Error(
        `Cannot resume the original package: ${ownership.error}; reinstall it with its package manager or activate the replacement`,
      );
    try {
      if (preparation.wasEnabled)
        await command(["systemctl", "--user", "enable", UNIT]);
      if (preparation.wasActive) {
        await command(["systemctl", "--user", "start", UNIT]);
        const identity = await loadIdentity();
        await healthyDesktop(identity.installationId, record.current.version);
      }
    } catch (error) {
      await command(["systemctl", "--user", "disable", "--now", UNIT]);
      throw error;
    }
  });
  return status();
}
