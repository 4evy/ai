import { objectSchema } from "@ai/values/schema/input";
import { Record as Records } from "effect";
import * as v from "valibot";
import { uuidSchema } from "./identity";

export const COORDINATION_CAPABILITY = "coordination-v1";
const text = (max: number) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(max),
    v.excludes("\0", "NUL is not allowed"),
  );
const token = v.pipe(text(128), v.regex(/^[A-Za-z0-9._:-]+$/u));
const integer = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const limit = v.optional(v.pipe(integer, v.minValue(1), v.maxValue(100)), 50);
const status = v.picklist(["open", "in_progress", "blocked", "done"]);
const mutation = { requestId: v.optional(token) };
const page = { cursor: v.optional(integer, 0), limit };

export const coordinationOpenSchema = v.strictObject({
  project: text(4096),
  sessionId: token,
  agentId: token,
  parentSession: v.optional(token),
  purpose: v.optional(text(1024)),
});
export type CoordinationOpen = v.InferOutput<typeof coordinationOpenSchema>;

const coordinationActionSchema = v.variant("action", [
  v.strictObject({
    action: v.literal("snapshot"),
    allProjects: v.optional(v.boolean(), false),
    ...page,
  }),
  v.strictObject({ action: v.literal("session"), purpose: text(1024), ...mutation }),
  v.strictObject({
    action: v.literal("work"),
    work: v.optional(uuidSchema),
    title: v.optional(text(512)),
    status: v.optional(status),
    blockers: v.optional(v.pipe(v.array(text(512)), v.maxLength(16))),
    ...mutation,
  }),
  v.strictObject({
    action: v.literal("claim"),
    work: uuidSchema,
    resources: v.optional(v.pipe(v.array(text(1024)), v.maxLength(64))),
    ttlSeconds: v.optional(v.pipe(integer, v.minValue(30), v.maxValue(86400)), 3600),
    ...mutation,
  }),
  v.strictObject({ action: v.literal("release"), work: uuidSchema, ...mutation }),
  v.strictObject({
    action: v.literal("link"),
    work: uuidSchema,
    job: text(256),
    ...mutation,
  }),
  v.strictObject({
    action: v.literal("note"),
    body: text(8192),
    work: v.optional(uuidSchema),
    recipient: v.optional(uuidSchema),
    thread: v.optional(uuidSchema),
    ...mutation,
  }),
  v.strictObject({ action: v.literal("inbox"), ...page }),
  v.strictObject({ action: v.literal("acknowledge"), note: uuidSchema, ...mutation }),
  v.strictObject({
    action: v.literal("thread"),
    thread: v.optional(uuidSchema),
    work: v.optional(uuidSchema),
    query: v.optional(text(512)),
    ...page,
  }),
  v.strictObject({
    action: v.literal("handoff"),
    work: uuidSchema,
    recipient: uuidSchema,
    body: text(8192),
    ...mutation,
  }),
  v.strictObject({ action: v.literal("events"), ...page }),
]);
export const COORDINATION_ACTIONS = {
  snapshot: { approval: "read", refreshJobs: true },
  session: { approval: "exec", refreshJobs: false },
  work: { approval: "exec", refreshJobs: false },
  claim: { approval: "exec", refreshJobs: false },
  release: { approval: "exec", refreshJobs: false },
  link: { approval: "exec", refreshJobs: false },
  note: { approval: "exec", refreshJobs: false },
  inbox: { approval: "read", refreshJobs: true },
  acknowledge: { approval: "exec", refreshJobs: false },
  thread: { approval: "read", refreshJobs: true },
  handoff: { approval: "exec", refreshJobs: false },
  events: { approval: "read", refreshJobs: true },
} as const satisfies Record<
  v.InferOutput<typeof coordinationActionSchema>["action"],
  { approval: "read" | "exec"; refreshJobs: boolean }
>;

export const coordinationRequestInputSchema = v.object({
  action: v.picklist(Records.keys(COORDINATION_ACTIONS)),
  allProjects: v.optional(v.boolean()),
  limit,
  cursor: v.optional(integer),
  requestId: v.optional(token),
  purpose: v.optional(text(1024)),
  work: v.optional(uuidSchema),
  title: v.optional(text(512)),
  status: v.optional(status),
  blockers: v.optional(v.pipe(v.array(text(512)), v.maxLength(16))),
  resources: v.optional(v.pipe(v.array(text(1024)), v.maxLength(64))),
  ttlSeconds: v.optional(v.pipe(integer, v.minValue(30), v.maxValue(86400))),
  body: v.optional(text(8192)),
  recipient: v.optional(uuidSchema),
  thread: v.optional(uuidSchema),
  note: v.optional(uuidSchema),
  query: v.optional(text(512)),
  job: v.optional(text(256)),
});
export const coordinationRequestSchema = objectSchema(
  coordinationActionSchema,
  coordinationRequestInputSchema,
);
export type CoordinationRequest = v.InferOutput<typeof coordinationRequestSchema>;

