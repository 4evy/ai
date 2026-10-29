import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@ai/values/error/error";
import { CoordinationStore } from "../coordination/store/store";
import { CoordinationViews } from "../coordination/views";
import { paths } from "../state";
import { completionEvidence } from "./records";

export async function workList(options: {
  project?: string | undefined;
  cursor: number;
  limit: number;
}) {
  const observedAt = Date.now();
  const source = join(paths().state, "coordination", "registry.sqlite");
  try {
    const project = options.project ? await realpath(options.project) : undefined;
    using store = await CoordinationStore.openReadOnly();
    const page = store.queries.transaction(() =>
      CoordinationViews.snapshot(store, project, options.cursor, options.limit, true),
    );
    const jobs = await Promise.all(
      (page.jobs ?? []).map(async (job) => {
        const completion = await completionEvidence(job);
        return {
          ...job,
          condition: completion.pending.length
            ? "unacknowledged"
            : job.availability === "unavailable"
              ? "unavailable"
              : job.state === "stopped"
                ? "completed"
                : job.state,
          process: {
            recordedState: job.state,
            currentState: "unknown",
          },
          readiness: completion.readiness,
          completion: {
            acknowledgement: completion.acknowledgement,
            pending: completion.pending,
            ...("source" in completion ? { source: completion.source } : {}),
          },
          freshness: {
            recordedAt: job.updatedAt,
            ageMs: Math.max(0, observedAt - job.updatedAt),
          },
        };
      }),
    );
    return {
      observedAt,
      availability: "available" as const,
      source,
      project: project ?? null,
      freshness: {
        source: "registry-records",
        liveRefresh: false,
        detail:
          "Recorded state only. No broker was started or contacted. Registry and durable completion reads are not atomic together. Record age does not establish current process state, readiness, input needs or a stuck operation.",
      },
      cursor: page.cursor,
      sessions: page.sessions?.map((session) => ({
        ...session,
        freshness: {
          recordedAt: session.lastSeenAt,
          ageMs: Math.max(0, observedAt - session.lastSeenAt),
          source: "presence-lease",
        },
      })),
      works: page.works?.map((work) => ({
        ...work,
        condition: work.status === "done" ? "completed" : "unknown",
        freshness: {
          recordedAt: work.updatedAt,
          ageMs: Math.max(0, observedAt - work.updatedAt),
        },
      })),
      claims: page.claims,
      jobs,
      handoffs: page.notes?.map((note) => ({
        ...note,
        condition: "unacknowledged",
        freshness: {
          recordedAt: note.createdAt,
          ageMs: Math.max(0, observedAt - note.createdAt),
        },
      })),
      pagination: {
        ...page.pagination,
        requestedCursor: options.cursor,
        requestedLimit: options.limit,
        detail:
          "Each collection is paginated independently at the same offset. Pages are not a frozen snapshot across CLI invocations. Follow nextCursor while hasMore is true.",
      },
    };
  } catch (error) {
    return {
      observedAt,
      availability: "unavailable" as const,
      source,
      error: errorMessage(error),
      remedy:
        "Use the owning user's state directory and an existing compatible coordination registry. Open coordination through an activated helper to create one. This read did not initialize or migrate it.",
    };
  }
}
