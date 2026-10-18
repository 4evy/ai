import { createHash } from "node:crypto";
import { attempt, Lifetime, run } from "@ai/core/effect/effect";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, eq } from "drizzle-orm";
import { Effect, Match } from "effect";
import {
  COORDINATION_ACTIONS,
  type CoordinationJob,
  type CoordinationOpen,
  type CoordinationRequest,
  type CoordinationResult,
  coordinationOpenSchema,
  coordinationRequestSchema,
  coordinationResultSchema,
} from "farstep/protocol/coordination";
import type { JobSnapshot } from "farstep/protocol/jobs/protocol";
import * as v from "valibot";
import type { ToolRegistrar } from "../jobs/tools";
import { CoordinationContext, type Session } from "./context";
import { CoordinationJobs } from "./jobs";
import { CoordinationNotes } from "./notes";
import { CoordinationPresence } from "./presence";
import { CoordinationStore } from "./store/store";
import * as tables from "./store/tables";
import { CoordinationViews } from "./views";
import { CoordinationWork } from "./work";

export class CoordinationRegistry {
  private shutdown = false;
  private closing?: Promise<void>;
  private readonly refreshes = new Lifetime();

  private readonly context: CoordinationContext;
  private readonly presence: CoordinationPresence;
  private readonly works: CoordinationWork;
  private readonly notes: CoordinationNotes;
  private readonly jobs: CoordinationJobs;
  private readonly views: CoordinationViews;

  private constructor(
    private readonly store: CoordinationStore,
    private readonly owner: string,
    scopeId: string,
    installationId: string,
  ) {
    this.context = new CoordinationContext(
      store,
      owner,
      scopeId,
      installationId,
      () => this.presence.activeSession,
      () => this.presence.requireSession(),
    );
    this.presence = new CoordinationPresence(this.context, () => this.shutdown);
    this.works = new CoordinationWork(this.context);
    this.notes = new CoordinationNotes(this.context, this.works);
    this.jobs = new CoordinationJobs(this.context, this.works);
    this.views = new CoordinationViews(this.context, this.works);
  }

  static async create(options: {
    owner: string;
    scopeId: string;
    installationId: string;
  }): Promise<CoordinationRegistry> {
    if (
      !/^remote:[A-Za-z0-9._:-]{1,128}:[A-Za-z0-9._:-]{1,128}$/u.test(options.owner) ||
      options.owner.length > 512 ||
      !/^[a-f0-9]{64}$/u.test(options.scopeId)
    )
      throw new Error("Invalid coordination actor or scope");
    return new CoordinationRegistry(
      await CoordinationStore.create(options.installationId),
      options.owner,
      options.scopeId,
      options.installationId,
    );
  }

  register(
    registerTool: ToolRegistrar,
    requireHandshake: () => void,
    refreshJobs?: (jobs: CoordinationJob[]) => Promise<void>,
  ): void {
    registerTool(
      "coordination.open",
      {
        inputSchema: coordinationOpenSchema,
        description:
          "Register this actor in a canonical project and acquire a presence lease",
      },
      async (input) => {
        requireHandshake();
        return this.response(await this.open(input));
      },
    );
    registerTool(
      "coordination.request",
      {
        inputSchema: coordinationRequestSchema,
        description:
          "Read shared coordination or mutate caller-owned work, claims, notes and handoffs",
      },
      async (input, signal) => {
        requireHandshake();
        const session = this.presence.requireSession();
        if (refreshJobs && COORDINATION_ACTIONS[input.action].refreshJobs) {
          const project =
            input.action === "snapshot" && input.allProjects
              ? undefined
              : session.project;
          await this.refreshes.run(
            attempt(() => refreshJobs(this.jobRecords(project)), {
              awaitOnInterrupt: true,
            }),
            signal,
          );
        }
        return this.response(this.request(input));
      },
    );
    registerTool(
      "coordination.heartbeat",
      {
        inputSchema: v.strictObject({}),
        description:
          "Renew the current generation's presence lease, without renewing work claims",
      },
      async () => {
        requireHandshake();
        const result = this.store.transaction(() => {
          const session = this.presence.touch("heartbeat");
          return { cursor: this.context.cursor(), session };
        });
        return this.response(result);
      },
    );
    registerTool(
      "coordination.close",
      {
        inputSchema: v.strictObject({}),
        description:
          "Explicitly close only this generation's presence lease; jobs and work survive",
      },
      async () => {
        requireHandshake();
        const result = this.store.transaction(() => {
          const session = this.presence.requireSession();
          this.presence.end("closed");
          return {
            cursor: this.context.cursor(),
            session: {
              ...session,
              presence: "closed" as const,
              lastSeenAt: Date.now(),
            },
          };
        });
        return this.response(result);
      },
    );
  }

