import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { and, eq, gt } from "drizzle-orm";
import {
  type CoordinationJob,
  type CoordinationRequest,
  type CoordinationResult,
  coordinationJobSchema,
} from "farstep/protocol/coordination";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import * as v from "valibot";
import type { CoordinationContext, Session } from "./context";
import * as tables from "./store/tables";
import type { CoordinationWork } from "./work";

const OBSERVED_STATES = {
  starting: "starting",
  running: "running",
  ready: "running",
  stopping: "running",
  exited: "stopped",
  failed: "failed",
  unknown: "unknown",
} as const satisfies Record<JobSnapshot["state"], CoordinationJob["state"]>;

export class CoordinationJobs {
  constructor(
    private readonly context: CoordinationContext,
    private readonly works: CoordinationWork,
  ) {}

  link(
    input: Extract<CoordinationRequest, { action: "link" }>,
    session: Session,
  ): CoordinationResult {
    const work = this.works.get(input.work);
    this.works.authorize(work);
    const row = this.context.store.queries
      .select({ payload: tables.jobs.payload })
      .from(tables.jobs)
      .where(
        and(
          eq(tables.jobs.scope, this.context.scopeId),
          eq(tables.jobs.name, input.job),
          eq(tables.jobs.project, session.project),
          eq(tables.jobs.actor, this.context.owner),
        ),
      )
      .get();
    if (!row) throw new Error("Only caller-owned jobs in this project may be linked");
    const job = {
      ...v.parse(coordinationJobSchema, JSON.parse(row.payload)),
      work: work.id,
      updatedAt: Date.now(),
    };
    this.saveJob(job);
    this.context.event("link", { work: work.id, job: job.name });
    return { cursor: this.context.cursor(), work, jobs: [job] };
  }

  private saveJob(job: CoordinationJob): void {
    const parsed = v.parse(coordinationJobSchema, job);
    this.context.store.queries
      .insert(tables.jobs)
      .values({
        scope: parsed.scopeId,
        name: parsed.name,
        project: parsed.project,
        actor: parsed.actor,
        payload: JSON.stringify(parsed),
      })
      .onConflictDoUpdate({
        target: [tables.jobs.scope, tables.jobs.name],
        set: {
          payload: JSON.stringify(parsed),
          project: parsed.project,
          actor: parsed.actor,
        },
      })
      .run();
  }

  async beginJob(input: {
    name: string;
    cwd: string;
    kind: "command" | "workflow";
    lifetime: "session" | "persist";
  }): Promise<void> {
    this.context.requireSession();
    const cwd = await realpath(input.cwd);
    this.context.store.transaction(() => {
      const session = this.context.requireSession();
      const existing = this.context.store.queries
        .select({ payload: tables.jobs.payload })
        .from(tables.jobs)
        .where(
          and(
            eq(tables.jobs.scope, this.context.scopeId),
            eq(tables.jobs.name, input.name),
          ),
        )
        .get();
      if (existing) {
        const job = v.parse(coordinationJobSchema, JSON.parse(existing.payload));
        // Lifetime follows native mode changes, not reservation identity
        if (
          job.owner !== this.context.owner ||
          job.project !== session.project ||
          job.installationId !== this.context.installationId ||
          job.cwd !== cwd ||
          job.kind !== input.kind
        )
          throw new Error("Coordination job reservation identity changed");
        return;
      }
      const live = this.context.store.queries
        .select({ work: tables.claims.work })
        .from(tables.claims)
        .where(
          and(
            eq(tables.claims.project, session.project),
            eq(tables.claims.actor, this.context.owner),
            gt(tables.claims.expires, Date.now()),
          ),
        )
        .orderBy(tables.claims.work)
        .limit(2)
        .all();
      const onlyClaim = live.length === 1 ? live[0] : undefined;
      const now = Date.now();
      const job: CoordinationJob = {
        project: session.project,
        actor: this.context.owner,
        owner: this.context.owner,
        scopeId: this.context.scopeId,
        installationId: this.context.installationId,
        name: input.name,
        cwd,
        kind: input.kind,
        lifetime: input.lifetime,
        state: "starting",
        availability: "available",
        createdAt: now,
        updatedAt: now,
        ...(onlyClaim ? { work: onlyClaim.work } : {}),
      };
      this.saveJob(job);
      this.context.event("job-starting", {
        job: job.name,
        ...(job.work ? { work: job.work } : {}),
      });
    });
  }

