import { errorMessage } from "@ai/values/error/error";
import * as v from "valibot";
import {
  jsonValueSchema,
  type WorkflowOutput,
  type WorkflowOutputPolicy,
  type workflowOutputPolicySchema,
} from "#farstep/protocol/workflow/workflow";

import type { Captured } from "./types";

export function errorText(error: unknown): string {
  const message =
    error instanceof v.ValiError
      ? (error.issues[0]?.message ?? "Invalid JSON value")
      : errorMessage(error);
  return message.slice(0, 1024).replaceAll("\0", "\\0");
}

export function parseMachine(
  stdout: Captured,
  policy: WorkflowOutputPolicy,
): Pick<WorkflowOutput, "state" | "value" | "records" | "error"> {
  if (stdout.bytes > policy.maxBytes) {
    return {
      state: "oversized",
      error: `stdout exceeds maxBytes (${policy.maxBytes}); inspect the stdout artifact`,
    };
  }
  if (stdout.artifact?.truncated) {
    return {
      state: "truncated",
      error: `stdout exceeds maxCaptureBytes (${policy.maxCaptureBytes}); machine output is incomplete`,
    };
  }
  try {
    // Keep a BOM in the input: JSON syntax does not admit a leading U+FEFF
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      stdout.preview,
    );
    if (policy.format === "json") {
      return { state: "complete", value: v.parse(jsonValueSchema, JSON.parse(text)) };
    }
    const records: NonNullable<WorkflowOutput["records"]> = [];
    let start = 0;
    while (start < text.length) {
      if (records.length === policy.maxRecords) {
        return {
          state: "oversized",
          error: `stdout exceeds maxRecords (${policy.maxRecords}); inspect the stdout artifact`,
        };
      }
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      try {
        records.push(v.parse(jsonValueSchema, JSON.parse(text.slice(start, end))));
      } catch (error) {
        return {
          state: "invalid",
          error: `Invalid JSONL record ${records.length + 1}: ${errorText(error)}`,
        };
      }
      start = newline === -1 ? text.length : end + 1;
    }
    return { state: "complete", records };
  } catch (error) {
    return {
      state: "invalid",
      error: `Invalid ${policy.format} stdout: ${errorText(error)}`,
    };
  }
}

export function textCaptureResult(
  output: WorkflowOutput,
  stdout: Captured,
  stderr: Captured,
  previewLimited: boolean,
  policy: v.InferOutput<typeof workflowOutputPolicySchema>,
): WorkflowOutput {
  if (stdout.artifact?.truncated || stderr.artifact?.truncated) {
    return {
      ...output,
      state: "truncated",
      error: `Output artifact exceeds maxCaptureBytes (${policy.maxCaptureBytes}); retained files contain prefixes only`,
    };
  }
  if (
    stdout.bytes > policy.maxBytes ||
    stderr.bytes > policy.maxBytes ||
    previewLimited
  ) {
    return {
      ...output,
      state: "oversized",
      error: `Text preview exceeds maxBytes (${policy.maxBytes}); inspect the output artifacts`,
    };
  }
  return output;
}
