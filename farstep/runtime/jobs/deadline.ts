import { hash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { Process } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { seq, tuple } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { map, withDefault } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument, command, passThrough } from "@optique/core/primitives";
import { valibot } from "@optique/valibot";
import { Deferred, Effect } from "effect";
import { uuidSchema } from "farstep/protocol/identity";
import type { JobSpec } from "farstep/protocol/jobs/protocol";
import * as v from "valibot";
import { deadlineEvidenceSchema } from "#farstep/protocol/jobs/gateway";
import {
  atomicWrite,
  durableJsonWriter,
  privateDirectory,
  privateRead,
} from "../state";

const deadlineIndexSchema = v.strictObject({
  record: v.string(),
  nativeId: v.string(),
});

const recordSchema = v.strictObject({
  installationId: uuidSchema,
  scopeId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  owner: v.string(),
  name: v.string(),
  evidence: deadlineEvidenceSchema,
});

const persist = durableJsonWriter<v.InferOutput<typeof recordSchema>>(4);

export async function prepareDeadline(
  directory: string,
  scopeId: string,
  owner: string,
  installationId: string,
  spec: JobSpec,
  deadlineSeconds: number,
): Promise<JobSpec> {
  if (deadlineSeconds === 0) return spec;
  const root = join(directory, "deadlines");
  await privateDirectory(root);
  const record = join(root, `${randomUUID()}.json`);
  await persist(record, {
    installationId,
    scopeId,
    owner,
    name: spec.name,
    evidence: { deadlineSeconds, preparedAt: Date.now(), childrenGone: "unknown" },
  });
  // The packaged executable re-enters this module without exposing command text
  const launcherArgs = Bun.main.startsWith("/$bunfs/") ? [] : [Bun.main];
  return {
    ...spec,
    application: process.execPath,
    args: [
      ...launcherArgs,
      "deadline",
      "--record",
      record,
      "--seconds",
      String(deadlineSeconds),
      "--application",
      spec.application,
      "--",
      ...spec.args,
    ],
  };
}

export async function bindDeadline(
  directory: string,
  spec: JobSpec,
  nativeId: string,
  installationId: string,
  scopeId: string,
  owner: string,
): Promise<void> {
  const marker = spec.args.indexOf("deadline");
  if (
    spec.application !== process.execPath ||
    marker < 0 ||
    spec.args[marker + 1] !== "--record"
  )
    return;
  const path = spec.args[marker + 2];
  if (!path || dirname(path) !== join(directory, "deadlines"))
    throw new Error("Invalid private deadline record location");
  const record = v.parse(recordSchema, JSON.parse(await privateRead(path)));
  if (
    record.installationId !== installationId ||
    record.scopeId !== scopeId ||
    record.owner !== owner ||
    record.name !== spec.name
  )
    throw new Error("Deadline evidence identity mismatch");
  const index = hash("sha256", JSON.stringify([spec.name, nativeId]));
  await atomicWrite(
    join(directory, "deadlines", `${index}.index`),
    JSON.stringify({ record: path, nativeId }),
  );
}