  jobRecords(project?: string): CoordinationJob[] {
    const rows = this.context.store.queries
      .select({ payload: tables.jobs.payload })
      .from(tables.jobs)
      .where(project === undefined ? undefined : eq(tables.jobs.project, project))
      .orderBy(tables.jobs.scope, tables.jobs.name)
      .all();
    return rows.map((row) => v.parse(coordinationJobSchema, JSON.parse(row.payload)));
  }

  private assertObservedJob(
    snapshot: JobSnapshot,
    old: CoordinationJob,
    reference?: CoordinationJob,
  ): void {
    if (
      snapshot.owner !== old.owner ||
      old.installationId !== this.context.installationId ||
      (!reference && old.owner !== this.context.owner)
    )
      throw new Error("Coordination job actor or installation mismatch");
    this.assertRefreshIdentity(snapshot, old, reference);
    if (old.nativeId && old.nativeId !== snapshot.id)
      throw new Error("Coordination job native generation changed");
  }

  private assertRefreshIdentity(
    snapshot: JobSnapshot,
    old: CoordinationJob,
    reference?: CoordinationJob,
  ): void {
    if (
      reference &&
      (reference.name !== snapshot.name ||
        reference.owner !== old.owner ||
        reference.project !== old.project ||
        reference.installationId !== old.installationId ||
        (reference.nativeId !== undefined && reference.nativeId !== old.nativeId) ||
        reference.createdAt !== old.createdAt)
    )
      throw new Error("Coordination refresh job identity changed");
  }

  private observedJob(snapshot: JobSnapshot, old: CoordinationJob): CoordinationJob {
    // Native broker state is independent of the registering actor's presence
    const job: CoordinationJob = {
      ...old,
      nativeId: snapshot.id,
      state: OBSERVED_STATES[snapshot.state],
      lifetime: snapshot.persist ? "persist" : "session",
      availability: snapshot.state === "unknown" ? "unavailable" : "available",
      updatedAt: Date.now(),
      ...(snapshot.startedAt ? { startedAt: snapshot.startedAt } : {}),
      ...(snapshot.exitedAt !== undefined ? { stoppedAt: snapshot.exitedAt } : {}),
      ...(snapshot.exitCode !== undefined ? { exitCode: snapshot.exitCode } : {}),
    };
    if (snapshot.state === "unknown" && snapshot.exitReason !== undefined)
      job.reason = snapshot.exitReason;
    else delete job.reason;
    return job;
  }

  async observeJob(snapshot: JobSnapshot, reference?: CoordinationJob): Promise<void> {
    this.context.store.transaction(() => {
      const scope = reference?.scopeId ?? this.context.scopeId;
      const row = this.context.store.queries
        .select({ payload: tables.jobs.payload })
        .from(tables.jobs)
        .where(and(eq(tables.jobs.scope, scope), eq(tables.jobs.name, snapshot.name)))
        .get();
      if (!row) {
        if (reference) throw new Error("Coordination refresh job no longer exists");
        return;
      }
      const old = v.parse(coordinationJobSchema, JSON.parse(row.payload));
      this.assertObservedJob(snapshot, old, reference);
      const job = this.observedJob(snapshot, old);
      if (isDeepStrictEqual({ ...job, updatedAt: old.updatedAt }, old)) return;
      this.saveJob(job);
      this.context.event(
        "job-observed",
        { job: job.name, ...(job.work ? { work: job.work } : {}) },
        job.project,
        job.actor,
      );
    });
  }

  async unavailableJob(reference: CoordinationJob, _error: string): Promise<void> {
    this.context.store.transaction(() => {
      const row = this.context.store.queries
        .select({ payload: tables.jobs.payload })
        .from(tables.jobs)
        .where(
          and(
            eq(tables.jobs.scope, reference.scopeId),
            eq(tables.jobs.name, reference.name),
          ),
        )
        .get();
      if (!row) throw new Error("Coordination refresh job no longer exists");
      const old = v.parse(coordinationJobSchema, JSON.parse(row.payload));
      if (
        reference.owner !== old.owner ||
        reference.project !== old.project ||
        reference.installationId !== old.installationId ||
        old.installationId !== this.context.installationId ||
        (reference.nativeId !== undefined && reference.nativeId !== old.nativeId) ||
        reference.createdAt !== old.createdAt
      )
        throw new Error("Coordination refresh job identity changed");
      if (old.availability === "unavailable") return;
      const job: CoordinationJob = {
        ...old,
        availability: "unavailable",
        state:
          old.state === "stopped" || old.state === "failed" ? old.state : "unknown",
        reason: "Broker state unavailable",
        updatedAt: Date.now(),
      };
      this.saveJob(job);
      this.context.event("job-unavailable", { job: job.name }, job.project, job.actor);
    });
  }
}
