import { attempt, run } from "@ai/core/effect/effect";
import type { AgentToolUpdateCallback } from "@oh-my-pi/pi-coding-agent";
import { Effect, Schedule } from "effect";
import type { Gateway } from "farstep/client/jobs/gateway";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import { assertIdentity, terminal } from "../broker";
import type { JobSession } from "../session";
import type { JobRecord, RemoteJobDetails, RunInput, Scope } from "../types";

const FRAME_OBSERVATION = { waitForFrame: true, maxWaitMs: 1000 } as const;
const READINESS_POLL_MS = 100;

export async function observeLaunch(
  session: JobSession,
  scope: Scope,
  client: Gateway,
  job: JobRecord,
  snapshot: JobSnapshot,
  input: Pick<RunInput, "ready" | "raw" | "compact">,
  waitMs: number,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<RemoteJobDetails>,
) {
  if (job.workflowFingerprint && input.ready && !terminal(snapshot) && waitMs > 0) {
    snapshot = await waitReadiness(
      session,
      scope,
      client,
      job,
      snapshot,
      waitMs,
      input,
      onUpdate,
      signal,
    );
  }
  if (!input.ready && !terminal(snapshot) && waitMs > 0) {
    const deadline = performance.now() + waitMs;
    do {
      if (onUpdate) {
        snapshot = await progressUpdate(
          session,
          scope,
          client,
          job,
          snapshot,
          input,
          onUpdate,
          signal,
        );
      }
      const remaining = Math.ceil(deadline - performance.now());
      if (terminal(snapshot) || remaining <= 0) break;
      const waited = await client.request(
        {
          op: "wait",
          name: job.name,
          for: "exit",
          timeoutMs: onUpdate ? Math.min(1000, remaining) : remaining,
        },
        signal,
      );
      assertIdentity(job, waited.snapshot);
      snapshot = waited.snapshot;
    } while (onUpdate && !terminal(snapshot));
  }
  const screen = job.pty && !input.raw && !terminal(snapshot);
  const view = screen
    ? await session.observe(scope, client, job, snapshot, FRAME_OBSERVATION, signal)
    : await session.logs(scope, client, job, snapshot);
  return { view, screen };
}

async function waitReadiness(
  session: JobSession,
  scope: Scope,
  client: Gateway,
  job: JobRecord,
  snapshot: JobSnapshot,
  waitMs: number,
  input: Pick<RunInput, "ready" | "raw" | "compact">,
  onUpdate: AgentToolUpdateCallback<RemoteJobDetails> | undefined,
  signal?: AbortSignal,
): Promise<JobSnapshot> {
  let first = true;
  let nextUpdate = 0;
  await run(
    attempt(
      async (signal) => {
        if (terminal(snapshot)) return true;
        if (!first) ({ snapshot } = await session.inspect(scope, client, job, signal));
        first = false;
        if (onUpdate && performance.now() >= nextUpdate) {
          snapshot = await progressUpdate(
            session,
            scope,
            client,
            job,
            snapshot,
            input,
            onUpdate,
            signal,
          );
          nextUpdate = performance.now() + 1000;
        }
        if (terminal(snapshot)) return true;
        const workflow = await client.workflow(job.name, signal);
        const readiness = workflow.steps[0]?.readiness;
        return readiness !== undefined && readiness.state !== "pending";
      },
      { awaitOnInterrupt: true },
    ).pipe(
      Effect.repeat({
        schedule: Schedule.spaced(READINESS_POLL_MS),
        while: (ready) => !ready,
      }),
      Effect.timeoutOption(waitMs),
    ),
    signal,
  );
  return snapshot;
}
async function progressUpdate(
  session: JobSession,
  scope: Scope,
  client: Gateway,
  job: JobRecord,
  snapshot: JobSnapshot,
  input: Pick<RunInput, "ready" | "raw" | "compact">,
  onUpdate: AgentToolUpdateCallback<RemoteJobDetails>,
  signal?: AbortSignal,
): Promise<JobSnapshot> {
  const initialScreen = job.pty && !input.raw;
  const initial = initialScreen
    ? await session.observe(scope, client, job, snapshot, FRAME_OBSERVATION, signal)
    : await session.logs(scope, client, job, snapshot);
  snapshot = initial.snapshot;
  onUpdate(
    session.result(scope, job, snapshot, initial.logs, {
      // Progress replaces the visible snapshot without consuming model output
      consume: false,
      screen: initialScreen,
      ...("screenVersion" in initial
        ? { screenVersion: initial.screenVersion, settled: initial.settled }
        : {}),
      raw: input.raw,
      compact: input.compact,
    }),
  );
  return snapshot;
}
