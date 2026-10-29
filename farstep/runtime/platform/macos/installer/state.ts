import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { errorMessage } from "@ai/values/error/error";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { uuidSchema } from "farstep/protocol/identity";
import * as v from "valibot";
import { desktopHealth } from "../../../desktop";
import { createInstallerLock } from "../../../installer/shared";
import { inspectBusyJobs } from "../../../jobs/jobs";
import {
  exists,
  loadIdentity,
  paths,
  privateDirectory,
  privateRead,
} from "../../../state";
import { artifact, type Generation, generationSchema } from "../package/package";

export const recordSchema = v.strictObject({
  version: v.literal(1),
  current: generationSchema,
  previous: v.optional(generationSchema),
});
export const preparationSchema = v.strictObject({
  version: v.literal(1),
  maintenanceToken: uuidSchema,
  original: generationSchema,
});
export type Preparation = v.InferOutput<typeof preparationSchema>;

export function locations() {
  const p = paths();
  return {
    ...p,
    record: join(p.state, "installer.json"),
    current: join(p.data, "current"),
    previous: join(p.data, "previous"),
    lock: join(p.state, "maintenance.lock"),
    preparation: join(p.state, "maintenance.lock/preparation.json"),
  };
}

export async function installed() {
  try {
    return v.parse(recordSchema, JSON.parse(await privateRead(locations().record)));
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return undefined;
  }
}

export async function ownership(generation: Generation) {
  try {
    if (!isDeepStrictEqual(await artifact(generation.packagePath), generation))
      throw new Error("Recorded Nix generation no longer matches its payload");
    return { manager: "nix", owned: true };
  } catch (error) {
    return {
      manager: "nix",
      owned: false,
      error: errorMessage(error),
    };
  }
}

export async function assertOwned(
  record: v.InferOutput<typeof recordSchema> | undefined,
): Promise<void> {
  const p = locations();
  for (const [path, generation] of [
    [p.current, record?.current],
    [p.previous, record?.previous],
  ] as const) {
    if (await exists(path)) {
      const info = await lstat(path);
      if (
        !generation ||
        !info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (await readlink(path)) !== generation.packagePath
      )
        throw new Error(`Refusing unrelated installation link: ${path}`);
    } else if (generation)
      throw new Error(`Owned installation link is missing: ${path}`);
  }
}

export async function prepared(): Promise<Preparation | undefined> {
  const p = locations();
  if (!(await exists(p.preparation))) return undefined;
  await privateDirectory(p.lock);
  return v.parse(preparationSchema, JSON.parse(await privateRead(p.preparation)));
}

export const installerLock = createInstallerLock(prepared);

export async function assertIdle(): Promise<void> {
  if (await inspectBusyJobs())
    throw new Error("Helper has running jobs; stop them before package maintenance");
  const record = await installed();
  if (record && !(await prepared())) {
    const identity = await loadIdentity();
    const health = await desktopHealth(identity.installationId, record.current.version);
    if (health.controlLeaseActive || health.sessions > 0)
      throw new Error("Release desktop sessions before package maintenance");
  }
}
