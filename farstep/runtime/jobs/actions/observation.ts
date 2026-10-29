import { isDeepStrictEqual } from "node:util";
import { attempt, run } from "@ai/runtime/effect/effect";
import { Effect } from "effect";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import { isJobTerminal } from "farstep/protocol/jobs/states";
import * as v from "valibot";
import {
  type JobLogs,
  type JobObservation,
  observeRequestSchema,
} from "#farstep/protocol/jobs/gateway";
import type { JobBrokerClient } from "../broker/client";
import { styledScreen } from "../terminal/terminal";
import { actionHash } from "./records";

async function boundedRead<T>(work: Promise<T>, deadline: number): Promise<T> {
  return run(
    attempt(() => work).pipe(
      Effect.timeoutOrElse({
        duration: Math.max(1, deadline - Date.now()),
        orElse: () => Effect.fail(new Error("Terminal observation deadline reached")),
      }),
    ),
  );
}

function comparableScreen(observation: JobObservation | undefined) {
  if (!observation) return undefined;
  const rows = observation.logs.terminalStyleRows ?? observation.logs.terminalRows;
  const size = observation.logs.terminalSize;
  if (!rows?.length || !size) return undefined;
  return { rows, size };
}

export function screenChanged(
  before: JobObservation | undefined,
  screen: JobObservation,
): boolean | undefined {
  const first = comparableScreen(before);
  const last = comparableScreen(screen);
  if (!first || !last) return undefined;
  return !isDeepStrictEqual(first, last);
}

export class JobObserver {
  constructor(
    private readonly broker: JobBrokerClient,
    private readonly installationId: string,
    private readonly scopeId: string,
    private readonly bind: (name: string, nativeId?: string) => Promise<JobSnapshot>,
  ) {}

  private async sampleScreen(request: v.InferOutput<typeof observeRequestSchema>) {
    const logsResult = await this.broker.request({
      op: "logs",
      name: request.name,
      lines: 1000,
      head: false,
      follow: false,
      timeoutMs: 0,
      renderTerminalRows: false,
    });
    return { logsResult, snapshot: await this.bind(request.name, request.nativeId) };
  }

  private screenVersion(
    request: v.InferOutput<typeof observeRequestSchema>,
    logs: JobLogs,
  ): string {
    return actionHash(
      JSON.stringify([
        this.installationId,
        this.scopeId,
        request.name,
        request.nativeId,
        logs.cursor,
        logs.terminalSize,
        logs.terminalReplay,
        logs.terminalText,
        logs.text,
      ]),
    );
  }

  async observe(
    input: v.InferInput<typeof observeRequestSchema>,
  ): Promise<JobObservation> {
    const request = v.parse(observeRequestSchema, input);
    const firstReadDeadline = Date.now() + Math.max(1000, request.maxWaitMs);
    await boundedRead(this.bind(request.name, request.nativeId), firstReadDeadline);
    let deadline = firstReadDeadline;
    let changedAt = Date.now();
    let seenFrame = false;
    let previous: JobObservation | undefined;
    const settleObservation = (
      snapshot: JobObservation["snapshot"],
      logs: JobLogs,
      screenVersion: string,
      observedAt: number,
    ): JobObservation => {
      if (
        request.waitForFrame &&
        !seenFrame &&
        logs.terminalRows?.some((row) => Bun.stripANSI(row).trim().length > 0)
      ) {
        seenFrame = true;
        changedAt = observedAt;
      }
      const settled =
        (!request.waitForFrame || seenFrame) &&
        observedAt - changedAt >= request.settleMs;
      const current = { snapshot, logs, screenVersion, settled, observedAt };
      return current;
    };
    const observationComplete = (current: JobObservation): boolean => {
      const { settled, observedAt, snapshot } = current;
      if (
        settled ||
        observedAt >= deadline ||
        (request.waitForFrame && isJobTerminal(snapshot.state))
      )
        return true;
      return false;
    };
    const waitForObservation = async (observedAt: number) => {
      await run(
        Effect.sleep(
          Math.min(
            25,
            deadline - observedAt,
            request.waitForFrame && !seenFrame
              ? 25
              : Math.max(1, request.settleMs - (observedAt - changedAt)),
          ),
        ),
      );
    };
    for (;;) {
      // No follow request can wait for silence forever, including animated spinners
      const remaining = previous ? deadline : firstReadDeadline;
      const sample = this.sampleScreen(request);
      let captured: Awaited<typeof sample>;
      try {
        captured = await boundedRead(sample, remaining);
      } catch (error) {
        if (previous && Date.now() >= deadline) return { ...previous, settled: false };
        throw error;
      }
      const { logsResult, snapshot } = captured;
      const logs: JobLogs = logsResult;
      await styledScreen(logs);
      const observedAt = Date.now();
      if (!previous) deadline = observedAt + request.maxWaitMs;
      // Include the captured replay, not a later describe/output cursor
      const screenVersion = this.screenVersion(request, logs);
      if (previous?.screenVersion !== screenVersion) changedAt = observedAt;
      const current = settleObservation(snapshot, logs, screenVersion, observedAt);
      if (observationComplete(current)) return current;
      previous = current;
      await waitForObservation(observedAt);
    }
  }
}
