import { createHash } from "node:crypto";
import { info } from "@actions/core";
import pins from "../../../farstep/runtime/sky/runtime/pins.json";

export async function prepareSkyFeeds(): Promise<Disposable> {
  const feeds = new Map<string, string>();
  for (const artifact of pins.artifacts.filter(
    ({ platform }) => platform === "win32",
  )) {
    info(`Checking the published Windows ${artifact.arch} Sky runtime`);
    const response = await fetch(artifact.url, {
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Windows ${artifact.arch} runtime returned ${response.status}`);
    const hash = createHash("sha256");
    for await (const chunk of response.body) hash.update(chunk);
    feeds.set(
      `/chatgpt-windows-${artifact.arch}.json`,
      JSON.stringify({ releases: [{ version: "1", digest: hash.digest("hex") }] }),
    );
  }
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
