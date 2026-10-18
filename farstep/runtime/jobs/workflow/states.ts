import type { WorkflowStepResult } from "#farstep/protocol/workflow/workflow";

type StepPolicy = {
  terminal: boolean;
  satisfiesDependency: boolean;
  stopsQueue: boolean;
  interrupted: "blocked" | "unknown" | null;
};

export const STEP_POLICY = {
  queued: {
    terminal: false,
    satisfiesDependency: false,
    stopsQueue: false,
    interrupted: "blocked",
  },
  starting: {
    terminal: false,
    satisfiesDependency: false,
    stopsQueue: false,
    interrupted: "unknown",
  },
  running: {
    terminal: false,
    satisfiesDependency: false,
    stopsQueue: false,
    interrupted: "unknown",
  },
  succeeded: {
    terminal: true,
    satisfiesDependency: true,
    stopsQueue: false,
    interrupted: null,
  },
  failed: {
    terminal: true,
    satisfiesDependency: false,
    stopsQueue: true,
    interrupted: null,
  },
  skipped: {
    terminal: true,
    satisfiesDependency: true,
    stopsQueue: false,
    interrupted: null,
  },
  blocked: {
    terminal: true,
    satisfiesDependency: false,
    stopsQueue: false,
    interrupted: null,
  },
  cancelled: {
    terminal: true,
    satisfiesDependency: false,
    stopsQueue: false,
    interrupted: null,
  },
  unknown: {
    terminal: true,
    satisfiesDependency: false,
    stopsQueue: true,
    interrupted: null,
  },
} as const satisfies Record<WorkflowStepResult["state"], StepPolicy>;
