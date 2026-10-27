import { run } from "@ai/core/effect/effect";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Deferred, Effect } from "effect";
import type { JobCompletionNotification } from "farstep/protocol/jobs/protocol";
import { JOB_COMPLETION_METHOD } from "#farstep/protocol/jobs/gateway";
import type { CoordinationRegistry } from "../coordination/registry";
import type { JobBrokerClient } from "./broker/client";

export class CompletionChannel {
  readonly disconnected = new AbortController();
  private readonly acknowledgments = new Map<string, Deferred.Deferred<void, Error>>();
  private readonly completed = Deferred.makeUnsafe<void>();
  private closed = false;
  private subscribed = false;
  private unsubscribe: ((options?: { preservePending?: boolean }) => void) | undefined;

  constructor(
    private readonly broker: JobBrokerClient,
    private readonly coordination: CoordinationRegistry,
    private readonly server: Server,
    private readonly owner: string,
  ) {}

  private async deliver(notification: JobCompletionNotification): Promise<void> {
    if (this.closed) throw new Error("Completion channel is closed");
    const pending = Deferred.makeUnsafe<void, Error>();
    this.acknowledgments.set(notification.completionId, pending);
    try {
      await this.coordination.observeJob(notification.snapshot);
      await this.server.notification({
        method: JOB_COMPLETION_METHOD,
        params: { notification },
      });
      await run(Deferred.await(pending));
    } finally {
      this.acknowledgments.delete(notification.completionId);
    }
  }

  subscribe(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.unsubscribe = this.broker.onCompletion(this.owner, (event) =>
      this.deliver(event),
    );
  }

  requireHandshake(): void {
    if (!this.subscribed)
      throw new Error("helper.handshake is required before job operations");
  }

  acknowledge(completionId: string): void {
    const pending = this.acknowledgments.get(completionId);
    if (!pending) throw new Error("Unknown or expired completion acknowledgment");
    Deferred.doneUnsafe(pending, Effect.void);
  }

  wait(): Promise<void> {
    return run(Deferred.await(this.completed));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disconnected.abort();
    this.unsubscribe?.({ preservePending: true });
    for (const pending of this.acknowledgments.values())
      Deferred.doneUnsafe(
        pending,
        Effect.fail(new Error("Completion channel closed before acknowledgment")),
      );
    this.acknowledgments.clear();
    Deferred.doneUnsafe(this.completed, Effect.void);
  }
}
