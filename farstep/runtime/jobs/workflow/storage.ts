import { hash, randomUUID } from "node:crypto";
import { link, open, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { syncDirectoryAncestors } from "@ai/core/effect/fs/fs";
import { durableJsonWriter, privateDirectory } from "../../state";
import { withFileLock } from "../lock/lock";

export const writeWorkflowRecord = durableJsonWriter(5);

export function workflowHash(value: string): string {
  return hash("sha256", value);
}

export async function workflowDirectory(scope: string, name: string): Promise<string> {
  const root = join(scope, "workflows");
  await privateDirectory(root);
  if ((await realpath(root)) !== root)
    throw new Error("Workflow root must be canonical and private");
  const directory = join(root, workflowHash(name));
  await privateDirectory(directory);
  if ((await realpath(directory)) !== directory)
    throw new Error("Workflow directory must be canonical and private");
  return directory;
}

export async function immutableWorkflowWrite(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = join(dirname(path), `.manifest-${randomUUID()}`);
  try {
    {
      await using file = await open(temporary, "wx", 0o400);
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    }
    await link(temporary, path);
    await syncDirectoryAncestors(dirname(path), 5);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function withWorkflowLock<T>(
  directory: string,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  return withFileLock(directory, key, work, {
    unsafeMessage: "Unsafe private workflow lock",
  });
}
