import { randomUUID } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import {
  type CoordinationRequest,
  type CoordinationResult,
  coordinationClaimSchema,
  coordinationWorkSchema,
} from "farstep/protocol/coordination";
import * as v from "valibot";
import type { Claim, CoordinationContext, Session, Work } from "./context";
import * as tables from "./store/tables";

export class CoordinationWork {
  constructor(private readonly context: CoordinationContext) {}

  get(id: string): Work {
    const row = this.context.store.queries
      .select({ payload: tables.works.payload })
      .from(tables.works)
      .where(
        and(
          eq(tables.works.id, id),
          eq(tables.works.project, this.context.session.project),
        ),
      )
      .get();
    if (!row) throw new Error("Work does not exist in this project");
    return v.parse(coordinationWorkSchema, JSON.parse(row.payload));
  }

  authorize(work: Work): void {
    const claim = this.context.store.queries
      .select({ actor: tables.claims.actor })
      .from(tables.claims)
      .where(
        and(eq(tables.claims.work, work.id), gt(tables.claims.expires, Date.now())),
      )
      .get();
    if (
      (claim && claim.actor !== this.context.owner) ||
      work.owner !== this.context.owner
    )
      throw new Error("Only the current work owner may mutate this work");
  }

  save(work: Work): void {
    this.context.store.queries
      .insert(tables.works)
      .values({
        id: work.id,
        project: work.project,
        owner: work.owner ?? null,
        payload: JSON.stringify(work),
      })
      .onConflictDoUpdate({
        target: tables.works.id,
        set: { owner: work.owner ?? null, payload: JSON.stringify(work) },
      })
      .run();
  }

  private workIdentity(old: Work | undefined, project: string, now: number) {
    return {
      id: old?.id ?? randomUUID(),
      project,
      createdBy: old?.createdBy ?? this.context.owner,
      owner: old?.owner ?? this.context.owner,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
  }

  update(
    input: Extract<CoordinationRequest, { action: "work" }>,
    session: Session,
  ): CoordinationResult {
    const old = input.work ? this.get(input.work) : undefined;
    if (old) this.authorize(old);
    const title = input.title ?? old?.title;
    if (!title) throw new Error("New work requires a title");
    const now = Date.now();
    const work: Work = {
      ...this.workIdentity(old, session.project, now),
      title,
      status: input.status ?? old?.status ?? "open",
      blockers: input.blockers ?? old?.blockers ?? [],
    };
    this.save(work);
    this.context.event("work", { work: work.id });
    return { cursor: this.context.cursor(), work };
  }

  release(
    input: Extract<CoordinationRequest, { action: "release" }>,
  ): CoordinationResult {
    const work = this.get(input.work);
    const claim = this.context.store.queries
      .select({ actor: tables.claims.actor })
      .from(tables.claims)
      .where(eq(tables.claims.work, work.id))
      .get();
    if (claim && claim.actor !== this.context.owner)
      throw new Error("Only the claim actor may release this claim");
    if (!claim && work.owner !== this.context.owner)
      throw new Error("Only the work owner may release this work");
    this.context.store.queries
      .delete(tables.claims)
      .where(
        and(
          eq(tables.claims.work, work.id),
          eq(tables.claims.actor, this.context.owner),
        ),
      )
      .run();
    this.context.event("release", { work: work.id });
    return { cursor: this.context.cursor(), work, claims: [] };
  }

  private resourceConflicts(
    work: Work,
    resources: string[],
    now: number,
  ): NonNullable<CoordinationResult["conflicts"]> {
    const conflicts: NonNullable<CoordinationResult["conflicts"]> = [];
    for (const resource of resources) {
      const occupied = this.context.store.queries
        .select({
          work: tables.claims.work,
          actor: tables.claims.actor,
          expires: tables.claims.expires,
        })
        .from(tables.resources)
        .innerJoin(tables.claims, eq(tables.claims.work, tables.resources.work))
        .where(
          and(
            eq(tables.resources.project, work.project),
            eq(tables.resources.resource, resource),
            gt(tables.claims.expires, now),
          ),
        )
        .get();
      if (occupied && occupied.work !== work.id)
        conflicts.push({
          work: occupied.work,
          actor: occupied.actor,
          resource,
          expiresAt: occupied.expires,
        });
    }
    return conflicts;
  }

  private previousResources(old: Claim | undefined): string[] {
    return old?.actor === this.context.owner ? old.resources : [];
  }

  claim(input: Extract<CoordinationRequest, { action: "claim" }>): CoordinationResult {
    const work = this.get(input.work);
    if (work.status === "done")
      throw new Error("Completed work must be explicitly reopened before claiming");
    const now = Date.now();
    const oldRow = this.context.store.queries
      .select({ payload: tables.claims.payload })
      .from(tables.claims)
      .where(and(eq(tables.claims.work, work.id), gt(tables.claims.expires, now)))
      .get();
    const old = oldRow && v.parse(coordinationClaimSchema, JSON.parse(oldRow.payload));
    const resources = [
      ...new Set(input.resources ?? this.previousResources(old)),
    ].sort();
    const conflicts: NonNullable<CoordinationResult["conflicts"]> = [];
    if (old && old.actor !== this.context.owner)
      conflicts.push({ work: work.id, actor: old.actor, expiresAt: old.expiresAt });
    conflicts.push(...this.resourceConflicts(work, resources, now));
    if (conflicts.length) return { cursor: this.context.cursor(), conflicts };
    // Expired claims are garbage-collected only after the whole acquisition passes
    this.context.store.queries
      .delete(tables.claims)
      .where(lte(tables.claims.expires, now))
      .run();
    this.context.store.queries
      .delete(tables.claims)
      .where(eq(tables.claims.work, work.id))
      .run();
    const claim: Claim = {
      work: work.id,
      project: work.project,
      actor: this.context.owner,
      resources,
      acquiredAt: old?.actor === this.context.owner ? old.acquiredAt : now,
      expiresAt: now + input.ttlSeconds * 1000,
    };
    this.context.store.queries
      .insert(tables.claims)
      .values({
        work: work.id,
        project: work.project,
        actor: this.context.owner,
        expires: claim.expiresAt,
        payload: JSON.stringify(claim),
      })
      .run();
    if (resources.length)
      this.context.store.queries
        .insert(tables.resources)
        .values(
          resources.map((resource) => ({
            project: work.project,
            resource,
            work: work.id,
          })),
        )
        .run();
    const owned: Work = {
      ...work,
      owner: this.context.owner,
      status: work.status === "open" ? "in_progress" : work.status,
      updatedAt: now,
    };
    this.save(owned);
    this.context.event("claim", { work: work.id });
    return { cursor: this.context.cursor(), work: owned, claims: [claim] };
  }
}
