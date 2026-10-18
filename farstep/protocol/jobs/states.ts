import type { JobState } from "./protocol";

export const JOB_STATE_POLICY = {
  starting: { terminal: false, exitObserved: false },
  running: { terminal: false, exitObserved: false },
  ready: { terminal: false, exitObserved: false },
  stopping: { terminal: false, exitObserved: false },
  exited: { terminal: true, exitObserved: true },
  failed: { terminal: true, exitObserved: true },
  unknown: { terminal: true, exitObserved: false },
} as const satisfies Record<JobState, { terminal: boolean; exitObserved: boolean }>;

export function isJobTerminal(state: JobState | undefined): boolean {
  return state !== undefined && JOB_STATE_POLICY[state].terminal;
}
