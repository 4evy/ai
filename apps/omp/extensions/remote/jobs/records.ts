import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { isRecord } from "@oh-my-pi/pi-utils";
import { Struct } from "effect";
import { uuidSchema } from "farstep/protocol/identity";
import { jobSpecSchema } from "farstep/protocol/jobs/gateway";
import {
  MAX_WAIT_SECONDS,
  NAME_PATTERN,
} from "farstep/remote/jobs/validation/validation";
import { readinessInputSchema } from "farstep/remote/jobs/workflow/input";
import * as v from "valibot";
import type { DeliveryRecord, LaunchRecord, Scope } from "./types";

export const ENTRY_TYPE = "remote-jobs";
export const COMPLETION_TYPE = "remote-job-completion";
export const JOB_RECORD_VERSION = 2;
export function owner(ctx: ExtensionContext): string {
  return `remote:${ctx.sessionManager.getSessionId()}:${ctx.agent.id}`;
}
export function nativeKey(
  installationId: string,
  scopeId: string,
  nativeId: string,
): string {
  return `${installationId}:${scopeId}:${nativeId}`;
}
const fingerprintSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const identityFields = {
  version: v.literal(JOB_RECORD_VERSION),
  name: v.pipe(v.string(), v.regex(NAME_PATTERN)),
  owner: v.pipe(v.string(), v.minLength(1)),
  installationId: uuidSchema,
  scopeId: fingerprintSchema,
};
export const launchSchema = v.strictObject({
  ...identityFields,
  kind: v.literal("launch"),
  projectDir: v.pipe(v.string(), v.startsWith("/")),
  connectionId: v.pipe(v.string(), v.minLength(1)),
  command: v.pipe(v.string(), v.minLength(1)),
  interpreter: v.optional(v.pipe(v.string(), v.minLength(1))),
  cwd: v.pipe(v.string(), v.startsWith("/")),
  pty: v.boolean(),
  timeoutSeconds: v.pipe(
    v.number(),
    v.finite(),
    v.minValue(0),
    v.maxValue(MAX_WAIT_SECONDS),
  ),
  createdAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
  ready: v.optional(readinessInputSchema),
  workflowFingerprint: v.optional(fingerprintSchema),
  requestId: v.optional(v.string()),
  nativeId: v.optional(v.pipe(v.string(), v.minLength(1))),
  startedAt: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  nativeCreatedAt: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  spec: jobSpecSchema,
});
export const jobSchema = v.strictObject({
  ...launchSchema.entries,
  kind: v.literal("job"),
  nativeId: v.unwrap(launchSchema.entries.nativeId),
  startedAt: v.unwrap(launchSchema.entries.startedAt),
  nativeCreatedAt: v.unwrap(launchSchema.entries.nativeCreatedAt),
});
export const launchRecordSchema = v.variant("kind", [launchSchema, jobSchema]);
export const deliverySchema = v.strictObject({
  ...identityFields,
  kind: v.literal("delivery"),
  nativeId: v.pipe(v.string(), v.minLength(1)),
  delivered: v.boolean(),
  remoteExitCode: v.optional(v.pipe(v.number(), v.safeInteger())),
  completionId: v.optional(v.pipe(v.string(), v.minLength(1))),
  outputCursor: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  decoderPending: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
      v.maxLength(4),
    ),
  ),
  terminalRedraw: v.optional(v.boolean()),
  finishedAt: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  deliveredAt: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
});

function parseEntry(
  value: unknown,
  scope: Scope,
): LaunchRecord | DeliveryRecord | undefined {
  if (
    !isRecord(value) ||
    value.version !== JOB_RECORD_VERSION ||
    value.owner !== scope.owner ||
    value.scopeId !== scope.scopeId
  )
    return;
  if (value.kind === "delivery") {
    const parsed = v.safeParse(deliverySchema, value);
    return parsed.success ? parsed.output : undefined;
  }
  const parsed = v.safeParse(launchRecordSchema, value);
  if (!parsed.success) return;
  const record = parsed.output;
  if (!matchesLaunch(record, scope)) return;
  return record;
}

function matchesLaunch(record: LaunchRecord, scope: Scope): boolean {
  return (
    record.projectDir === scope.projectDir &&
    record.name === record.spec.name &&
    record.cwd === record.spec.cwd &&
    record.pty === record.spec.pty
  );
}

