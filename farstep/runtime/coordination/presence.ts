import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  type CoordinationOpen,
  type CoordinationRequest,
  type CoordinationResult,
  coordinationOpenSchema,
  coordinationSessionSchema,
} from "farstep/protocol/coordination";
import * as v from "valibot";
import type { CoordinationContext, Session } from "./context";
import * as tables from "./store/tables";

export class CoordinationPresence {
  private session?: Session;
  private generation?: string;
  constructor(
    private readonly context: CoordinationContext,
    private readonly isClosed: () => boolean,
  ) {}

  async open(input: CoordinationOpen): Promise<CoordinationResult> {
    if (this.isClosed()) throw new Error("Coordination gateway is closed");
    input = v.parse(coordinationOpenSchema, input);
    if (this.context.owner !== `remote:${input.sessionId}:${input.agentId}`)
      throw new Error("Coordination session identity must match gateway owner");
    if (!isAbsolute(input.project))
      throw new Error("Coordination project must be absolute");
    const project = await realpath(input.project);
    if (!(await stat(project)).isDirectory())
      throw new Error("Coordination project must be a directory");
    if (this.isClosed()) throw new Error("Coordination gateway is closed");
    if (this.session) {
      if (this.session.project !== project)
        throw new Error("Coordination project is immutable on this gateway");
      return this.context.store.transaction(() => ({
        cursor: this.context.cursor(),
        session: this.touch(),
      }));
    }
    return this.context.store.transaction(() => {
      const previous = this.context.store.queries
        .select({
          payload: tables.sessions.payload,
          generation: tables.sessions.generation,
          connected: tables.sessions.connected,
        })
        .from(tables.sessions)
        .where(
          and(
            eq(tables.sessions.project, project),
            eq(tables.sessions.actor, this.context.owner),
          ),
        )
        .get();
      const old =
        previous && v.parse(coordinationSessionSchema, JSON.parse(previous.payload));
      const now = Date.now();
      const session: Session = {
        id: old?.id ?? randomUUID(),
        project,
        actor: this.context.owner,
        sessionId: input.sessionId,
        agentId: input.agentId,
        ...(input.parentSession ? { parentSession: input.parentSession } : {}),
        ...(old?.purpose
          ? { purpose: old.purpose }
          : input.purpose
            ? { purpose: input.purpose }
            : {}),
        openedAt: now,
        lastSeenAt: now,
        presence: "active",
      };
      const generation = randomUUID();
      this.context.store.queries
        .insert(tables.sessions)
        .values({
          id: session.id,
          project: project,
          actor: this.context.owner,
          generation: generation,
          connected: 1,
          payload: JSON.stringify(session),
        })
        .onConflictDoUpdate({
          target: [tables.sessions.project, tables.sessions.actor],
          set: {
            generation: generation,
            connected: 1,
            payload: JSON.stringify(session),
          },
        })
        .run();
      this.session = session;
      this.generation = generation;
      this.context.event("open", { session: session.id });
      return { cursor: this.context.cursor(), session };
    });
  }

  get activeSession(): Session {
    if (!this.session) throw new Error("Coordination session is not open");
    return this.session;
  }

  private get activeGeneration(): string {
    if (!this.generation) throw new Error("Coordination session is not open");
    return this.generation;
  }

  requireSession(): Session {
    if (this.isClosed() || !this.session || !this.generation)
      throw new Error("Coordination session is not open");
    const row = this.sessionRow();
    if (!row)
      throw new Error(
        "Coordination presence lease was closed or replaced; open a new gateway",
      );
    return v.parse(coordinationSessionSchema, JSON.parse(row.payload));
  }

  private sessionRow() {
    if (!this.session || !this.generation) return undefined;
    const row = this.context.store.queries
      .select({
        payload: tables.sessions.payload,
        generation: tables.sessions.generation,
        connected: tables.sessions.connected,
      })
      .from(tables.sessions)
      .where(eq(tables.sessions.id, this.session.id))
      .get();
    return row && row.generation === this.generation && row.connected === 1
      ? row
      : undefined;
  }

  private saveSession(session: Session, action: string): void {
    this.context.store.queries
      .update(tables.sessions)
      .set({ payload: JSON.stringify(session) })
      .where(
        and(
          eq(tables.sessions.id, session.id),
          eq(tables.sessions.generation, this.activeGeneration),
        ),
      )
      .run();
    this.session = session;
    this.context.event(action, { session: session.id });
  }

  touch(action = "contact"): Session {
    const session = {
      ...this.requireSession(),
      lastSeenAt: Date.now(),
      presence: "active" as const,
    };
    this.saveSession(session, action);
    return session;
  }

  updatePurpose(
    input: Extract<CoordinationRequest, { action: "session" }>,
  ): CoordinationResult {
    const session = { ...this.requireSession(), purpose: input.purpose };
    this.saveSession(session, "session");
    return { cursor: this.context.cursor(), session };
  }

  end(presence: "closed" | "disconnected"): void {
    const row = this.sessionRow();
    if (!row) return;
    const session = {
      ...v.parse(coordinationSessionSchema, JSON.parse(row.payload)),
      presence,
      lastSeenAt: Date.now(),
    };
    this.context.store.queries
      .update(tables.sessions)
      .set({ connected: 0, payload: JSON.stringify(session) })
      .where(
        and(
          eq(tables.sessions.id, session.id),
          eq(tables.sessions.generation, row.generation),
        ),
      )
      .run();
    this.context.event(presence, { session: session.id });
  }
}
