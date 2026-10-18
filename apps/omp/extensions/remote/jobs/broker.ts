import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import { isJobTerminal } from "farstep/protocol/jobs/states";
import type { JobRecord } from "./types";

export function terminal(snapshot: JobSnapshot): boolean {
  return isJobTerminal(snapshot.state);
}

export function assertIdentity(job: JobRecord, snapshot: JobSnapshot): void {
  if (
    snapshot.name !== job.name ||
    snapshot.owner !== job.owner ||
    snapshot.id !== job.nativeId ||
    snapshot.startedAt !== job.startedAt ||
    snapshot.createdAt !== job.nativeCreatedAt
  ) {
    throw new Error(
      `Native identity for ${
        job.name
      } changed; refusing to control a replaced or restarted process`,
    );
  }
}
