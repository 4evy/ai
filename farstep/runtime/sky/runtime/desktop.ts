import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { attempt } from "@ai/runtime/effect/effect";
import { Effect } from "effect";
import { browserServiceSource, desktopServiceSource } from "./observations";
import { MODULES } from "./paths";

const writeServiceEffect = Effect.fnUntraced(function* (
  directory: string,
  name: string,
  module: string,
  source: (upstream: string) => string,
) {
  const upstream = yield* Effect.try({
    try: () => createRequire(import.meta.url).resolve(module, { paths: [MODULES] }),
    catch: (error) => error,
  });
  const servicePath = join(directory, `${name}-service.mjs`);
  yield* attempt(
    () =>
      writeFile(servicePath, source(pathToFileURL(upstream).href), {
        mode: 0o600,
        flag: "wx",
      }),
    { awaitOnInterrupt: true },
  );
  return servicePath;
});

export const installBrowserServiceEffect = Effect.fnUntraced(function* (
  env: Record<string, string>,
  directory: string,
) {
  const servicePath = yield* writeServiceEffect(
    directory,
    "browser",
    "@oai/browser-desktop/service",
    browserServiceSource,
  );
  env.NODE_REPL_TRUSTED_CODE_PATHS = [MODULES, directory].join(delimiter);
  env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify({
    ...JSON.parse(env.NODE_REPL_TRUSTED_SERVICES ?? "{}"),
    browser: servicePath,
  });
});

export const installDesktopServiceEffect = Effect.fnUntraced(function* (
  env: Record<string, string>,
  directory: string,
) {
  const servicePath = yield* writeServiceEffect(
    directory,
    "sky",
    "@oai/sky/service",
    desktopServiceSource,
  );
  env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify({ sky: servicePath });
  yield* installBrowserServiceEffect(env, directory);
});