  private response(result: CoordinationResult): CallToolResult {
    const parsed = v.parse(coordinationResultSchema, result);
    return {
      content: [{ type: "text", text: JSON.stringify(parsed) }],
      structuredContent: parsed,
    };
  }

  open(input: CoordinationOpen): Promise<CoordinationResult> {
    return this.presence.open(input);
  }

  request(input: CoordinationRequest): CoordinationResult {
    input = v.parse(coordinationRequestSchema, input);
    return this.store.transaction(() => {
      const session = this.presence.requireSession();
      const project = session.project;
      const requestId = "requestId" in input ? input.requestId : undefined;
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(input)
                .filter(([key]) => key !== "requestId")
                .sort(([a], [b]) => a.localeCompare(b)),
            ),
          ),
        )
        .digest("hex");
      if (requestId) {
        const original = this.store.queries
          .select({
            fingerprint: tables.requests.fingerprint,
            result: tables.requests.result,
          })
          .from(tables.requests)
          .where(
            and(
              eq(tables.requests.project, project),
              eq(tables.requests.actor, this.owner),
              eq(tables.requests.request, requestId),
            ),
          )
          .get();
        if (original) {
          if (original.fingerprint !== fingerprint)
            throw new Error(
              "Coordination request ID was reused with a different payload",
            );
          return v.parse(coordinationResultSchema, JSON.parse(original.result));
        }
      }
      this.presence.touch();
      let result = this.requestResult(input, session);
      result = v.parse(coordinationResultSchema, result);
      if (requestId)
        this.store.queries
          .insert(tables.requests)
          .values({
            project: project,
            actor: this.owner,
            request: requestId,
            fingerprint: fingerprint,
            result: JSON.stringify(result),
          })
          .run();
      return result;
    });
  }

  private requestResult(
    input: CoordinationRequest,
    session: Session,
  ): CoordinationResult {
    return Match.value(input).pipe(
      Match.withReturnType<CoordinationResult>(),
      Match.discriminatorsExhaustive("action")({
        snapshot: (request) =>
          this.views.snapshot(request.allProjects, request.cursor, request.limit),
        inbox: (request) => this.views.notes(request),
        thread: (request) => this.views.notes(request),
        events: (request) => this.views.events(request, session),
        session: (request) => this.presence.updatePurpose(request),
        work: (request) => this.works.update(request, session),
        claim: (request) => this.works.claim(request),
        release: (request) => this.works.release(request),
        link: (request) => this.jobs.link(request, session),
        note: (request) => this.notes.post(request),
        handoff: (request) => this.notes.handoff(request, session),
        acknowledge: (request) => this.notes.acknowledge(request, session),
      }),
    );
  }

  async beginJob(input: {
    name: string;
    cwd: string;
    kind: "command" | "workflow";
    lifetime: "session" | "persist";
  }): Promise<void> {
    return this.jobs.beginJob(input);
  }

  jobRecords(project?: string): CoordinationJob[] {
    if (this.shutdown) throw new Error("Coordination gateway is closed");
    return this.jobs.jobRecords(project);
  }

  async observeJob(snapshot: JobSnapshot, reference?: CoordinationJob): Promise<void> {
    if (this.shutdown) return;
    return this.jobs.observeJob(snapshot, reference);
  }

  async unavailableJob(reference: CoordinationJob, error: string): Promise<void> {
    if (this.shutdown) return;
    return this.jobs.unavailableJob(reference, error);
  }

  close(): Promise<void> {
    this.closing ??= this.disconnect();
    return this.closing;
  }

  private disconnect(): Promise<void> {
    return run(
      Effect.gen({ self: this }, function* () {
        this.shutdown = true;
        // Pending native refreshes must settle before the database is closed
        yield* attempt(() => this.refreshes.close(), { awaitOnInterrupt: true });
        yield* Effect.try({
          try: () => this.store.transaction(() => this.presence.end("disconnected")),
          catch: (error) => error,
        });
      }).pipe(Effect.ensuring(Effect.sync(() => this.store.close()))),
    );
  }
}