export async function deadlineEvidence(
  directory: string,
  name: string,
  nativeId: string,
  installationId: string,
  scopeId: string,
  owner: string,
) {
  const root = join(directory, "deadlines");
  const index = hash("sha256", JSON.stringify([name, nativeId]));
  try {
    const { record: path, nativeId: boundId } = v.parse(
      deadlineIndexSchema,
      JSON.parse(await privateRead(join(root, `${index}.index`))),
    );
    if (dirname(path) !== root) throw new Error("Invalid deadline evidence path");
    const record = v.parse(recordSchema, JSON.parse(await privateRead(path)));
    if (
      record.name !== name ||
      boundId !== nativeId ||
      record.installationId !== installationId ||
      record.scopeId !== scopeId ||
      record.owner !== owner
    )
      throw new Error("Deadline evidence identity mismatch");
    return record.evidence;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export async function runDeadline(args: readonly string[]): Promise<void> {
  const { path, application, seconds, forwarded } = deadlineArgs(args);
  await privateDirectory(dirname(path));
  const record = v.parse(recordSchema, JSON.parse(await privateRead(path)));
  if (record.evidence.deadlineSeconds !== seconds)
    throw new Error("Managed deadline identity mismatch");
  const evidence = record.evidence;
  evidence.startedAt = Date.now();
  await persist(path, record);
  // Inherit the broker's foreground PTY group so interactive reads never SIGTTIN
  const child = Bun.spawn([application, ...forwarded], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let root: Process | null = null;
  try {
    root = Process.fromPid(child.pid);
  } catch {
    /* Child handle still enforces the deadline */
  }
  let exited = false;
  let tracked: Process[] = root ? [root] : [];
  const exit = child.exited.then((code) => {
    exited = true;
    return code;
  });
  const failed = Deferred.makeUnsafe<never, Error>();
  const watchdog = Effect.sleep(seconds * 1000).pipe(
    Effect.andThen(
      // Once enforcement starts, finish native cleanup and durable evidence
      Effect.gen(function* () {
        if (exited) return;
        yield* attempt(async () => {
          if (root) tracked = deadlineProcesses(root, evidence);
          evidence.deadlineTriggeredAt = Date.now();
          await persist(path, record);
          const treeSignalled = signalDeadlineTree(root, evidence);
          let signalSent = treeSignalled;
          if (!treeSignalled && !exited) {
            child.kill("SIGTERM");
            signalSent = true;
          }
          if (signalSent) evidence.signalSentAt = Date.now();
          await persist(path, record);
        });
        yield* Effect.sleep(1000);
        yield* attempt(async () => {
          // Stable native references avoid signalling a PID reused after the leader
          // exit
          let forceSent = forceDeadlineProcesses(tracked, evidence);
          if (!exited) {
            child.kill("SIGKILL");
            forceSent = true;
          }
          if (forceSent) evidence.forceSentAt = Date.now();
          await persist(path, record);
        });
      }).pipe(
        Effect.catch(() =>
          attempt(async () => {
            evidence.error = "deadline-enforcement-failed";
            if (!exited) {
              try {
                child.kill("SIGKILL");
                evidence.forceSentAt = Date.now();
              } catch {
                /* Report failure without claiming cleanup */
              }
            }
            try {
              await persist(path, record);
            } catch {
              /* The evidence store itself may be unavailable */
            }
          }).pipe(
            Effect.andThen(
              Deferred.fail(
                failed,
                new Error(
                  "Managed deadline enforcement failed; child cleanup is not confirmed",
                ),
              ),
            ),
          ),
        ),
        Effect.uninterruptible,
      ),
    ),
  );
  const exitCode = await run(
    Effect.gen(function* () {
      yield* Effect.forkScoped(watchdog);
      return yield* Effect.raceFirst(
        attempt(() => exit),
        Deferred.await(failed),
      );
    }).pipe(Effect.scoped),
  );
  evidence.exitCode = exitCode;
  evidence.leaderExited = true;
  if (tracked.length)
    evidence.trackedProcessesNoLongerObserved = tracked.every(
      (process) => process.status() === "exited",
    );
  await persist(path, record);
  process.exitCode = evidence.signalSentAt === undefined ? exitCode : 124;
}

const deadlineParser = map(
  seq(
    command(
      "--record",
      argument(
        valibot(
          v.pipe(
            v.string(),
            v.nonEmpty(),
            v.check((path) => resolve(path) === path),
          ),
          { placeholder: "/" },
        ),
      ),
    ),
    command(
      "--seconds",
      argument(
        valibot(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1)), {
          placeholder: 1,
        }),
      ),
    ),
    command(
      "--application",
      tuple([
        command("--", withDefault(passThrough({ format: "greedy" }), [])),
        argument(valibot(v.pipe(v.string(), v.startsWith("/")), { placeholder: "/" })),
      ]),
    ),
  ),
  ([path, seconds, [forwarded, application]]) => ({
    path,
    seconds,
    application,
    forwarded,
  }),
);

function deadlineArgs(args: readonly string[]) {
  const parsed = parseSync(deadlineParser, args);
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  return parsed.value;
}
type DeadlineEvidence = v.InferOutput<typeof deadlineEvidenceSchema>;

function deadlineProcesses(root: Process, evidence: DeadlineEvidence): Process[] {
  let tracked: Process[] = [];
  try {
    tracked = [root];
    for (const current of tracked) tracked.push(...current.children());
  } catch {
    evidence.nativeTreeSignalFailed = true;
  }
  return tracked;
}
function signalDeadlineTree(root: Process | null, evidence: DeadlineEvidence): boolean {
  let treeSignalled = false;
  try {
    treeSignalled = (root?.killTree(15) ?? 0) > 0;
  } catch {
    evidence.nativeTreeSignalFailed = true;
  }
  return treeSignalled;
}
function forceDeadlineProcesses(
  tracked: Process[],
  evidence: DeadlineEvidence,
): boolean {
  let forceSent = false;
  for (const process of tracked) {
    try {
      if (process.status() !== "exited")
        forceSent = process.killTree(9) > 0 || forceSent;
    } catch {
      evidence.nativeTreeSignalFailed = true;
    }
  }
  return forceSent;
}
