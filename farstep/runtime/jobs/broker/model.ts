import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Queue } from "@ai/core/effect/queue/queue";
import type { Process, PtySession } from "@oh-my-pi/pi-natives";
import type {
  JobCompletionNotification,
  JobOperation,
  JobSnapshot,
  JobSpec,
  JobTerminalEvent,
} from "farstep/protocol/jobs/protocol";
import { isJobTerminal } from "farstep/protocol/jobs/states";
import type { JobLog } from "./log";

export interface ManagedJob {
  spec: JobSpec;
  snapshot: JobSnapshot;
  log: JobLog;
  events: JobTerminalEvent[];
  pending: JobCompletionNotification[];
  capable: boolean;
  stopped: boolean;
  terminal?: PtySession;
  input?: Bun.FileSink | undefined;
  process?: Process | undefined;
  finished?: Promise<void>;
  settling?: Promise<void>;
  outputFailure?: { error: unknown };
  buffer: string;
  pattern?: RegExp | undefined;
  logReady: boolean;
  portReady: boolean;
  persistence: Queue;
  persistenceFailure?: { error: unknown };
  savedSpec?: string;
  savedMeta?: string;
}
export type Operation<Name extends JobOperation["op"]> = Extract<
  JobOperation,
  { op: Name }
>;

export function validateStart(operation: Operation<"start">): void {
  const spec = operation.spec;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u.test(spec.name) ||
    !isAbsolute(spec.application) ||
    !isAbsolute(spec.cwd)
  )
    throw new Error(
      "Job launch requires a bounded name and absolute executable and working directory",
    );
}

export function managedJob(
  operation: Operation<"start">,
  log: JobLog,
  now: number,
  pattern: RegExp | undefined,
  size: JobSnapshot["terminalSize"],
  capable: boolean,
): ManagedJob {
  const spec = operation.spec;
  return {
    spec,
    snapshot: {
      name: spec.name,
      id: randomUUID(),
      createdAt: now,
      startedAt: now,
      state: "starting",
      outputBytes: 0,
      owner: operation.owner,
      persist: spec.persist,
      terminalSize: size,
    },
    log,
    events: size ? [{ offset: 0, terminalSize: size, reset: true }] : [],
    pending: [],
    capable,
    stopped: false,
    buffer: "",
    pattern,
    logReady: !spec.ready?.log,
    portReady: spec.ready?.port === undefined,
    persistence: new Queue(),
  };
}

export const ended = (job: ManagedJob) => isJobTerminal(job.snapshot.state);
