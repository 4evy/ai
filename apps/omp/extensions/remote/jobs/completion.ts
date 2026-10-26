import { run } from "@ai/core/effect/effect";
import { readText } from "@ai/core/text/text";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { Deferred } from "effect";
import type { Gateway } from "farstep/client/jobs/gateway";
import type {
  JobCompletionNotification,
  JobSnapshot,
} from "farstep/protocol/jobs/protocol";
import { REMOTE_TOOLS } from "farstep/remote/tools/names";
import { assertIdentity } from "./broker";
import { COMPLETION_TYPE, ENTRY_TYPE, JOB_RECORD_VERSION, nativeKey } from "./records";
import type { JobSession } from "./session";
import type { DeliveryRecord, JobRecord, JobView, Result, Scope } from "./types";

export async function deliverCompletion(
  session: JobSession,
  api: ExtensionAPI,
  scope: Scope,
  client: Gateway,
  notification: JobCompletionNotification,
): Promise<void> {
  assertCompletion(session, scope, client, notification);
  const completed = notification.snapshot;
  // Internal sudo calls return synchronously and have no user-addressable handles
  if (completed.name.startsWith("remote-sudo-internal-")) return;
  const key = nativeKey(client.installationId, scope.scopeId, completed.id);
  const firstWait = foregroundWait(session, scope, completed.name);
  if (firstWait) await firstWait;
  if (scope.deliveries.get(key)?.delivered) return;
  const { job, view, unavailable } = await completionView(
    session,
    scope,
    client,
    completed,
  );
  const dispatchWait = foregroundWait(session, scope, completed.name);
  if (dispatchWait) await dispatchWait;
  if (scope.deliveries.get(key)?.delivered) return;
  const deliveredAt = Date.now();
  const finishedAt = completed.exitedAt;
  let result: Result;
  if (job && view) {
    // Rebase unread bytes only at dispatch, after any concurrent foreground response
    result = session.result(scope, job, view.snapshot, view.logs, {
      consume: false,
      finishedAt,
      deliveredAt,
    });
  } else {
    result = unavailableResult(scope, client, completed, unavailable, deliveredAt);
  }

  api.sendMessage(
    {
      customType: COMPLETION_TYPE,
      content: result.content,
      // The custom renderer separates completion status from retained output
      display: true,
      details: { ...result.details, completionId: notification.completionId },
    },
    // Aside reaches the next step boundary without interrupting an in-flight tool
    { deliverAs: "aside", triggerTurn: true },
  );
  if (job && view) {
    session.consume(scope, job, view.snapshot, view.logs, {
      markDelivered: true,
      completionId: notification.completionId,
      deliveredAt,
    });
  } else {
    recordUnavailableDelivery(api, scope, client, notification, key, deliveredAt);
  }
  // The caller acknowledges upstream only after this accepted, persisted delivery
}

function foregroundWait(
  session: JobSession,
  scope: Scope,
  name: string,
): Promise<void> | undefined {
  if (!scope.foreground.has(name)) return undefined;
  return wait();

  async function wait(): Promise<void> {
    for (;;) {
      const foreground = scope.foreground.get(name);
      if (!foreground) break;
      await run(Deferred.await(foreground.done));
      session.assertCurrent(scope);
    }
  }
}

async function completionView(
  session: JobSession,
  scope: Scope,
  client: Gateway,
  completed: JobSnapshot,
) {
  const record = scope.all.get(completed.name);
  let job: JobRecord | undefined;
  let view: JobView | undefined;
  let unavailable = "Managed metadata is absent from this session tree";
  if (record) {
    try {
      if (record.kind === "job") assertIdentity(record, completed);
      const inspected = await session.inspect(scope, client, record);
      job = inspected.job;
      assertIdentity(job, completed);
      view = await session.logs(scope, client, job, inspected.snapshot);
    } catch (error) {
      session.assertCurrent(scope);
      unavailable = `Managed metadata/logs could not be used: ${toError(error).message}`;
    }
  }
  return { job, view, unavailable };
}

function unavailableResult(
  scope: Scope,
  client: Gateway,
  completed: JobSnapshot,
  unavailable: string,
  deliveredAt: number,
): Result {
  const finishedAt = completed.exitedAt;
  const code = completed.exitCode;
  return {
    content: [
      {
        type: "text",
        text: readText(
          new URL("./completion/completion.md", import.meta.url),
          "completion",
          {
            JOB: String(completed.name),
            STATE: String(completed.state),
            CODE: String(code ?? "unknown"),
            UNAVAILABLE: String(unavailable),
            JOB_TOOL: REMOTE_TOOLS.job,
            FINISHED: String(
              finishedAt === undefined
                ? ""
                : `\nFinished at ${new Date(finishedAt).toISOString()} · delivered at ${new Date(deliveredAt).toISOString()} · delay ${Math.max(0, deliveredAt - finishedAt)} ms`,
            ),
          },
        ),
      },
    ],
    details: {
      job: completed.name,
      nativeId: completed.id,
      owner: scope.owner,
      installationId: client.installationId,
      scopeId: scope.scopeId,
      remoteState: code === undefined ? "unknown" : "completed",
      newOutput: "",
      compact: true,
      deliveredAt,
      ...(finishedAt !== undefined
        ? { finishedAt, deliveryDelayMs: Math.max(0, deliveredAt - finishedAt) }
        : {}),
      ...(code !== undefined ? { remoteExitCode: code, exitCode: code } : {}),
      lifetime: completed.persist ? "persist" : "session",
    },
    isError: code === undefined || code !== 0,
  };
}

function recordUnavailableDelivery(
  api: ExtensionAPI,
  scope: Scope,
  client: Gateway,
  notification: JobCompletionNotification,
  key: string,
  deliveredAt: number,
): void {
  const completed = notification.snapshot;
  const finishedAt = completed.exitedAt;
  const delivery: DeliveryRecord = {
    ...scope.deliveries.get(key),
    version: JOB_RECORD_VERSION,
    kind: "delivery",
    name: completed.name,
    owner: scope.owner,
    installationId: client.installationId,
    scopeId: scope.scopeId,
    nativeId: completed.id,
    delivered: true,
    completionId: notification.completionId,
    deliveredAt,
    ...(finishedAt !== undefined ? { finishedAt } : {}),
    ...(completed.exitCode !== undefined ? { remoteExitCode: completed.exitCode } : {}),
  };
  scope.deliveries.set(key, delivery);
  api.appendEntry(ENTRY_TYPE, delivery);
}

function assertCompletion(
  session: JobSession,
  scope: Scope,
  client: Gateway,
  notification: JobCompletionNotification,
): void {
  session.assertCurrent(scope);
  if (
    notification.owner !== scope.owner ||
    notification.snapshot.owner !== scope.owner ||
    client.scopeId !== scope.scopeId
  )
    throw new Error("Remote completion owner/scope mismatch");
}
