import { readFileSync as readResource } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { temporaryDirectory } from "@ai/runtime/effect/fs/fs";
import { get } from "@ai/runtime/effect/http/http";
import { terminateProcess } from "@ai/runtime/effect/process/process";
import { Effect } from "effect";
import * as v from "valibot";
import { readBrowserPort, runUserAgent, START_TIMEOUT_MS } from "../agent/agent.ts";

const COMMAND_NAME = "ai browser chromium user agent";
const metadataSchema = v.object({
  "User-Agent": v.pipe(v.string(), v.nonEmpty()),
});

const BROWSER_COMMANDS = [
  "helium-browser",
  "helium",
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "google-chrome-beta",
  "google-chrome-unstable",
  "chrome",
  "brave-browser",
  "brave",
  "microsoft-edge",
  "microsoft-edge-stable",
  "vivaldi",
  "vivaldi-stable",
  "ungoogled-chromium",
];
const MACOS_BROWSERS = [
  ["Helium.app", "Helium"],
  ["Chromium.app", "Chromium"],
  ["Google Chrome.app", "Google Chrome"],
  ["Google Chrome Beta.app", "Google Chrome Beta"],
  ["Google Chrome Dev.app", "Google Chrome Dev"],
  ["Google Chrome Canary.app", "Google Chrome Canary"],
  ["Brave Browser.app", "Brave Browser"],
  ["Microsoft Edge.app", "Microsoft Edge"],
  ["Vivaldi.app", "Vivaldi"],
] as const;

const probeUserAgent = Effect.fnUntraced(function* (command: string[]) {
  const profile = yield* temporaryDirectory(join(tmpdir(), `${COMMAND_NAME}-`));
  const browser = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn(
          [
            ...command,
            `--user-data-dir=${profile.path}`,
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-startup-window",
          ],
          { stderr: "ignore", stdout: "ignore" },
        ),
      catch: (error) => error,
    }),
    (browser) => terminateProcess(browser).pipe(Effect.orDie),
  );
  const port = yield* readBrowserPort(
    join(profile.path, "DevToolsActivePort"),
    browser,
    "DevTools",
    (text) => Number(text.split("\n", 1)[0]),
  );
  return yield* Effect.gen(function* () {
    const response = yield* get(`http://127.0.0.1:${port}/json/version`);
    if (response.status < 200 || response.status >= 300)
      return yield* Effect.fail(
        new Error(`Browser DevTools returned HTTP ${response.status}`),
      );
    const metadata = v.safeParse(metadataSchema, yield* response.json);
    if (!metadata.success)
      return yield* Effect.fail(
        new Error("Browser DevTools did not return a user agent"),
      );
    return metadata.output["User-Agent"];
  }).pipe(
    Effect.timeoutOrElse({
      duration: START_TIMEOUT_MS,
      orElse: () => Effect.fail(new Error("Browser DevTools request timed out")),
    }),
  );
}, Effect.scoped);

await runUserAgent({
  commandName: COMMAND_NAME,
  browserName: "Chromium",
  environmentVariable: "CHROMIUM_BROWSER",
  browserCommands: BROWSER_COMMANDS,
  macosBrowsers: MACOS_BROWSERS,
  usage: readResource(new URL("./usage.txt", import.meta.url), "utf8"),
  probe: probeUserAgent,
});
