import { join } from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import type { JobOperation } from "farstep/protocol/jobs/protocol";
import { JOB_STATE_POLICY } from "farstep/protocol/jobs/states";
import * as v from "valibot";
import {
  type ActionReceipt,
  type ActionRequest,
  actionRequestSchema,
  type JobObservation,
  type observeRequestSchema,
  receiptRequestSchema,
  type TerminationRequest,
  type TerminationResult,
  terminationRequestSchema,
} from "#farstep/protocol/jobs/gateway";
import { privateRead } from "../state";
import type { JobBrokerClient } from "./broker/client";

type ExecutionRequest = {
  name: string;
  nativeId: string;
  actionId: string;
  settleMs: number;
  maxWaitMs: number;
  expectedScreenVersion?: string | undefined;
};

function processTree(root: Process): Process[] {
  const processes = [root];
  for (const current of processes) {
    processes.push(...current.children());
  }
  return processes;
}

import { JobObserver, screenChanged } from "./actions/observation";
import { ActionRecords, withJobLock, writeActionRecord } from "./actions/records";

export class JobActions {
  private readonly records: ActionRecords;
  private readonly observer: JobObserver;

  constructor(
    private readonly broker: JobBrokerClient,
    directory: string,
    private readonly scopeId: string,
    private readonly owner: string,
    private readonly installationId: string,
  ) {
    this.records = new ActionRecords(directory, scopeId, owner, installationId);
    this.observer = new JobObserver(broker, installationId, scopeId, (name, nativeId) =>
      this.bind(name, nativeId),
    );
  }

  observe(input: v.InferInput<typeof observeRequestSchema>): Promise<JobObservation> {
    return this.observer.observe(input);
  }

  async bind(name: string, nativeId?: string) {
    const response = await this.broker.request({ op: "describe", name });
    if (
      response.snapshot.owner !== this.owner ||
      (nativeId !== undefined && response.snapshot.id !== nativeId)
    )
      throw new Error("Job identity or remote owner mismatch");
    return response.snapshot;
  }

  async mutate<T>(name: string, nativeId: string, work: () => Promise<T>): Promise<T> {
    return withJobLock(await this.records.directory(name, nativeId), async () => {
      await this.bind(name, nativeId);
      return work();
    });
  }

  async receipt(
    input: v.InferInput<typeof receiptRequestSchema>,
  ): Promise<ActionReceipt> {
    const request = v.parse(receiptRequestSchema, input);
    const directory = await this.records.directory(request.name, request.nativeId);
    const record = await this.records.read(
      this.records.path(directory, request.actionId),
      request.name,
      request.nativeId,
      request.actionId,
    );
    // A retained receipt can be recovered even after the snapshot was removed/replaced
    if (record) return record.receipt;
    await this.bind(request.name, request.nativeId);
    return { ...request, state: "not-sent", createdAt: Date.now() };
  }

  private async beforeAction(
    request: ExecutionRequest,
  ): Promise<JobObservation | undefined> {
    let before: JobObservation | undefined;
    try {
      before = await this.observe({
        name: request.name,
        nativeId: request.nativeId,
        settleMs: 0,
        maxWaitMs: 0,
      });
    } catch (error) {
      // Missing before frames cannot establish change or satisfy a stale-screen guard
      if (request.expectedScreenVersion !== undefined) throw error;
    }
    return before;
  }

