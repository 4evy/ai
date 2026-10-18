import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { claimUpgradeOperation } from "../../../installer/shared";
import { verifyBrokerRuntime } from "../../../jobs/jobs";
import { atomicWrite, privateDirectory } from "../../../state";
import { activateDesktop, stopDesktop } from "../desktop/desktop";

import {
  assertIdle,
  assertOwned,
  installed,
  installerLock,
  locations,
  ownership,
  type Preparation,
} from "./state";
import { status } from "./status";

export async function prepareUpgrade() {
  const p = locations();
  await privateDirectory(p.state);
  await mkdir(p.lock, { mode: 0o700 });
  let pending: Preparation | undefined;
  try {
    await claimUpgradeOperation(p.lock);
    const record = await installed();
    if (!record) throw new Error("Helper is not installed; use install");
    await assertOwned(record);
    const checked = await ownership(record.current);
    if (!checked.owned) throw new Error(checked.error);
    await assertIdle();
    await stopDesktop();
    const preparation: Preparation = {
      version: 1,
      maintenanceToken: randomUUID(),
      original: record.current,
    };
    await atomicWrite(p.preparation, `${JSON.stringify(preparation)}\n`);
    pending = preparation;
    await rm(join(p.lock, "operation"), { recursive: true });
    return {
      status: "prepared",
      maintenanceToken: preparation.maintenanceToken,
      packagePath: record.current.packagePath,
      manager: "nix",
    };
  } catch (error) {
    if (pending) {
      await rm(join(p.lock, "operation"), { recursive: true, force: true });
      throw new Error(
        `Preparation failed; maintenance remains held, recover with token ${pending.maintenanceToken}`,
        { cause: error },
      );
    }
    await rm(p.lock, { recursive: true });
    throw error;
  }
}

export async function cancelUpgrade(token: string) {
  await installerLock(token, async (pending) => {
    const record = await installed();
    if (!record || !isDeepStrictEqual(record.current, pending?.original))
      throw new Error("Original activation no longer matches the pending upgrade");
    await assertOwned(record);
    const checked = await ownership(record.current);
    if (!checked.owned)
      throw new Error(
        `Restore the original Nix output before cancellation: ${checked.error}`,
      );
    await verifyBrokerRuntime();
    await activateDesktop(record.current.packagePath);
  });
  return status();
}
