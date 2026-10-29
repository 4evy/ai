import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attempt, run } from "@ai/runtime/effect/effect";
import { Effect } from "effect";
import { MODULES } from "./paths";

export const installLinuxServiceEffect = Effect.fnUntraced(function* (
  env: Record<string, string>,
  directory: string,
) {
  const helper =
    process.env.FARSTEP_SKY_HELPER_PATH ||
    join(
      process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
      "farstep/current/bin/farstep",
    );
  yield* attempt(() => access(helper, constants.X_OK)).pipe(
    Effect.mapError(
      () => new Error("Linux Skylight requires an activated farstep package"),
    ),
  );
  const servicePath = join(directory, "service.mjs");
  const build = yield* attempt(
    () =>
      Bun.build({
        entrypoints: [
          fileURLToPath(
            new URL(
              `../linux/service.${import.meta.url.endsWith(".js") ? "js" : "ts"}`,
              import.meta.url,
            ),
          ),
        ],
        target: "node",
        format: "esm",
        minify: true,
      }),
    { awaitOnInterrupt: true },
  );
  const output = build.outputs[0];
  if (!build.success || build.outputs.length !== 1 || !output) {
    return yield* Effect.fail(
      new Error(`Linux Sky service compilation failed: ${build.logs.join("\n")}`),
    );
  }
  yield* attempt(() => Bun.write(servicePath, output), { awaitOnInterrupt: true });
  env.NODE_REPL_TRUSTED_CODE_PATHS = [MODULES, directory].join(delimiter);
  env.NODE_REPL_TRUSTED_SERVICES = JSON.stringify({ sky: servicePath });
  env.FARSTEP_SKY_HELPER_PATH = helper;
  env.FARSTEP_SKY_SESSION_DIR = directory;
});

export function installLinuxService(env: Record<string, string>, directory: string) {
  return run(installLinuxServiceEffect(env, directory));
}
