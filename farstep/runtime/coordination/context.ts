import { eq, sql } from "drizzle-orm";
import type {
  coordinationClaimSchema,
  coordinationEventSchema,
  coordinationNoteSchema,
  coordinationSessionSchema,
  coordinationWorkSchema,
} from "farstep/protocol/coordination";
import type * as v from "valibot";
import type { CoordinationStore } from "./store/store";
import * as tables from "./store/tables";

export type Session = v.InferOutput<typeof coordinationSessionSchema>;
export type Work = v.InferOutput<typeof coordinationWorkSchema>;
export type Claim = v.InferOutput<typeof coordinationClaimSchema>;
export type Note = v.InferOutput<typeof coordinationNoteSchema>;
export type Event = v.InferOutput<typeof coordinationEventSchema>;
export const RESPONSE_BUDGET = 128 * 1024;

export class CoordinationContext {
  constructor(
    readonly store: CoordinationStore,
    readonly owner: string,
    readonly scopeId: string,
    readonly installationId: string,
    private readonly activeSession: () => Session,
    readonly requireSession: () => Session,
  ) {}

  get session(): Session {
    return this.activeSession();
  }

  cursor(): number {
    const row = this.store.queries
      .select({ cursor: sql<number>`coalesce(max(${tables.events.id}), 0)` })
      .from(tables.events)
      .get();
    if (!row) throw new Error("Coordination event cursor is unavailable");
    return row.cursor;
  }

  event(
    action: string,
    references: { session?: string; work?: string; note?: string; job?: string } = {},
    project = this.session.project,
    actor = this.owner,
  ): void {
    const event = { project, actor, action, createdAt: Date.now(), ...references };
    const id = this.store.queries
      .insert(tables.events)
      .values({ project: project, payload: "{}" })
      .returning({ id: tables.events.id })
      .get().id;
    this.store.queries
      .update(tables.events)
      .set({ payload: JSON.stringify({ ...event, id }) })
      .where(eq(tables.events.id, id))
      .run();
  }
}