export function recordInto(
  records: Map<string, LaunchRecord>,
  record: LaunchRecord,
): void {
  const previous = records.get(record.name);
  if (!previous) {
    records.set(record.name, record);
    return;
  }
  const left = Struct.omit(previous, [
    "kind",
    "nativeId",
    "startedAt",
    "nativeCreatedAt",
  ]);
  const right = Struct.omit(record, [
    "kind",
    "nativeId",
    "startedAt",
    "nativeCreatedAt",
  ]);
  if (!isDeepStrictEqual(left, right))
    throw new Error(`Conflicting immutable launch metadata for ${record.name}`);
  if (
    previous.kind === "job" &&
    ((record.nativeId !== undefined && previous.nativeId !== record.nativeId) ||
      (record.startedAt !== undefined && previous.startedAt !== record.startedAt) ||
      (record.nativeCreatedAt !== undefined &&
        previous.nativeCreatedAt !== record.nativeCreatedAt))
  )
    throw new Error(`Conflicting native identity for ${record.name}`);
  // Re-preparing a request ID cannot downgrade its confirmed native generation
  if (previous.kind === "job" && record.kind === "launch") return;
  records.set(record.name, record);
}

export function restoreScope(ctx: ExtensionContext): Scope {
  const projectDir = realpathSync(ctx.cwd);
  const owned = owner(ctx);
  const scope: Scope = {
    ctx,
    owner: owned,
    projectDir,
    scopeId: createHash("sha256")
      .update(owned)
      .update("\0")
      .update(projectDir)
      .digest("hex"),
    branch: new Map(),
    all: new Map(),
    deliveries: new Map(),
    foreground: new Map(),
  };
  for (const entry of ctx.sessionManager.getEntries()) {
    const data = entryData(entry);
    const parsed = parseEntry(data, scope);
    if (!parsed) continue;
    if (parsed.kind === "delivery") {
      restoreDelivery(scope, parsed);
    } else recordInto(scope.all, parsed);
  }
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const parsed = parseEntry(entry.data, scope);
    if (parsed && parsed.kind !== "delivery") recordInto(scope.branch, parsed);
  }
  return scope;
}

function entryData(entry: SessionEntry): unknown {
  if (entry.type === "custom" && entry.customType === ENTRY_TYPE) return entry.data;
  else if (
    entry.type === "custom_message" &&
    entry.customType === COMPLETION_TYPE &&
    isRecord(entry.details)
  ) {
    return {
      version: JOB_RECORD_VERSION,
      kind: "delivery",
      delivered: true,
      name: entry.details.job,
      owner: entry.details.owner,
      nativeId: entry.details.nativeId,
      installationId: entry.details.installationId,
      scopeId: entry.details.scopeId,
      remoteExitCode: entry.details.remoteExitCode,
      completionId: entry.details.completionId,
      outputCursor: entry.details.unreadCursor ?? entry.details.cursor,
      finishedAt: entry.details.finishedAt,
      deliveredAt: entry.details.deliveredAt,
    };
  }
  return undefined;
}

function restoreDelivery(scope: Scope, parsed: DeliveryRecord): void {
  const key = nativeKey(parsed.installationId, parsed.scopeId, parsed.nativeId);
  const previous = scope.deliveries.get(key);
  if (previous && (previous.name !== parsed.name || previous.owner !== parsed.owner))
    return;
  scope.deliveries.set(key, mergeDelivery(previous, parsed));
}

function mergeDelivery(
  previous: DeliveryRecord | undefined,
  parsed: DeliveryRecord,
): DeliveryRecord {
  return {
    ...previous,
    ...parsed,
    delivered: Boolean(previous?.delivered || parsed.delivered),
    outputCursor: Math.max(previous?.outputCursor ?? 0, parsed.outputCursor ?? 0),
    decoderPending: decoderPending(previous, parsed),
    terminalRedraw: Boolean(previous?.terminalRedraw || parsed.terminalRedraw),
  };
}

function decoderPending(
  previous: DeliveryRecord | undefined,
  parsed: DeliveryRecord,
): string | undefined {
  const advancing =
    parsed.outputCursor !== undefined &&
    parsed.outputCursor >= (previous?.outputCursor ?? 0);
  return advancing ? parsed.decoderPending : previous?.decoderPending;
}
