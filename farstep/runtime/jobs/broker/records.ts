import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { openFile } from "@ai/core/effect/fs/fs";
import { Queue } from "@ai/core/effect/queue/queue";
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
  }),
);

export class JobRecords {
  constructor(private readonly directory: string) {}

  persist(job: ManagedJob): Promise<void> {
    const directory = join(this.directory, "jobs", job.spec.name);
    const spec = JSON.stringify(job.spec);
    const meta = JSON.stringify({
      snapshot: job.snapshot,
      terminalLogBytes: job.log.end,
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
          const handle = yield* openFile(directory, "r");
          yield* attempt(() => handle.sync(), { awaitOnInterrupt: true });
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

  async recover(jobs: Map<string, ManagedJob>): Promise<void> {
    const root = join(this.directory, "jobs");
    await privateDirectory(root);
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
      const log = await JobLog.recover(directory);
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
