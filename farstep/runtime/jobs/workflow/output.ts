import { run } from "@ai/core/effect/effect";
import { boundedText } from "@ai/core/text/utf8";
import { Deferred, Effect } from "effect";
import * as v from "valibot";
import {
  type WorkflowOutput,
  type WorkflowOutputPolicy,
  workflowOutputPolicySchema,
} from "#farstep/protocol/workflow/workflow";

import { prepareFiles } from "./output/artifacts";
import { errorText, parseMachine, textCaptureResult } from "./output/parsing";
import { StreamCapture } from "./output/stream";
import type { CaptureState, Child, Options, WorkflowCapture } from "./output/types";

export type { WorkflowCapture } from "./output/types";

const LIVE_BYTES = 64 * 1024;

class OutputCapture implements WorkflowCapture {
  readonly done: Promise<WorkflowOutput>;
  private readonly policy: WorkflowOutputPolicy;
  private live = "";
  private observerError: string | undefined;
  private echo: ((text: string) => void) | undefined;
  private readonly state: CaptureState = {
    aborted: undefined,
    stopped: Deferred.makeUnsafe<void>(),
    emit: (text) => this.emit(text),
  };
  constructor(child: Child, options: Options) {
    this.policy = v.parse(workflowOutputPolicySchema, options.policy);
    this.echo = options.echo;
    this.done = run(this.complete(child, options));
  }

  readonly log = (): string => this.live;

  readonly abort = async (reason: string): Promise<void> => {
    this.state.aborted ??= reason;
    await run(Deferred.succeed(this.state.stopped, undefined));
    await this.done;
  };

  private emit(text: string): void {
    if (!text) return;
    this.live += text;
    if (Buffer.byteLength(this.live) > LIVE_BYTES) {
      const encoded = Buffer.from(this.live);
      let start = encoded.length - LIVE_BYTES;
      while (start < encoded.length && ((encoded[start] ?? 0) & 0xc0) === 0x80) start++;
      this.live = new TextDecoder().decode(encoded.subarray(start));
    }
    const echo = this.echo;
    if (echo) {
      try {
        echo(text);
      } catch (error) {
        this.observerError = `Output observer failed: ${errorText(error)}`;
        this.echo = undefined;
      }
    }
  }

  private complete(child: Child, options: Options) {
    return Effect.gen({ self: this }, function* () {
      const initialized = yield* prepareFiles(options);
      const [stdout, stderr] = yield* Effect.all(
        [
          new StreamCapture(
            child.stdout,
            "stdout",
            initialized.stdout,
            this.policy,
            this.state,
          ).runEffect(),
          new StreamCapture(
            child.stderr,
            "stderr",
            initialized.stderr,
            this.policy,
            this.state,
          ).runEffect(),
        ],
        { concurrency: "unbounded" },
      );
      const stdoutText = boundedText(stdout.preview, this.policy.maxBytes);
      const stderrText = boundedText(stderr.preview, this.policy.maxBytes);
      const output: WorkflowOutput = {
        format: this.policy.format,
        state: "complete",
        ...(stdout.artifact ? { stdout: stdout.artifact } : {}),
        ...(stderr.artifact ? { stderr: stderr.artifact } : {}),
        stdoutText: stdoutText.text,
        stderrText: stderrText.text,
      };
      const errors = [
        initialized.error,
        stdout.error,
        stderr.error,
        this.observerError,
      ].filter((value): value is string => value !== undefined);
      if (errors.length > 0)
        return {
          ...output,
          state: "invalid",
          error: errors.join("; "),
        } satisfies WorkflowOutput;
      if (this.policy.format !== "text")
        return { ...output, ...parseMachine(stdout, this.policy) };
      return textCaptureResult(
        output,
        stdout,
        stderr,
        stdoutText.limited || stderrText.limited,
        this.policy,
      );
    });
  }
}

export function startCapture(child: Child, options: Options): WorkflowCapture {
  return new OutputCapture(child, options);
}
