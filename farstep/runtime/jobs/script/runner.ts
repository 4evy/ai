import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attempt, run } from "@ai/runtime/effect/effect";
import { executeBoundedCommand } from "@ai/runtime/effect/process/process";
import { Effect } from "effect";
import { SCRIPT_API, type ScriptRunner } from "farstep/protocol/jobs/gateway";
import { darwinSystemPackage } from "../../../installation";
import { existsEffect, paths, privateRead } from "../../state";
import { type LockWait, waitForLockEffect } from "../lock/wait";

const recovery =
  "Upgrade and activate Farstep on the target, then disconnect and reconnect the target. No user script was run";

// Exercise the same entry point, imports and globals used by real user scripts
const probe = `
import { Effect as ImportedEffect } from 'effect';
for (const name of ['cmd', 'Env', 'Config', 'ConfigProvider', 'Redacted', 'Query', 'Effect', 'Stream', 'Schema', 'CommandError', '$', 'zx', 'params']) {
  if (globalThis[name] === undefined) throw new Error('Missing script global: ' + name);
}
const scoped = cmd.with({ env: Env.inherit().set({ FARSTEP_RUNNER_PROBE: 'verified' }) });
if (await scoped.config(Config.String('FARSTEP_RUNNER_PROBE')) !== 'verified') throw new Error('Env/Config contract mismatch');
const result = await scoped.run(['printf', '%s', params.token]);
if (result.exitCode !== 0 || result.stdout !== params.token || result.stderr !== '' || result.stdoutBytes.length !== params.token.length) throw new Error('cmd result contract mismatch');
if (await scoped.execute(Effect.succeed(params.token)) !== params.token) throw new Error('Effect execution mismatch');
const rows = await Query.from([1, 2]).where(value => value === 2).collect();
if (rows.length !== 1 || rows[0] !== 2) throw new Error('Query contract mismatch');
if (await scoped.execute(ImportedEffect.succeed(params.token)) !== params.token) throw new Error('Pinned Effect import mismatch');
console.log(params.token);
`;

export async function scriptRunner(): Promise<ScriptRunner> {
  const application = await realpath(process.execPath);
  const script = await realpath(
    fileURLToPath(
      new URL(
        `./script.${import.meta.url.endsWith(".js") ? "js" : "ts"}`,
        import.meta.url,
      ),
    ),
  );
  const packagePath = process.env.FARSTEP_PACKAGE_PATH
    ? await realpath(process.env.FARSTEP_PACKAGE_PATH)
    : null;
  const digest = createHash("sha256");
  digest.update(JSON.stringify({ application, script, packagePath, bun: Bun.version }));
  // Re-read the small runner module set, including on cached-gateway checks
  for (const name of (await readdir(dirname(script))).sort()) {
    if (!/\.(?:js|ts)$/u.test(name)) continue;
    digest
      .update(name)
      .update("\0")
      .update(await readFile(join(dirname(script), name)));
  }
  return {
    application,
    script,
    api: SCRIPT_API,
    generation: digest.digest("hex"),
    packagePath,
  };
}

export async function verifyScriptRunner(packagePath?: string): Promise<ScriptRunner> {
  try {
    const runner = await scriptRunner();
    if (packagePath !== undefined) {
      const selected = await realpath(packagePath);
      if (
        runner.packagePath !== selected ||
        runner.script !==
          (await realpath(
            join(selected, "lib/farstep/farstep/runtime/jobs/script/script.js"),
          ))
      )
        throw new Error(
          `Invoke ${join(selected, "bin/farstep")} to verify its packaged runner`,
        );
    }
    const shell = Bun.which("bash");
    if (!shell) throw new Error("Bash is unavailable for script runner verification");
    const token = `farstep-${runner.api}-${runner.generation}`;
    const result = await run(
      executeBoundedCommand(
        [
          runner.application,
          "--no-install",
          runner.script,
          "--script",
          "bash",
          await realpath(shell),
          JSON.stringify({ script: probe, params: { token } }),
        ],
        { timeout: 15_000, maxOutputBytes: 8192, pipeDrainTimeoutMs: 1000 },
      ),
    );
    if (
      result.code !== 0 ||
      result.stdout !== `${token}\n` ||
      result.stdoutTruncated ||
      result.stderrTruncated
    )
      throw new Error(
        `Packaged script runner probe failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    const checked = await scriptRunner();
    if (checked.generation !== runner.generation)
      throw new Error("Script runner changed during verification");
    return runner;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. ${recovery}`,
      { cause: error },
    );
  }
}

type JobPackageActivation =
  | { current: string; manager: "nix-darwin" }
  | { current: string; manager: "installer"; record: string };

async function jobPackageActivation(): Promise<JobPackageActivation> {
  const system = await darwinSystemPackage();
  if (system) return { current: system, manager: "nix-darwin" };
  const location = paths();
  const [current, record] = await Promise.all([
    realpath(join(location.data, "current")),
    privateRead(join(location.state, "installer.json")),
  ]);
  return { current, record, manager: "installer" };
}

function assertCurrentJobPackage(
  activation: JobPackageActivation,
  packagePath: string | null,
): void {
  if (
    activation.current !== packagePath &&
    (packagePath !== null || activation.manager === "nix-darwin")
  )
    throw new Error(
      "Active Farstep package changed. Disconnect and reconnect the target before launching scripts. No user script was run",
    );
}

export async function assertActiveJobPackage(): Promise<void> {
  const activation = await jobPackageActivation();
  const packagePath = process.env.FARSTEP_PACKAGE_PATH;
  assertCurrentJobPackage(activation, packagePath ? await realpath(packagePath) : null);
}

/** Read-only activation identity, independent of installation/job ownership */
export async function scriptActivation(
  runner: ScriptRunner,
  requireCurrent = false,
  options: LockWait = {},
): Promise<string> {
  const lock = join(paths().state, "maintenance.lock");
  return run(
    waitForLockEffect(
      Effect.gen(function* () {
        while (true) {
          if (yield* existsEffect(lock)) {
            yield* Effect.sleep(25);
            continue;
          }
          const inspectedRunner = yield* attempt(scriptRunner);
          const [activation, installation] = yield* attempt(() =>
            Promise.all([
              jobPackageActivation(),
              privateRead(join(paths().state, "installation.json")),
            ]),
          );
          if (yield* existsEffect(lock)) {
            yield* Effect.sleep(25);
            continue;
          }
          if (requireCurrent && inspectedRunner.generation !== runner.generation)
            return yield* Effect.fail(
              new Error(
                "Script runner changed during activation inspection. Disconnect and reconnect the target before launching scripts. No user script was run",
              ),
            );
          if (requireCurrent)
            yield* Effect.try({
              try: () => assertCurrentJobPackage(activation, runner.packagePath),
              catch: (error) => error,
            });
          return createHash("sha256")
            .update(
              JSON.stringify({
                activation,
                installation,
                runner: inspectedRunner,
              }),
            )
            .digest("hex");
        }
      }),
      {
        ...options,
        timeoutMessage:
          options.timeoutMessage ??
          "Helper is busy with a launch or installation operation; activation inspection timed out. No operation was replayed",
      },
    ),
    options.signal,
  );
}
