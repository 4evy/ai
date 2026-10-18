import { readText } from "@ai/core/text/text";
import type {
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { terminalSize } from "farstep/client/terminal/terminal";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
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
  let termination: RemoteJobDetails["termination"];
  let receipt: RemoteJobDetails["receipt"];
  let notice: string | undefined;
  const recoverCancellation = async (): Promise<Result | undefined> => {
    if (job && signal?.aborted && session.isCurrent(scope)) {
      try {
        client = await session.forRecord(scope, job);
        const current = await session.inspect(scope, client, job);
        const stopped = await session.stop(scope, client, job, current.snapshot);
        const view = await session.logs(scope, client, job, stopped.snapshot);
        return session.result(scope, job, view.snapshot, view.logs, {
          notice: `Caller canceled the observation. ${stopped.notice}`,
          markDelivered: true,
          termination: stopped.termination,
          receipt: stopped.receipt,
          raw: input.raw,
          compact: input.compact,
        });
      } catch {
        // A lost channel cannot establish cancellation or completion
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
      // Inspection is safe even when the start request failed after spawning
      notice = `The native start did not return a successful response: ${
        toError(error).message
      }. The command was not retried`;
      client = await session.forRecord(scope, intent);
    }
    ({ job, snapshot } = await session.inspect(scope, client, intent));
    assertLaunchSize(snapshot, size);
    if (signal?.aborted) {
      const stopped = await session.stop(scope, client, job, snapshot);
      snapshot = stopped.snapshot;
      termination = stopped.termination;
      receipt = stopped.receipt;
      notice = `Caller canceled the observation. ${stopped.notice}`;
    }
    const { view, screen } = await observeLaunch(
      session,
      scope,
      client,
      job,
      snapshot,
      input,
      signal?.aborted ? 0 : waitMs,
      signal,
      onUpdate,
    );
    return session.result(scope, job, view.snapshot, view.logs, {
      notice,
      markDelivered: true,
      termination,
      receipt,
      screen,
      ...("screenVersion" in view
        ? { screenVersion: view.screenVersion, settled: view.settled }
        : {}),
      raw: input.raw,
      compact: input.compact,
    });
  } catch (error) {
    const recovered = await recoverCancellation();
    if (recovered) return recovered;
    return {
      content: [
        {
          type: "text",
          text: readText(new URL("./launch.md", import.meta.url), "unknown", {
            JOB: String(name),
            NOTICE: String(notice ? `${notice}\n` : ""),
            ERROR: String(toError(error).message),
          }),
        },
      ],
      details: {
        job: name,
        connectionId: intent.connectionId,
        cwd,
        installationId: client.installationId,
        scopeId: scope.scopeId,
        remoteState: "unknown",
      },
      isError: true,
    };
  } finally {
    finish();
  }
}
