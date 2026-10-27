import { and, eq, gt, type SQL, sql } from "drizzle-orm";
import {
  type CoordinationRequest,
  type CoordinationResult,
  coordinationClaimSchema,
  coordinationEventSchema,
  coordinationJobSchema,
  coordinationNoteSchema,
  coordinationSessionSchema,
  coordinationWorkSchema,
} from "farstep/protocol/coordination";
import * as v from "valibot";
import {
  type CoordinationContext,
  type Event,
  type Note,
  RESPONSE_BUDGET,
  type Session,
} from "./context";
import type { CoordinationStore } from "./store/store";
import * as tables from "./store/tables";
import type { CoordinationWork } from "./work";

const STALE_PRESENCE_MS = 90_000;

export class CoordinationViews {
  constructor(
    private readonly context: CoordinationContext,
    private readonly works: CoordinationWork,
  ) {}

  events(
    input: Extract<CoordinationRequest, { action: "events" }>,
    session: Session,
  ): CoordinationResult {
    const rows = this.context.store.queries
      .select({ payload: tables.events.payload })
      .from(tables.events)
      .where(
        and(
          eq(tables.events.project, session.project),
          gt(tables.events.id, input.cursor),
        ),
      )
      .orderBy(tables.events.id)
      .limit(input.limit + 1)
      .all();
    const events: Event[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, input.limit)) {
      const size = Buffer.byteLength(row.payload);
      if (events.length && bytes + size > RESPONSE_BUDGET) break;
      bytes += size;
      events.push(v.parse(coordinationEventSchema, JSON.parse(row.payload)));
    }
    return {
      cursor: this.context.cursor(),
      events,
      pagination: {
        nextCursor: events.at(-1)?.id ?? input.cursor,
        hasMore: rows.length > events.length,
      },
    };
  }

  snapshot(allProjects: boolean, offset: number, limit: number): CoordinationResult {
    return CoordinationViews.snapshot(
      this.context.store,
      allProjects ? undefined : this.context.session.project,
      offset,
      limit,
    );
  }

  static snapshot(
    store: CoordinationStore,
    project: string | undefined,
    offset: number,
    limit: number,
    includeHandoffs = false,
  ): CoordinationResult {
    const observedAt = Date.now();
    const sessions = store.queries
      .select({
        payload: tables.sessions.payload,
        generation: tables.sessions.generation,
        connected: tables.sessions.connected,
      })
      .from(tables.sessions)
      .where(project === undefined ? undefined : eq(tables.sessions.project, project))
      .orderBy(tables.sessions.project, tables.sessions.id)
      .limit(limit + 1)
      .offset(offset)
      .all();
    const works = store.queries
      .select({ payload: tables.works.payload })
      .from(tables.works)
      .where(project === undefined ? undefined : eq(tables.works.project, project))
      .orderBy(tables.works.project, tables.works.id)
      .limit(limit + 1)
      .offset(offset)
      .all();
    const claims = store.queries
      .select({ payload: tables.claims.payload })
      .from(tables.claims)
      .where(
        and(
          gt(tables.claims.expires, observedAt),
          project === undefined ? undefined : eq(tables.claims.project, project),
        ),
      )
      .orderBy(tables.claims.project, tables.claims.work)
      .limit(limit + 1)
      .offset(offset)
      .all();
    const jobs = store.queries
      // Budget raw stored bytes before decoding only the selected prefix
      .select({ payload: sql<string>`${tables.jobs.payload}` })
      .from(tables.jobs)
      .where(project === undefined ? undefined : eq(tables.jobs.project, project))
      .orderBy(tables.jobs.project, tables.jobs.scope, tables.jobs.name)
      .limit(limit + 1)
      .offset(offset)
      .all();
    const notes = includeHandoffs
      ? store.queries
          .select({ payload: tables.notes.payload })
          .from(tables.notes)
          .where(
            and(
              project === undefined ? undefined : eq(tables.notes.project, project),
              sql`json_extract(${tables.notes.payload}, '$.kind') = 'handoff'`,
              sql`json_extract(${tables.notes.payload}, '$.acknowledgedAt') IS NULL`,
            ),
          )
          .orderBy(tables.notes.project, tables.notes.sequence)
          .limit(limit + 1)
          .offset(offset)
          .all()
      : [];
    // Keep one prefix width so the cursor advances equally across collections
    let width = limit;
    while (
      width > 1 &&
      [sessions, works, claims, jobs, notes].reduce(
        (bytes, rows) =>
          bytes +
          rows
            .values()
            .take(width)
            .reduce((sum, row) => sum + Buffer.byteLength(row.payload), 0),
        0,
      ) > RESPONSE_BUDGET
    )
      width--;
    const truncated = {
      sessions: sessions.length > width,
      works: works.length > width,
      claims: claims.length > width,
      jobs: jobs.length > width,
    };
    return {
      cursor:
        store.queries
          .select({ cursor: sql<number>`coalesce(max(${tables.events.id}), 0)` })
          .from(tables.events)
          .get()?.cursor ?? 0,
      sessions: sessions
        .values()
        .take(width)
        .map((row) => {
          const session = v.parse(coordinationSessionSchema, JSON.parse(row.payload));
          return {
            ...session,
            presence:
              row.connected === 1 && observedAt - session.lastSeenAt > STALE_PRESENCE_MS
                ? ("stale" as const)
                : session.presence,
          };
        })
        .toArray(),
      works: works
        .values()
        .take(width)
        .map((row) => v.parse(coordinationWorkSchema, JSON.parse(row.payload)))
        .toArray(),
      claims: claims
        .values()
        .take(width)
        .map((row) => v.parse(coordinationClaimSchema, JSON.parse(row.payload)))
        .toArray(),
      jobs: jobs
        .values()
        .take(width)
        .map((row) => v.parse(coordinationJobSchema, JSON.parse(row.payload)))
        .toArray(),
      truncated,
      ...(includeHandoffs
        ? {
            notes: notes
              .values()
              .take(width)
              .map((row) => v.parse(coordinationNoteSchema, JSON.parse(row.payload)))
              .toArray(),
          }
        : {}),
      pagination: {
        nextCursor: offset + width,
        hasMore: Object.values(truncated).some(Boolean) || notes.length > width,
      },
    };
  }

  notes(
    input: Extract<CoordinationRequest, { action: "inbox" | "thread" }>,
  ): CoordinationResult {
    const session = this.context.session;
    const conditions: SQL[] = [
      eq(tables.notes.project, session.project),
      gt(tables.notes.sequence, input.cursor),
    ];
    if (input.action === "inbox")
      conditions.push(eq(tables.notes.recipient, session.id));
    else {
      if (input.thread) conditions.push(eq(tables.notes.thread, input.thread));
      if (input.work) {
        this.works.get(input.work);
        conditions.push(eq(tables.notes.work, input.work));
      }
      if (input.query)
        conditions.push(
          sql`instr(lower(${tables.notes.body}), lower(${input.query})) > 0`,
        );
    }
    const rows = this.context.store.queries
      .select({ payload: tables.notes.payload })
      .from(tables.notes)
      .where(and(...conditions))
      .orderBy(tables.notes.sequence)
      .limit(input.limit + 1)
      .all();
    const notes: Note[] = [];
    let bytes = 0;
    for (const row of rows.values().take(input.limit)) {
      const size = Buffer.byteLength(row.payload);
      if (notes.length && bytes + size > RESPONSE_BUDGET) break;
      bytes += size;
      notes.push(v.parse(coordinationNoteSchema, JSON.parse(row.payload)));
    }
    return {
      cursor: this.context.cursor(),
      notes,
      pagination: {
        nextCursor: notes.at(-1)?.sequence ?? input.cursor,
        hasMore: rows.length > notes.length,
      },
    };
  }
}
