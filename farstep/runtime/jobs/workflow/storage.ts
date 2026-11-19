import { hash } from "node:crypto";
import { link, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stageFile, syncDirectoryAncestors } from "@ai/runtime/effect/fs/fs";
import {
  checkPrivateDirectory,
  durableJsonWriter,
  privateDirectory,
} from "../../state";
import { withFileLock } from "../lock/lock";
import type { LockWait } from "../lock/wait";

export const writeWorkflowRecord = durableJsonWriter(5);

export function workflowHash(value: string): string {
  return hash("sha256", value);
}

export async function workflowDirectory(
  scope: string,
  name: string,
  create = true,
): Promise<string> {
  const validate = create ? privateDirectory : checkPrivateDirectory;
  const root = join(scope, "workflows");
  await validate(root);
  if ((await realpath(root)) !== root)
    throw new Error("Workflow root must be canonical and private");
  const directory = join(root, workflowHash(name));
  await validate(directory);
  if ((await realpath(directory)) !== directory)
    throw new Error("Workflow directory must be canonical and private");
  return directory;
}

export async function immutableWorkflowWrite(
  path: string,
  value: unknown,
): Promise<void> {
  await using staged = await stageFile(path, 0o400);
  await staged.write(JSON.stringify(value));
  await link(staged.path, path);
  await syncDirectoryAncestors(dirname(path), 5);
}

export async function withWorkflowLock<T>(
  directory: string,
  key: string,
  work: () => Promise<T>,
  options: LockWait = {},
): Promise<T> {
  return withFileLock(directory, key, work, {
    ...options,
    unsafeMessage: "Unsafe private workflow lock",
  });
}
