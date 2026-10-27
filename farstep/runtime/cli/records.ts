import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@ai/core/error/error";
import type { CoordinationJob } from "farstep/protocol/coordination";
import { uuidSchema } from "farstep/protocol/identity";
import { jobSnapshotSchema, parseJobWireMessage } from "farstep/protocol/jobs/protocol";
import * as v from "valibot";
import { paths, privateRead } from "../state";

const scopeSchema = v.strictObject({
  scopeId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  owner: v.pipe(
    v.string(),
    v.regex(/^remote:[A-Za-z0-9._:-]{1,128}:[A-Za-z0-9._:-]{1,128}$/u),
  ),
  installationId: uuidSchema,
});
const metadataSchema = v.object({
  snapshot: jobSnapshotSchema,
  pendingCompletions: v.array(v.unknown()),
});

export async function completionEvidence(job: CoordinationJob) {
  try {
    if (!job.nativeId) throw new Error("Registry has no native job identity");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u.test(job.name))
      throw new Error("Registry job has no native broker record name");
    const state = await realpath(paths().state);
    const identity = v.parse(
      v.strictObject({ installationId: uuidSchema }),
      JSON.parse(await privateRead(join(state, "installation.json"))),
    );
    if (identity.installationId !== job.installationId)
      throw new Error("Registry job belongs to another installation");
    const scopeDirectory = join(state, "scopes", job.scopeId);
    const directory = join(scopeDirectory, "broker", "jobs", job.name);
    for (const path of [
      join(state, "scopes"),
      scopeDirectory,
      join(scopeDirectory, "broker"),
      join(scopeDirectory, "broker", "jobs"),
      directory,
    ]) {
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0 ||
        (await realpath(path)) !== path
      )
        throw new Error("Unsafe durable broker record directory");
    }
    const scope = v.parse(
      scopeSchema,
      JSON.parse(await privateRead(join(scopeDirectory, "scope.json"))),
    );
    if (
      scope.scopeId !== job.scopeId ||
      scope.owner !== job.owner ||
      scope.installationId !== job.installationId
    )
      throw new Error("Broker scope ownership or installation identity mismatch");
    const source = join(directory, "meta.json");
    const metadata = v.parse(metadataSchema, JSON.parse(await privateRead(source)));
    if (
      metadata.snapshot.id !== job.nativeId ||
      metadata.snapshot.name !== job.name ||
      metadata.snapshot.owner !== job.owner
    )
      throw new Error("Durable broker native job identity mismatch");
    const pending = metadata.pendingCompletions.map((value) => {
      const event = parseJobWireMessage(value);
      if (
        !("event" in event) ||
        event.owner !== job.owner ||
        event.snapshot.owner !== job.owner ||
        event.snapshot.id !== job.nativeId ||
        event.snapshot.name !== job.name
      )
        throw new Error("Durable completion native job identity mismatch");
      return event;
    });
    return {
      source,
      acknowledgement: {
        state: pending.length ? "unacknowledged" : "unknown",
        detail: pending.length
          ? "Matching completion events remain in the owning broker's durable queue"
          : "No pending event does not prove acknowledgement. Explicit unsubscribe can also clear the queue.",
      },
      pending: pending.map((event) => ({
        completionId: event.completionId,
        state: event.snapshot.state,
        exitedAt: event.snapshot.exitedAt,
        exitCode: event.snapshot.exitCode,
      })),
      readiness: {
        state: metadata.snapshot.readyAt === undefined ? "unknown" : "ready",
        recordedAt: metadata.snapshot.readyAt,
        detail: "Recorded readiness only, not a current responsiveness probe",
      },
    };
  } catch (error) {
    return {
      acknowledgement: {
        state: "unknown",
        detail: errorMessage(error),
      },
      pending: [],
      readiness: {
        state: "unknown",
        detail: "No validated durable readiness evidence was read",
      },
    };
  }
}
