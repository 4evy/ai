import { join } from "node:path";
import { errorMessage } from "@ai/values/error/error";
import { uuidSchema } from "farstep/protocol/identity";
import type { ScriptRunner } from "farstep/protocol/jobs/gateway";
import * as v from "valibot";
import { desktopHealth } from "#farstep/runtime/desktop";
import { verifyBrokerRuntime } from "#farstep/runtime/jobs/jobs";
import { verifyScriptRunner } from "#farstep/runtime/jobs/script/runner";
import { exists, PROTOCOL_MAJOR, paths, privateRead } from "#farstep/runtime/state";
import { command } from "./command";
import { locations, UNIT } from "./locations";
import { assertOwned } from "./ownership";
import { packageOwnership } from "./packages";
import { installed, prepared } from "./state";
import { workspaceIsolation } from "./workspace/workspace";

const identitySchema = v.strictObject({ installationId: uuidSchema });
function installationStatus(maintenance: boolean, owned: boolean, active: boolean) {
  if (maintenance) return "maintenance";
  if (!owned) return "package-unavailable";
  return active ? "ready" : "jobs-ready-desktop-awaiting-session";
}

export async function status() {
  const record = await installed();
  const preparation = await prepared();
  if (!record)
    return {
      installed: false,
      jobsReady: false,
      status: preparation ? "maintenance" : "not-installed",
      ...(preparation ? { maintenanceToken: preparation.maintenanceToken } : {}),
    };
  await assertOwned(record);
  const identity = v.parse(
    identitySchema,
    JSON.parse(await privateRead(join(paths().state, "installation.json"))),
  );
  const ownership = await packageOwnership(record.current);
  const maintenance = await exists(locations().lock);
  if (ownership.owned && !maintenance) await verifyBrokerRuntime();
  let scriptRunner: ScriptRunner | undefined;
  let scriptRunnerError: string | undefined;
  if (ownership.owned && !maintenance) {
    try {
      scriptRunner = await verifyScriptRunner(record.current.packagePath);
    } catch (error) {
      scriptRunnerError = errorMessage(error);
    }
  }
  const active =
    (await command(["systemctl", "--user", "is-active", UNIT], true)).code === 0;
  return {
    installed: true,
    jobsReady: ownership.owned && !maintenance && scriptRunner !== undefined,
    ...(scriptRunner ? { scriptRunner } : {}),
    ...(scriptRunnerError ? { scriptRunnerError } : {}),
    protocolMajor: PROTOCOL_MAJOR,
    version: record.current.version,
    ...identity,
    packagePath: record.current.packagePath,
    manager: record.current.manager,
    packageOwnership: ownership,
    workspaceIsolation: await workspaceIsolation(record.current.packagePath),
    previous: record.previous
      ? {
          ...record.previous,
          packageOwnership: await packageOwnership(record.previous),
        }
      : null,
    ...(preparation ? { maintenanceToken: preparation.maintenanceToken } : {}),
    status: scriptRunnerError
      ? "script-api-incompatible"
      : installationStatus(maintenance, ownership.owned, active),
    desktop:
      active && ownership.owned && !maintenance
        ? await desktopHealth(identity.installationId, record.current.version)
        : null,
  };
}
