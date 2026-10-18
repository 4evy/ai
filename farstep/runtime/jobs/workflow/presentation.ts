import { readText } from "@ai/core/text/text";
import { Struct } from "effect";
import * as v from "valibot";
import {
  type WorkflowResult,
  workflowResultSchema,
} from "#farstep/protocol/workflow/workflow";

const MAX_INLINE_OUTPUT_BYTES = 1024 * 1024;

export function presentResult(
  result: WorkflowResult,
  selectedStep?: string,
): WorkflowResult {
  if (selectedStep)
    return v.parse(workflowResultSchema, {
      ...result,
      steps: result.steps.filter((step) => step.id === selectedStep),
    });
  let remaining = MAX_INLINE_OUTPUT_BYTES;
  const steps = result.steps.map((step) => {
    if (!step.output) return step;
    const bytes = Buffer.byteLength(
      JSON.stringify({
        stdoutText: step.output.stdoutText,
        stderrText: step.output.stderrText,
        value: step.output.value,
        records: step.output.records,
      }),
    );
    if (bytes <= remaining) {
      remaining -= bytes;
      return step;
    }
    const output = {
      ...Struct.omit(step.output, ["stdoutText", "stderrText", "value", "records"]),
      inlineOmitted: true,
      error: [
        step.output.error,
        readText(new URL("./workflow.md", import.meta.url), "preview", {
          STEP: String(step.id),
        }),
      ]
        .filter(Boolean)
        .join("; "),
    };
    return { ...step, output };
  });
  return v.parse(workflowResultSchema, { ...result, steps });
}
