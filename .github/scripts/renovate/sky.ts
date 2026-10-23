import { createHash } from "node:crypto";
import { info } from "@actions/core";
import { run } from "@ai/core/effect/effect";
import { get } from "@ai/core/effect/http/http";
import { Effect, Stream } from "effect";
import pins from "../../../farstep/runtime/sky/runtime/pins.json";

export async function prepareSkyFeeds(): Promise<Disposable> {
  const feeds = new Map<string, string>(
    await run(
      Effect.forEach(
        pins.artifacts.filter(({ platform }) => platform === "win32"),
        (artifact) =>
          Effect.gen(function* () {
            info(`Checking the published Windows ${artifact.arch} Sky runtime`);
            const response = yield* get(artifact.url);
            if (response.status < 200 || response.status >= 300)
              return yield* Effect.fail(
                new Error(
                  `Windows ${artifact.arch} runtime returned ${response.status}`,
                ),
              );
            const hash = createHash("sha256");
            yield* response.stream.pipe(
              Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))),
            );
            return [
              `/chatgpt-windows-${artifact.arch}.json`,
              JSON.stringify({
                releases: [{ version: "1", digest: hash.digest("hex") }],
              }),
            ] as const;
          }).pipe(
            // Close rejected responses and cancel sibling downloads on failure
            Effect.scoped,
            Effect.timeoutOrElse({
              duration: 10 * 60_000,
              orElse: () =>
                Effect.fail(
                  new Error(`Windows ${artifact.arch} runtime download timed out`),
                ),
            }),
          ),
        { concurrency: 2 },
      ),
    ),
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const feed = feeds.get(new URL(request.url).pathname);
      return new Response(feed ?? "Not found", {
        status: feed ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  process.env.RENOVATE_SKY_FEED_URL = server.url.href;
  return { [Symbol.dispose]: () => server.stop(true) };
}
