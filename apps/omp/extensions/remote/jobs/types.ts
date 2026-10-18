import type { AgentToolResult, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import type { Deferred } from "effect";
import type {
  JobLogs,
  JobReceipt,
  TerminationResult,
  TerminationStatus,
} from "farstep/protocol/jobs/gateway";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import type { WorkflowResult } from "farstep/protocol/workflow/workflow";
import type { remoteDefinitions } from "farstep/remote/remote";
import type * as v from "valibot";
import type { deliverySchema, jobSchema, launchRecordSchema } from "./records";

export type RunInput = v.InferOutput<typeof remoteDefinitions.run.parameters>;
export type BatchInput = v.InferOutput<typeof remoteDefinitions.batch.parameters>;

export { JOB_ACTIONS, MAX_SEQUENCE_STEPS } from "farstep/remote/jobs/actions";

export type JobInput = v.InferOutput<typeof remoteDefinitions.job.parameters>;

export interface RemoteJobDetails extends BashToolDetails {
  workflow?: WorkflowResult | undefined;
  job?: string | undefined;
  connectionId?: string | undefined;
  cwd?: string | undefined;
  remoteExitCode?: number | undefined;
  remoteState?: "running" | "completed" | "unknown" | undefined;
  state?: JobSnapshot["state"] | undefined;
  lifetime?: "session" | "persist" | undefined;
  cursor?: number | undefined;
  waitTimedOut?: boolean | undefined;
  matched?: string | undefined;
  completionId?: string | undefined;
  owner?: string | undefined;
  nativeId?: string | undefined;
  installationId?: string | undefined;
  scopeId?: string | undefined;
  terminalRows?: string[] | undefined;
  terminalColumns?: number | undefined;
  terminalHeight?: number | undefined;
  terminalStyleRows?: string[] | undefined;
  screenVersion?: string | undefined;
  settled?: boolean | undefined;
  receipt?: Omit<JobReceipt, "snapshot" | "logs"> | undefined;
  sequence?:
    | {
        actionId: string;
        receipts: Array<Omit<JobReceipt, "snapshot" | "logs">>;
        completedSteps: number;
        error?: string | undefined;
      }
    | undefined;
  newOutput?: string | undefined;
  rawOutput?: string | undefined;
  unreadCursor?: number | undefined;
  replay?: boolean | undefined;
  compact?: boolean | undefined;
  interpreter?: string | undefined;
  finishedAt?: number | undefined;
  deliveredAt?: number | undefined;
  deliveryDelayMs?: number | undefined;
  observedAt?: number | undefined;
  termination?: TerminationResult["termination"] | undefined;
  deadline?: TerminationStatus["deadline"] | undefined;
}

export type LaunchRecord = Readonly<v.InferOutput<typeof launchRecordSchema>>;

export type JobRecord = Readonly<v.InferOutput<typeof jobSchema>>;

export type DeliveryRecord = v.InferOutput<typeof deliverySchema>;

interface Foreground {
  count: number;
  done: Deferred.Deferred<void>;
}

export interface Scope {
  ctx: ExtensionContext;
  owner: string;
  projectDir: string;
  scopeId: string;
  branch: Map<string, LaunchRecord>;
  all: Map<string, LaunchRecord>;
  deliveries: Map<string, DeliveryRecord>;
  foreground: Map<string, Foreground>;
}

export type Logs = JobLogs & {
  rawText?: string | undefined;
  replay?: boolean | undefined;
  outputGap?: string | undefined;
  terminationStatus?: TerminationStatus | undefined;
  workflow?: WorkflowResult | undefined;
};
export interface JobView {
  snapshot: JobSnapshot;
  logs: Logs;
}
export type Result = AgentToolResult<RemoteJobDetails>;
