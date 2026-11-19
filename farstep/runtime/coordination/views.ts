import { and, eq, gt, max, type SQL, sql } from "drizzle-orm";
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
import { actionableJobCondition } from "./jobs";
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

  snapshot(
    allProjects: boolean,
    offset: number,
    limit: number,
    history: boolean,
  ): CoordinationResult {
    return CoordinationViews.snapshot(
      this.context.store,
      allProjects ? undefined : this.context.session.project,
      offset,
      limit,
      { history },
    );
  }

  static snapshot(
    store: CoordinationStore,
    project: string | undefined,
    offset: number,
    limit: number,
    options: { history?: boolean; includeHandoffs?: boolean } = {},
  ): CoordinationResult {
    const observedAt = Date.now();
    const { history = false, includeHandoffs = false } = options;
    // Build actor membership once instead of rescanning history for each session
    const liveSessionClaim = sql`(${tables.sessions.project}, ${tables.sessions.actor}) IN (
      SELECT ${tables.claims.project}, ${tables.claims.actor} FROM ${tables.claims}
      WHERE ${and(
        gt(tables.claims.expires, observedAt),
        project === undefined ? undefined : eq(tables.claims.project, project),
      )}
    )`;
    const liveSessionJob = sql`(${tables.sessions.project}, ${tables.sessions.actor}) IN (
      SELECT ${tables.jobs.project}, ${tables.jobs.actor} FROM ${tables.jobs}
      WHERE ${and(
        actionableJobCondition,
        project === undefined ? undefined : eq(tables.jobs.project, project),
      )}
    )`;
    const liveWorkClaim = sql`EXISTS (
      SELECT 1 FROM ${tables.claims}
      WHERE ${tables.claims.work} = ${tables.works.id}
        AND ${tables.claims.expires} > ${observedAt}
    )`;
    const sessions = store.queries
      .select({
        payload: tables.sessions.payload,
        generation: tables.sessions.generation,
        connected: tables.sessions.connected,
      })
      .from(tables.sessions)
      .where(
        and(
          project === undefined ? undefined : eq(tables.sessions.project, project),
          history
            ? undefined
            : sql`(
                (${tables.sessions.connected} = 1
                  AND json_extract(${tables.sessions.payload}, '$.presence') = 'active'
                  AND json_extract(${tables.sessions.payload}, '$.lastSeenAt') >= ${observedAt - STALE_PRESENCE_MS})
                OR ${liveSessionClaim}
                OR ${liveSessionJob}
              )`,
        ),
      )
      .orderBy(tables.sessions.project, tables.sessions.id)
      .limit(limit + 1)
      .offset(offset)
      .all();
    const works = store.queries
      .select({ payload: tables.works.payload })
      .from(tables.works)
      .where(
        and(
          project === undefined ? undefined : eq(tables.works.project, project),
          history
            ? undefined
            : sql`(json_extract(${tables.works.payload}, '$.status') != 'done'
                OR ${liveWorkClaim})`,
        ),
      )
      .orderBy(tables.works.project, tables.works.id)
      .limit(limit + 1)
      .offset(offset)
      .all();
    const claims = store.queries
      .select({ payload: tables.claims.payload })
      .from(tables.claims)
      .where(
        and(
          history ? undefined : gt(tables.claims.expires, observedAt),
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
      .where(
        and(
          project === undefined ? undefined : eq(tables.jobs.project, project),
          history ? undefined : actionableJobCondition,
        ),
      )
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
              history
                ? undefined
                : sql`json_extract(${tables.notes.payload}, '$.acknowledgedAt') IS NULL`,
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
          .select({ cursor: max(tables.events.id) })
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
