import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { terminalSize } from "farstep/client/terminal/terminal";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import { WorkflowStartError } from "farstep/protocol/workflow/workflow";
import { REMOTE_TOOLS } from "farstep/remote/tools/names";
import type { ExecutionTarget } from "../../connections/types";
import type { JobSession } from "../session";
import type {
  BatchInput,
  JobRecord,
  RemoteJobDetails,
  Result,
  RunInput,
} from "../types";
import { observeLaunch } from "./observation";
import {
  type PreparedLaunch,
  prepareBatchLaunch,
  prepareWorkflowLaunch,
} from "./workflow";

const CANCELED_OBSERVATION_NOTICE =
  "Caller canceled the observation. The job was not stopped";

export async function runJob(
  session: JobSession,
  connection: ExecutionTarget,
  input: RunInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<RemoteJobDetails>,
): Promise<Result> {
  const prepared = await prepareWorkflowLaunch(session, connection, input, ctx, signal);
  return executeLaunch(session, prepared, input, signal, onUpdate);
}

export async function runBatchJob(
  session: JobSession,
  connection: ExecutionTarget,
  input: BatchInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<RemoteJobDetails>,
): Promise<Result> {
  return executeLaunch(
    session,
    await prepareBatchLaunch(session, connection, input, ctx, signal),
    input,
    signal,
    onUpdate,
  );
}

function assertLaunchSize(snapshot: JobSnapshot, size: PreparedLaunch["size"]): void {
  if (size) {
    const actual = terminalSize(snapshot);
    if (actual.columns !== size.columns || actual.rows !== size.rows)
      throw new Error("Native broker did not apply the requested terminal dimensions");
  }
}

async function executeLaunch(
  session: JobSession,
  prepared: PreparedLaunch,
  input: Pick<RunInput, "ready" | "raw" | "compact">,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<RemoteJobDetails>,
): Promise<Result> {
  const { scope, intent, size, waitMs, client: preparedClient } = prepared;
  let client = preparedClient;
  const { name, cwd, spec } = intent;
  // Persist before the irreversible start so a lost response can be inspected, never
  // replayed
  session.saveJob(scope, intent);
  const finish = session.begin(scope, name);
  let job: JobRecord | undefined;
  let snapshot: JobSnapshot | undefined;
  let notice: string | undefined;
  let startFailure: unknown;
  const recoverCancellation = async (): Promise<Result | undefined> => {
    if (job && signal?.aborted && session.isCurrent(scope)) {
      try {
        client = await session.forRecord(scope, job);
        const current = await session.inspect(scope, client, job);
        const view = await session.logs(scope, client, job, current.snapshot);
        return session.result(scope, job, view.snapshot, view.logs, {
          notice: CANCELED_OBSERVATION_NOTICE,
          markDelivered: true,
          raw: input.raw,
          compact: input.compact,
        });
      } catch {
        // A lost channel cannot establish the execution outcome
      }
    }
    return undefined;
  };
  try {
    try {
      const started = await client.startWorkflow(
        name,
        intent.workflowFingerprint,
        spec,
        signal,
      );
      snapshot = started.snapshot;
    } catch (error) {
      startFailure = error;
      if (
        error instanceof WorkflowStartError &&
        error.outcome === "definitely-not-started"
      )
        throw error;
      // Inspection is safe even when the start request failed after spawning
      notice = `The native start did not return a successful response: ${
        toError(error).message
      }. The command was not retried`;
      client = await session.forRecord(scope, intent);
    }
    ({ job, snapshot } = await session.inspect(scope, client, intent));
    assertLaunchSize(snapshot, size);
    // The broker owns execution once started, not this tool's observation
    if (signal?.aborted) notice = CANCELED_OBSERVATION_NOTICE;
    const { view, screen, readyTimedOut } = await observeLaunch(
      session,
      scope,
      client,
      job,
      snapshot,
      input,
      signal?.aborted ? 0 : waitMs,
      signal?.aborted ? undefined : signal,
      signal?.aborted ? undefined : onUpdate,
    );
    return session.result(scope, job, view.snapshot, view.logs, {
      notice,
      markDelivered: true,
      screen,
      readyTimedOut,
      ...("screenVersion" in view
        ? { screenVersion: view.screenVersion, settled: view.settled }
        : {}),
      raw: input.raw,
      compact: input.compact,
    });
  } catch (error) {
    const recovered = await recoverCancellation();
    if (recovered) return recovered;
    const definitelyNotStarted =
      startFailure instanceof WorkflowStartError &&
      startFailure.outcome === "definitely-not-started";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            job: {
              name,
              connectionId: intent.connectionId,
              cwd,
              owner: intent.owner,
              installationId: client.installationId,
              scopeId: scope.scopeId,
              nativeId: job?.nativeId ?? intent.nativeId,
              requestId: intent.requestId,
              lifecycle: definitelyNotStarted ? "not-started" : "unknown",
            },
            output: { state: "unavailable" },
            outcome: definitelyNotStarted ? "definitely-not-started" : "unknown",
            error: toError(startFailure ?? error).message,
            ...(startFailure && startFailure !== error
              ? { inspectionError: toError(error).message }
              : {}),
            notice,
            recovery: {
              replayed: false,
              ...(!definitelyNotStarted
                ? { next: { tool: REMOTE_TOOLS.job, action: "status", job: name } }
                : {}),
              reason: definitelyNotStarted
                ? "This request did not cross its start fence. Existing reservations were preserved"
                : "Execution outcome is unknown. Inspect this exact handle before starting new work",
            },
          }),
        },
      ],
      details: {
        job: name,
        connectionId: intent.connectionId,
        cwd,
        owner: intent.owner,
        nativeId: job?.nativeId ?? intent.nativeId,
        installationId: client.installationId,
        scopeId: scope.scopeId,
        ...(!definitelyNotStarted ? { remoteState: "unknown" as const } : {}),
      },
      isError: true,
    };
  } finally {
    finish();
  }
}