export const coordinationSessionSchema = v.strictObject({
  id: uuidSchema,
  project: text(4096),
  actor: text(512),
  sessionId: token,
  agentId: token,
  parentSession: v.optional(token),
  purpose: v.optional(text(1024)),
  openedAt: integer,
  lastSeenAt: integer,
  presence: v.picklist(["active", "stale", "disconnected", "closed"]),
});
export const coordinationWorkSchema = v.strictObject({
  id: uuidSchema,
  project: text(4096),
  title: text(512),
  status,
  blockers: v.pipe(v.array(text(512)), v.maxLength(16)),
  createdBy: text(512),
  owner: v.optional(text(512)),
  createdAt: integer,
  updatedAt: integer,
});
export const coordinationClaimSchema = v.strictObject({
  work: uuidSchema,
  project: text(4096),
  actor: text(512),
  resources: v.pipe(v.array(text(1024)), v.maxLength(64)),
  acquiredAt: integer,
  expiresAt: integer,
});
export const coordinationJobSchema = v.strictObject({
  project: text(4096),
  actor: text(512),
  owner: text(512),
  scopeId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  installationId: uuidSchema,
  name: text(256),
  nativeId: v.optional(text(256)),
  cwd: text(4096),
  kind: v.picklist(["command", "workflow"]),
  lifetime: v.picklist(["session", "persist"]),
  state: v.picklist(["starting", "running", "stopped", "failed", "unknown"]),
  availability: v.picklist(["available", "unavailable"]),
  work: v.optional(uuidSchema),
  createdAt: integer,
  updatedAt: integer,
  startedAt: v.optional(integer),
  stoppedAt: v.optional(integer),
  exitCode: v.optional(v.pipe(v.number(), v.safeInteger())),
  reason: v.optional(text(256)),
});
export type CoordinationJob = v.InferOutput<typeof coordinationJobSchema>;
export const coordinationNoteSchema = v.strictObject({
  id: uuidSchema,
  sequence: integer,
  project: text(4096),
  actor: text(512),
  thread: uuidSchema,
  body: text(8192),
  work: v.optional(uuidSchema),
  recipient: v.optional(uuidSchema),
  createdAt: integer,
  acknowledgedAt: v.optional(integer),
  kind: v.picklist(["note", "handoff"]),
});
export const coordinationEventSchema = v.strictObject({
  id: integer,
  project: text(4096),
  actor: text(512),
  action: text(64),
  createdAt: integer,
  session: v.optional(uuidSchema),
  work: v.optional(uuidSchema),
  note: v.optional(uuidSchema),
  job: v.optional(text(256)),
});
export const coordinationResultSchema = v.strictObject({
  cursor: integer,
  session: v.optional(coordinationSessionSchema),
  sessions: v.optional(v.pipe(v.array(coordinationSessionSchema), v.maxLength(100))),
  work: v.optional(coordinationWorkSchema),
  works: v.optional(v.pipe(v.array(coordinationWorkSchema), v.maxLength(100))),
  claims: v.optional(v.pipe(v.array(coordinationClaimSchema), v.maxLength(100))),
  jobs: v.optional(v.pipe(v.array(coordinationJobSchema), v.maxLength(100))),
  notes: v.optional(v.pipe(v.array(coordinationNoteSchema), v.maxLength(100))),
  events: v.optional(v.pipe(v.array(coordinationEventSchema), v.maxLength(100))),
  conflicts: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          work: uuidSchema,
          actor: text(512),
          resource: v.optional(text(1024)),
          expiresAt: integer,
        }),
      ),
      v.maxLength(65),
    ),
  ),
  pagination: v.optional(v.strictObject({ nextCursor: integer, hasMore: v.boolean() })),
  truncated: v.optional(
    v.strictObject({
      sessions: v.boolean(),
      works: v.boolean(),
      claims: v.boolean(),
      jobs: v.boolean(),
    }),
  ),
});
export type CoordinationResult = v.InferOutput<typeof coordinationResultSchema>;