  private async execute(
    request: ExecutionRequest,
    operation: JobOperation,
    termination?: TerminationResult["termination"],
  ): Promise<ActionReceipt> {
    const directory = await this.records.directory(request.name, request.nativeId);
    return withJobLock(directory, async () => {
      const path = this.records.path(directory, request.actionId);
      const existing = await this.records.read(
        path,
        request.name,
        request.nativeId,
        request.actionId,
      );
      if (existing) return existing.receipt;
      await this.bind(request.name, request.nativeId);
      const receipt: ActionReceipt = {
        name: request.name,
        nativeId: request.nativeId,
        actionId: request.actionId,
        state: "not-sent",
        createdAt: Date.now(),
      };
      const record = {
        scopeId: this.scopeId,
        owner: this.owner,
        installationId: this.installationId,
        receipt,
        termination,
      };
      await writeActionRecord(path, record);
      if (termination)
        await writeActionRecord(join(directory, "termination.json"), {
          actionId: request.actionId,
        });
      const before = await this.beforeAction(request);
      if (request.expectedScreenVersion !== undefined) {
        if (before?.screenVersion !== request.expectedScreenVersion) {
          Object.assign(receipt, before, {
            error: "Screen changed; action was not sent",
          });
          await writeActionRecord(path, record);
          return receipt;
        }
      }
      const snapshot = termination
        ? await this.bind(request.name, request.nativeId)
        : undefined;
      const root = snapshot?.pid === undefined ? null : Process.fromPid(snapshot.pid);
      const tracked = root ? processTree(root) : [];
      const processAction = async () => {
        try {
          await this.broker.request(operation);
          if (termination) termination.brokerAccepted = true;
          const screen = await this.observe({
            name: request.name,
            nativeId: request.nativeId,
            settleMs: request.settleMs,
            maxWaitMs: request.maxWaitMs,
          });
          const changed = screenChanged(before, screen);
          if (changed !== undefined) receipt.screenChanged = changed;
          Object.assign(receipt, screen, { state: "processed" });
          if (termination)
            termination.leaderExited =
              JOB_STATE_POLICY[screen.snapshot.state].exitObserved;
          if (termination && tracked.length > 0)
            termination.trackedProcessesNoLongerObserved = tracked.every(
              (process) => process.status() === "exited",
            );
        } catch {
          // Transport failure cannot distinguish a broker rejection from a lost reply
          receipt.error =
            "Action outcome is uncertain; this action ID will never be sent again";
        }
      };
      // This write commits the no-replay fence before touching broker transport
      receipt.state = "sent-outcome-unknown";
      receipt.sentAt = Date.now();
      await writeActionRecord(path, record);
      await processAction();
      await writeActionRecord(path, record);
      return receipt;
    });
  }

  async action(input: ActionRequest): Promise<ActionReceipt> {
    const request = v.parse(actionRequestSchema, input);
    return this.execute(request, {
      op: "send",
      name: request.name,
      data: request.data,
      resize: request.resize,
    });
  }

  async terminate(input: TerminationRequest): Promise<TerminationResult> {
    const request = v.parse(terminationRequestSchema, input);
    const termination: TerminationResult["termination"] = {
      kind: request.kind,
      requestedAt: Date.now(),
      brokerAccepted: false,
      leaderExited: false,
      childrenGone: "unknown",
    };
    const operation: JobOperation =
      request.kind === "stop"
        ? { op: "stop", name: request.name, timeoutMs: request.timeoutMs }
        : {
            op: "send",
            name: request.name,
            signal: request.kind === "interrupt" ? "SIGINT" : "SIGKILL",
          };
    const receipt = await this.execute(
      { ...request, settleMs: 100, maxWaitMs: 500 },
      operation,
      termination,
    );
    const directory = await this.records.directory(request.name, request.nativeId);
    const record = await this.records.read(
      this.records.path(directory, request.actionId),
      request.name,
      request.nativeId,
      request.actionId,
    );
    return { receipt, termination: record?.termination ?? termination };
  }

  async termination(
    name: string,
    nativeId: string,
  ): Promise<TerminationResult["termination"] | undefined> {
    const directory = await this.records.directory(name, nativeId);
    try {
      const { actionId } = v.parse(
        v.pick(receiptRequestSchema, ["actionId"]),
        JSON.parse(await privateRead(join(directory, "termination.json"))),
      );
      const record = await this.records.read(
        this.records.path(directory, actionId),
        name,
        nativeId,
        actionId,
      );
      return record?.termination;
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  }
}
