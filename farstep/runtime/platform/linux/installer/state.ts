import { lstat } from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as v from "valibot";
import { createInstallerLock } from "#farstep/runtime/installer/shared";
import { exists, privateRead } from "#farstep/runtime/state";
import { locations } from "./locations";
import {
  type InstallationRecord,
  type Preparation,
  preparationSchema,
  recordSchema,
} from "./schemas";

export async function installed(): Promise<InstallationRecord | undefined> {
  try {
    return v.parse(recordSchema, JSON.parse(await privateRead(locations().record)));
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export async function prepared(): Promise<Preparation | undefined> {
  if (!(await exists(locations().preparation))) return undefined;
  const info = await lstat(locations().lock);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("Maintenance lock has unsafe ownership, type or permissions");
  }
  return v.parse(
    preparationSchema,
    JSON.parse(await privateRead(locations().preparation)),
  );
}

export const installerLock = createInstallerLock(prepared);
