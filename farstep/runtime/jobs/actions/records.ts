import { hash } from "node:crypto";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as v from "valibot";
import {
  actionReceiptSchema,
  terminationMetadataSchema,
} from "#farstep/protocol/jobs/gateway";
import { atomicWrite, privateDirectory, privateRead } from "../../state";
import { withFileLock } from "../lock/lock";

export const actionHash = (value: string) => hash("sha256", value);
const recordSchema = v.strictObject({
  scopeId: v.string(),
  owner: v.string(),
  installationId: v.string(),
  receipt: actionReceiptSchema,
  termination: v.optional(terminationMetadataSchema),
});

export async function durableWrite(
  path: string,
  value: unknown,
  directory: string,
): Promise<void> {
  await atomicWrite(path, JSON.stringify(value));
  await using handle = await open(directory, "r");
  await handle.sync();
}

export async function withJobLock<T>(
  directory: string,
  work: () => Promise<T>,
): Promise<T> {
  return withFileLock(directory, "mutation", work, {
    unsafeMessage: "Unsafe job mutation lock",
    timeoutMessage: "Job mutation is busy; no action was sent",
  });
}

export class ActionRecords {
  constructor(
    private readonly root: string,
    private readonly scopeId: string,
    private readonly owner: string,
    private readonly installationId: string,
  ) {}

  async directory(name: string, nativeId: string): Promise<string> {
    const root = join(this.root, "actions");
    await privateDirectory(root);
    const directory = join(root, actionHash(JSON.stringify([name, nativeId])));
    await privateDirectory(directory);
    // Sync directory entries too, so a power loss cannot forget the no-replay fence
    for (const parent of [
      root,
      this.root,
      dirname(this.root),
      dirname(dirname(this.root)),
    ]) {
      await using handle = await open(parent, "r");
      await handle.sync();
    }
    return directory;
  }

  path(directory: string, actionId: string): string {
    return join(directory, `${actionHash(actionId)}.json`);
  }

  async read(path: string, name: string, nativeId: string, actionId: string) {
    try {
      const record = v.parse(recordSchema, JSON.parse(await privateRead(path)));
      if (
        record.scopeId !== this.scopeId ||
        record.owner !== this.owner ||
        record.installationId !== this.installationId ||
        record.receipt.name !== name ||
        record.receipt.nativeId !== nativeId ||
        record.receipt.actionId !== actionId
      )
        throw new Error("Durable action receipt identity mismatch");
      return record;
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  }
}
