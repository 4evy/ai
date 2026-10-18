import type { FileHandle } from "node:fs/promises";
import type { Deferred } from "effect";
import type {
  WorkflowArtifact,
  WorkflowOutput,
  WorkflowOutputPolicy,
} from "#farstep/protocol/workflow/workflow";

export type Child = Pick<Bun.Subprocess<"ignore", "pipe", "pipe">, "stdout" | "stderr">;
export type Options = {
  directory: string;
  id: string;
  policy: WorkflowOutputPolicy;
  echo?: ((text: string) => void) | undefined;
};
export type Sink = { path: string; file: FileHandle };
export type Files = { stdout?: Sink; stderr?: Sink; error?: string };
export type Captured = {
  artifact?: WorkflowArtifact;
  bytes: number;
  preview: Uint8Array;
  error?: string;
};

export interface WorkflowCapture {
  done: Promise<WorkflowOutput>;
  log(): string;
  abort(reason: string): Promise<void>;
}

export type CaptureState = {
  aborted: string | undefined;
  stopped: Deferred.Deferred<void>;
  emit(text: string): void;
};
