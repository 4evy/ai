import { lstat } from "node:fs/promises";
import { errorMessage as describeError, errorCode } from "@ai/values/error/error";

export { errorCode } from "@ai/values/error/error";

export interface ReadinessContext {
  cwd: string;
  signal: AbortSignal;
  exited: Promise<number>;
  log: () => string | Promise<string>;
}

export interface Observation {
  ready: boolean;
  reason: string;
  fatal?: boolean;
}

export function errorMessage(error: unknown): string {
  return describeError(error).replaceAll("\0", "\uFFFD");
}

export async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}
