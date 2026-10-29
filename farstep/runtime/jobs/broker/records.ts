import type { Dirent } from "node:fs";
import { cp, lstat, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { attempt, run } from "@ai/runtime/effect/effect";
import { syncDirectoryAncestors } from "@ai/runtime/effect/fs/fs";
import { Queue } from "@ai/runtime/effect/queue/queue";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { Cause, Effect } from "effect";
import {
  jobSnapshotSchema,
  jobTerminalEventsSchema,
  parseJobSpec,
  parseJobWireMessage,
} from "farstep/protocol/jobs/protocol";
import * as v from "valibot";
import { atomicWriteEffect, privateDirectory, privateRead } from "../../state";
import { JobLog } from "./log";

import { ended, type ManagedJob } from "./model";

const metadataSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({
    snapshot: jobSnapshotSchema,
    terminalEvents: jobTerminalEventsSchema,
    completionEvents: v.optional(v.boolean(), false),
    pendingCompletions: v.array(v.unknown()),
    outputStorage: v.optional(
      v.object({
        peakQueuedBytes: v.number(),
        peakQueuedChunks: v.number(),
        rejectedBytes: v.number(),
        failure: v.optional(v.string()),
      }),
    ),
  }),
);

export class JobRecords {
  constructor(private readonly directory: string) {}

  jobDirectory(name: string): string {
    return join(this.directory, "jobs", name);
  }

  async #migrate(runtimeDirectory: string): Promise<void> {
    const legacy = join(runtimeDirectory, "jobs");
    let entries: Dirent[];
    try {
      entries = await readdir(legacy, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    await privateDirectory(legacy);
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u.test(entry.name)
      )
        throw new Error("Invalid legacy job record directory");
      const source = join(legacy, entry.name);
      const target = this.jobDirectory(entry.name);
      await privateDirectory(source);
      const sourceMeta = v.parse(
        metadataSchema,
        await privateRead(join(source, "meta.json")),
      );
      let published = false;
      try {
        const existing = v.parse(
          metadataSchema,
          await privateRead(join(target, "meta.json")),
        );
        if (
          existing.snapshot.id !== sourceMeta.snapshot.id ||
          existing.snapshot.owner !== sourceMeta.snapshot.owner
        )
          throw new Error("Legacy and durable job record identities conflict");
        published = true;
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      if (!published) {
        const staging = join(this.directory, `.migrating-${entry.name}`);
        await privateDirectory(staging);
        // Only this interrupted migration's staging copy may be replaced
        await rm(staging, { recursive: true });
        for (const file of await readdir(source, { withFileTypes: true })) {
          const path = join(source, file.name);
          const info = await lstat(path);
          if (
            !info.isFile() ||
            info.uid !== process.getuid?.() ||
            (info.mode & 0o077) !== 0
          )
            throw new Error("Unsafe legacy job record file");
        }
        await cp(source, staging, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        for (const file of await readdir(staging)) {
          await using handle = await open(join(staging, file), "r");
          await handle.sync();
        }
        await syncDirectoryAncestors(staging, 1);
        await rename(staging, target);
        await syncDirectoryAncestors(join(this.directory, "jobs"), 3);
      }
      // Publication is durable before the old transport-only directory is removed
      await rm(source, { recursive: true });
    }
    await rmdir(legacy);
  }

  persist(job: ManagedJob): Promise<void> {
    const directory = this.jobDirectory(job.spec.name);
    const spec = JSON.stringify(job.spec);
    const meta = JSON.stringify({
      snapshot: job.snapshot,
      terminalLogBytes: job.log.end,
      outputStorage: job.log.storage,
      terminalEvents: job.events,
      completionEvents: job.capable,
      pendingCompletions: job.pending,
    });
    if (job.savedSpec === spec && job.savedMeta === meta) return this.persisted(job);
    const changedSpec = job.savedSpec !== spec;
    const changedMeta = job.savedMeta !== meta;
    job.savedSpec = spec;
    job.savedMeta = meta;
    return run(
      job.persistence.runEffect(
        Effect.gen(function* () {
          if (job.persistenceFailure)
            return yield* Effect.fail(job.persistenceFailure.error);
          if (changedSpec) yield* atomicWriteEffect(join(directory, "spec.json"), spec);
          if (changedMeta) yield* atomicWriteEffect(join(directory, "meta.json"), meta);
          yield* attempt(() => syncDirectoryAncestors(directory, 4), {
            awaitOnInterrupt: true,
          });
        }).pipe(
          Effect.scoped,
          Effect.tapCause((cause) =>
            Effect.sync(() => {
              // A failed receipt poisons later writes and shutdown's durability barrier
              job.persistenceFailure ??= { error: Cause.squash(cause) };
            }),
          ),
        ),
      ),
    );
  }

  persisted(job: ManagedJob): Promise<void> {
    return run(
      job.persistence.runEffect(
        Effect.suspend(() =>
          job.persistenceFailure
            ? Effect.fail(job.persistenceFailure.error)
            : Effect.void,
        ),
      ),
    );
  }

  async recover(
    jobs: Map<string, ManagedJob>,
    runtimeDirectory?: string,
  ): Promise<void> {
    const root = join(this.directory, "jobs");
    await privateDirectory(root);
    if (runtimeDirectory) await this.#migrate(runtimeDirectory);
    // Keep every name reservation and unresolved completion, regardless of age
    // Deleting metadata would silently shorten the launch no-replay window
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u.test(entry.name)
      )
        throw new Error("Invalid job record directory");
      const directory = join(root, entry.name);
      await privateDirectory(directory);
      const meta = v.parse(
        metadataSchema,
        await privateRead(join(directory, "meta.json")),
      );
      const { snapshot } = meta;
      const spec = parseJobSpec(
        JSON.parse(await privateRead(join(directory, "spec.json"))),
      );
      if (snapshot.name !== entry.name || spec.name !== entry.name)
        throw new Error("Stored job does not match its supervisor scope");
      const log = await JobLog.recover(directory, meta.outputStorage);
      const job: ManagedJob = {
        spec,
        snapshot,
        log,
        events: meta.terminalEvents,
        pending: meta.pendingCompletions.map((value) => {
          const event = parseJobWireMessage(value);
          if (
            !("event" in event) ||
            event.snapshot.id !== snapshot.id ||
            event.owner !== snapshot.owner
          )
            throw new Error("Stored completion identity mismatch");
          return event;
        }),
        capable: meta.completionEvents,
        stopped: true,
        buffer: (await log.logs(false, 10000)).text.slice(-65536),
        logReady: snapshot.readyAt !== undefined,
        portReady: snapshot.readyAt !== undefined,
        persistence: new Queue(),
      };
      jobs.set(entry.name, job);
      if (!ended(job)) {
        // A stale PID cannot identify a process that is safe to signal or resume
        snapshot.state = "unknown";
        snapshot.pid = undefined;
        snapshot.exitReason =
          "Previous supervisor exited; execution outcome is unknown";
        await this.persist(job);
      }
    }
  }
}
