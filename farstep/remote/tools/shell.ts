import { isRecord } from "@ai/values/value/value";
import * as v from "valibot";

export const scriptArguments = {
  resolveCommand: (args: unknown) =>
    isRecord(args) && typeof args.script === "string" ? args.script : undefined,
  resolveCwd: (args: unknown) =>
    isRecord(args) && typeof args.cwd === "string" ? args.cwd : undefined,
};

// Privileged sudo requests have a separate shell transport and credential frame
export const shellArguments = {
  ...scriptArguments,
  resolveCommand: (args: unknown) =>
    isRecord(args) && typeof args.command === "string" ? args.command : undefined,
};

export function commandFields() {
  return {
    connection: v.pipe(v.string(), v.minLength(1)),
    command: v.pipe(v.string(), v.minLength(1)),
    cwd: v.optional(v.string()),
  };
}
