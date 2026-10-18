import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  type CoordinationRequest,
  type CoordinationResult,
  coordinationNoteSchema,
} from "farstep/protocol/coordination";
import * as v from "valibot";
import type { CoordinationContext, Note, Session } from "./context";
import * as tables from "./store/tables";
import type { CoordinationWork } from "./work";

export class CoordinationNotes {
  constructor(
    private readonly context: CoordinationContext,
    private readonly works: CoordinationWork,
  ) {}

  private recipient(id: string): void {
    if (
      !this.context.store.queries
        .select({ id: tables.sessions.id })
        .from(tables.sessions)
        .where(
          and(
            eq(tables.sessions.id, id),
            eq(tables.sessions.project, this.context.session.project),
          ),
        )
        .get()
    )
      throw new Error("Recipient does not exist in this project");
  }

  private noteThreadWork(input: {
    thread?: string | undefined;
    work?: string | undefined;
  }): string | undefined {
    if (!input.thread) return undefined;
    const row = this.context.store.queries
      .select({ payload: tables.notes.payload })
      .from(tables.notes)
      .where(
        and(
          eq(tables.notes.project, this.context.session.project),
          eq(tables.notes.thread, input.thread),
        ),
      )
      .orderBy(tables.notes.sequence)
      .limit(1)
      .get();
    if (!row) throw new Error("Thread does not exist in this project");
    const threadWork = v.parse(coordinationNoteSchema, JSON.parse(row.payload)).work;
    if (input.work && input.work !== threadWork)
      throw new Error("Thread belongs to different work");
    return threadWork;
  }

  private appendNote(
    input: Pick<
      Extract<CoordinationRequest, { action: "note" }>,
      "body" | "work" | "recipient" | "thread"
    >,
    kind: "note" | "handoff",
  ): Note {
    if (input.work) this.works.get(input.work);
    if (input.recipient) this.recipient(input.recipient);
    const threadWork = this.noteThreadWork(input);
    const note = {
      id: randomUUID(),
      project: this.context.session.project,
      actor: this.context.owner,
      thread: input.thread ?? randomUUID(),
      body: input.body,
      ...((input.work ?? threadWork) ? { work: input.work ?? threadWork } : {}),
      ...(input.recipient ? { recipient: input.recipient } : {}),
      createdAt: Date.now(),
      kind,
    };
    const sequence = this.context.store.queries
      .insert(tables.notes)
      .values({
        id: note.id,
        project: note.project,
        thread: note.thread,
        work: note.work ?? null,
        recipient: note.recipient ?? null,
        body: note.body,
        payload: "{}",
      })
      .returning({ sequence: tables.notes.sequence })
      .get().sequence;
    const result: Note = { ...note, sequence };
    this.context.store.queries
      .update(tables.notes)
      .set({ payload: JSON.stringify(result) })
      .where(eq(tables.notes.id, result.id))
      .run();
    this.context.event(kind, {
      note: result.id,
      ...(result.work ? { work: result.work } : {}),
    });
    return result;
  }

  post(input: Extract<CoordinationRequest, { action: "note" }>): CoordinationResult {
    const note = this.appendNote(input, "note");
    return { cursor: this.context.cursor(), notes: [note] };
  }

  handoff(
    input: Extract<CoordinationRequest, { action: "handoff" }>,
    session: Session,
  ): CoordinationResult {
    const work = this.works.get(input.work);
    this.works.authorize(work);
    this.recipient(input.recipient);
    if (input.recipient === session.id)
      throw new Error("Handoff recipient must be another session");
    const note = this.appendNote(input, "handoff");
    this.context.store.queries
      .delete(tables.claims)
      .where(
        and(
          eq(tables.claims.work, work.id),
          eq(tables.claims.actor, this.context.owner),
        ),
      )
      .run();
    const { owner: _owner, ...unowned } = work;
    const released = { ...unowned, updatedAt: Date.now() };
    this.works.save(released);
    return { cursor: this.context.cursor(), work: released, claims: [], notes: [note] };
  }

  acknowledge(
    input: Extract<CoordinationRequest, { action: "acknowledge" }>,
    session: Session,
  ): CoordinationResult {
    const row = this.context.store.queries
      .select({ payload: tables.notes.payload })
      .from(tables.notes)
      .where(
        and(eq(tables.notes.id, input.note), eq(tables.notes.project, session.project)),
      )
      .get();
    if (!row) throw new Error("Note does not exist in this project");
    const old = v.parse(coordinationNoteSchema, JSON.parse(row.payload));
    if (old.recipient !== session.id)
      throw new Error("Only the addressed recipient may acknowledge a note");
    const note = { ...old, acknowledgedAt: old.acknowledgedAt ?? Date.now() };
    this.context.store.queries
      .update(tables.notes)
      .set({ payload: JSON.stringify(note) })
      .where(eq(tables.notes.id, note.id))
      .run();
    this.context.event("acknowledge", { note: note.id });
    return { cursor: this.context.cursor(), notes: [note] };
  }
}
