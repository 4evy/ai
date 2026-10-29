import { operationEffect } from "@ai/runtime/effect/effect";
import { Effect } from "effect";
import type { HelperConnection } from "#farstep/transport/connection/bun";

export function gatewayCallEffect(
  helper: HelperConnection,
  identity: { backend: "local" | "ssh"; scopeId: string; installationId: string },
  closed: () => boolean,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000,
) {
  return Effect.gen(function* () {
    if (closed())
      return yield* Effect.fail(
        new Error("Job gateway is closed; the operation was not replayed"),
      );
    return yield* operationEffect(
      "gateway.call",
      {
        component: "gateway",
        method: tool,
        backend: identity.backend,
        scopeId: identity.scopeId,
        installationId: identity.installationId,
        ...(typeof args.requestId === "string" ? { requestId: args.requestId } : {}),
      },
      Effect.gen(function* () {
        const response = yield* helper.callEffect(tool, args, timeoutMs);
        if (response.isError)
          return yield* Effect.fail(
            new Error(
              response.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n") || "Job operation failed",
            ),
          );
        return response.structuredContent;
      }),
    );
  });
}
