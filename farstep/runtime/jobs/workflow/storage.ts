import { hash, randomUUID } from "node:crypto";
import { link, open, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite, privateDirectory } from "../../state";
import { withFileLock } from "../lock/lock";

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

export async function durableWorkflowWrite(
  path: string,
  value: unknown,
): Promise<void> {
  await atomicWrite(path, JSON.stringify(value));
  await syncParents(dirname(path));
}

async function syncParents(directory: string): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await using file = await open(directory, "r");
    await file.sync();
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
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
    await syncParents(dirname(path));
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
