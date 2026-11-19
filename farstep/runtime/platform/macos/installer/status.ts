import { join } from "node:path";
import { errorMessage } from "@ai/values/error/error";
import { uuidSchema } from "farstep/protocol/identity";
import type { ScriptRunner } from "farstep/protocol/jobs/gateway";
import * as v from "valibot";
import { darwinSystemPackage } from "../../../../installation";
import { desktopHealth } from "../../../desktop";
import { verifyBrokerRuntime } from "../../../jobs/jobs";
import { verifyScriptRunner } from "../../../jobs/script/runner";
import {
  exists,
  loadIdentity,
  PROTOCOL_MAJOR,
  paths,
  privateRead,
} from "../../../state";
import { artifact } from "../package/package";

import { assertOwned, installed, locations, ownership, prepared } from "./state";

const identitySchema = v.strictObject({ installationId: uuidSchema });

export async function status() {
  const system = await darwinSystemPackage();
  const managed = system !== undefined && process.env.FARSTEP_PACKAGE_PATH === system;
  const record = managed ? undefined : await installed();
  const current = managed ? await artifact(system) : record?.current;
  const pending = await prepared();
  const maintenance = await exists(locations().lock);
  if (!current)
    return {
      installed: false,
      jobsReady: false,
      status: maintenance ? "maintenance" : "not-installed",
      platform: "darwin",
      ...(pending ? { maintenanceToken: pending.maintenanceToken } : {}),
    };
  if (!managed) await assertOwned(record);
  const identity = managed
    ? await loadIdentity()
    : v.parse(
        identitySchema,
        JSON.parse(await privateRead(join(paths().state, "installation.json"))),
      );
  const packageOwnership = managed
    ? { manager: "nix", owned: true }
    : await ownership(current);
  const inspectDesktop = async () => {
    let desktop: unknown = null;
    let desktopError: string | undefined;
    if (packageOwnership.owned && !maintenance) {
      try {
        desktop = await desktopHealth(identity.installationId, current.version);
      } catch (error) {
        desktopError = errorMessage(error);
      }
    }
    return { desktop, desktopError };
  };
  const { desktop, desktopError } = await inspectDesktop();
  if (packageOwnership.owned && !maintenance) await verifyBrokerRuntime();
  let scriptRunner: ScriptRunner | undefined;
  let scriptRunnerError: string | undefined;
  if (packageOwnership.owned && !maintenance) {
    try {
      scriptRunner = await verifyScriptRunner(current.packagePath);
    } catch (error) {
      scriptRunnerError = errorMessage(error);
    }
  }
  return {
    installed: true,
    jobsReady: packageOwnership.owned && !maintenance && scriptRunner !== undefined,
    ...(scriptRunner ? { scriptRunner } : {}),
    ...(scriptRunnerError ? { scriptRunnerError } : {}),
    protocolMajor: PROTOCOL_MAJOR,
    platform: "darwin",
    ...identity,
    version: current.version,
    packagePath: current.packagePath,
    manager: managed ? "nix-darwin" : current.manager,
    packageOwnership,
    previous: record?.previous
      ? { ...record.previous, packageOwnership: await ownership(record.previous) }
      : null,
    status: maintenance
      ? "maintenance"
      : packageOwnership.owned
        ? scriptRunnerError
          ? "script-api-incompatible"
          : "ready"
        : "package-unavailable",
    desktop,
    ...(desktopError ? { desktopError } : {}),
    ...(pending ? { maintenanceToken: pending.maintenanceToken } : {}),
  };
}
