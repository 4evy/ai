import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";

export const systemHelper = "/run/current-system/sw/bin/farstep";

/** nix-darwin publishes this executable atomically with its system generation */
export async function darwinSystemPackage(): Promise<string | undefined> {
  if (process.platform !== "darwin") return;
  try {
    return dirname(dirname(await realpath(systemHelper)));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  return undefined;
}
