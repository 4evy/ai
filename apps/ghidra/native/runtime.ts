#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { attempt, run } from "@ai/core/effect/effect";
import { executeCommand, terminateProcess } from "@ai/core/effect/process/process";
import { walk } from "@nodelib/fs.walk/promises";
import { writeFile as atomicWrite } from "atomically";
import { Effect, Schedule } from "effect";
import {
  type Installation,
  installed,
  java,
  javaHome,
  platform,
  stateHome,
} from "./common.ts";

// Directory and file symlinks must not extend the classpath
async function jars(directory: string): Promise<string[]> {
  const entries = await walk(directory, {
    concurrency: 1,
    followSymbolicLinks: false,
    entryFilter: (entry) => entry.dirent.isFile() && entry.name.endsWith(".jar"),
  });
  return entries.map((entry) => entry.path).sort();
}

async function environment(receipt: Installation): Promise<NodeJS.ProcessEnv> {
  const state = stateHome();
  for (const directory of [
    state,
    join(state, "home"),
    join(state, "tmp"),
    join(state, "runtime"),
  ])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  return {
    ...process.env,
    JAVA_HOME: javaHome(receipt),
    GHIDRA_MCP_STATE: state,
    GHIDRA_MCP_URL:
      process.env.GHIDRA_MCP_URL ??
      `http://${process.env.GHIDRA_MCP_CONNECT_HOST ?? "127.0.0.1"}:${process.env.GHIDRA_MCP_PORT ?? "8089"}`,
    TMPDIR: process.env.TMPDIR ?? join(state, "tmp"),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? join(state, "runtime"),
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

const server = Effect.fnUntraced(function* (
  receipt: Installation,
  args: string[],
  env: NodeJS.ProcessEnv,
  log?: number,
) {
  const ghidra = join(receipt.directory, "ghidra");
  const options = (env.JAVA_OPTS ?? "").trim().split(/\s+/).filter(Boolean);
  const extra = (env.GHIDRA_MCP_EXTRA_ARGS ?? "").trim().split(/\s+/).filter(Boolean);
  const defaults = [
    "--bind",
    env.GHIDRA_MCP_BIND ?? "127.0.0.1",
    "--port",
    env.GHIDRA_MCP_PORT ?? "8089",
  ];
  for (const [name, flag] of [
    ["PROGRAM_FILE", "--file"],
    ["PROJECT_PATH", "--project"],
    ["PROGRAM_NAME", "--program"],
  ])
    if (name && flag && env[name]) defaults.push(flag, env[name]);
  if (env.GHIDRA_USER) options.push(`-Duser.name=${env.GHIDRA_USER}`);
  const classpath = (yield* attempt(() => jars(join(ghidra, "Ghidra")))).join(
    delimiter,
  );
  let classpathArgs = ["-cp", classpath];
  if (platform().name === "win32") {
    // Ghidra's full classpath can exceed Windows' command-line length limit
    const digest = createHash("sha256").update(classpath).digest("hex");
    const file = join(stateHome(), "runtime", `classpath-${digest}.args`);
    yield* attempt(
      () =>
        atomicWrite(
          file,
          `-cp\n"${classpath.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`,
        ),
      { awaitOnInterrupt: true },
    );
    classpathArgs = [`@${file}`];
  }
  return yield* own(() =>
    Bun.spawn(
      [
        java(receipt),
        ...options,
        `-Duser.home=${join(stateHome(), "home")}`,
        `-Djava.io.tmpdir=${env.TMPDIR}`,
        `-Dghidra.home=${ghidra}`,
        "-Djava.awt.headless=true",
        "-Dapplication.name=GhidraMCP",
        ...classpathArgs,
        "com.xebyte.headless.GhidraMCPHeadlessServer",
        ...defaults,
        ...extra,
        ...args,
      ],
      { env, stdin: "ignore", stdout: log ?? "inherit", stderr: log ?? "inherit" },
    ),
  );
});

function own<A extends Bun.Subprocess>(spawn: () => A) {
  return Effect.acquireRelease(
    Effect.try({ try: spawn, catch: (error) => error }),
    (child) => terminateProcess(child).pipe(Effect.orDie),
  );
}

function bridge(receipt: Installation, args: string[], env: NodeJS.ProcessEnv) {
  return own(() =>
    Bun.spawn(
      [
        join(receipt.directory, platform().python),
        "-m",
        "bridge_mcp_ghidra",
        "--transport",
        env.GHIDRA_MCP_BRIDGE_TRANSPORT ?? "stdio",
        "--mcp-host",
        env.GHIDRA_MCP_BRIDGE_HOST ?? "127.0.0.1",
        "--mcp-port",
        env.GHIDRA_MCP_BRIDGE_PORT ?? "8090",
        "--no-lazy",
        ...args,
      ],
      { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    ),
  );
}

function ready(env: NodeJS.ProcessEnv) {
  return attempt(
    async (signal) => {
      const response = await fetch(
        `${env.GHIDRA_MCP_URL?.replace(/\/+$/, "")}/check_connection`,
        {
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
          headers: env.GHIDRA_MCP_AUTH_TOKEN
            ? { Authorization: `Bearer ${env.GHIDRA_MCP_AUTH_TOKEN}` }
            : {},
        },
      );
      await response.body?.cancel();
      return response.ok;
    },
    { awaitOnInterrupt: true },
  ).pipe(Effect.catch(() => Effect.succeed(false)));
}

const ghidra = Effect.fnUntraced(function* (
  receipt: Installation,
  action: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const directory = join(receipt.directory, "ghidra");
  const launcher = yield* executeCommand(
    [
      java(receipt),
      "-cp",
      join(directory, "support/LaunchSupport.jar"),
      "LaunchSupport",
      directory,
      "-vmargs",
    ],
    { env, stdout: "pipe", stderr: "inherit" },
  );
  const options = launcher.stdout.split(/\r?\n/).filter(Boolean);
  if (launcher.code !== 0)
    return yield* Effect.fail(new Error("Ghidra launch settings could not be read"));
  if (action === "analyzeHeadless") options.push("-Djava.awt.headless=true");
  options.push(...(env.JAVA_OPTS ?? "").trim().split(/\s+/).filter(Boolean));
  return yield* own(() =>
    Bun.spawn(
      [
        java(receipt),
        ...options,
        "-cp",
        join(directory, "Ghidra/Framework/Utility/lib/Utility.jar"),
        "ghidra.Ghidra",
        action === "gui"
          ? "ghidra.GhidraRun"
          : "ghidra.app.util.headless.AnalyzeHeadless",
        ...args,
      ],
      { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    ),
  );
});

export async function launch(action: string, args: string[]): Promise<number> {
  const receipt = await installed();
  if (!receipt)
    throw new Error("Install the native runtime with ai ghidra install first");
  const env = await environment(receipt);
  const controller = new AbortController();
  let interrupted = 0;
  const stop = (signal: NodeJS.Signals) => {
    interrupted = signal === "SIGINT" ? 130 : 143;
    controller.abort(new Error("Ghidra launch interrupted"));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await run(
      Effect.scoped(
        Effect.gen(function* () {
          let child: Bun.Subprocess;
          const direct = ["gui", "analyzeHeadless", "httpd", "bridge"].includes(action);
          const help = args.includes("--help") || args.includes("-h");
          switch (!direct && help ? "bridge" : action) {
            case "gui":
            case "analyzeHeadless":
              child = yield* ghidra(receipt, action, args, env);
              break;
            case "httpd":
              child = yield* server(receipt, args, env);
              break;
            case "bridge":
              child = yield* bridge(receipt, args, env);
              break;
            case "headless": {
              const timeout = env.GHIDRA_MCP_STARTUP_TIMEOUT ?? "120";
              if (!/^[1-9]\d*$/.test(timeout))
                return yield* Effect.fail(
                  new Error("GHIDRA_MCP_STARTUP_TIMEOUT must be a positive integer"),
                );
              const log = env.GHIDRA_MCP_HTTPD_LOG ?? join(stateHome(), "httpd.log");
              let backend: Bun.Subprocess | undefined;
              if (env.GHIDRA_MCP_START_HTTPD !== "0" && !(yield* ready(env))) {
                const url = new URL(env.GHIDRA_MCP_URL ?? "");
                if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
                  return yield* Effect.fail(
                    new Error(
                      "A remote Ghidra backend is unavailable; start it on its host",
                    ),
                  );
                yield* attempt(
                  () => mkdir(dirname(log), { recursive: true, mode: 0o700 }),
                  { awaitOnInterrupt: true },
                );
                backend = yield* Effect.acquireUseRelease(
                  Effect.try({
                    try: () => openSync(log, "a", 0o600),
                    catch: (error) => error,
                  }),
                  (descriptor) => server(receipt, [], env, descriptor),
                  (descriptor) => Effect.sync(() => closeSync(descriptor)),
                );
              }
              if (env.GHIDRA_MCP_SKIP_WAIT !== "1") {
                yield* Effect.gen(function* () {
                  const connected = yield* ready(env);
                  if (
                    !connected &&
                    backend?.exitCode !== null &&
                    backend?.exitCode !== undefined
                  )
                    return yield* Effect.fail(
                      new Error(
                        `Ghidra MCP backend exited with ${backend.exitCode}; see ${log}`,
                      ),
                    );
                  return connected;
                }).pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced(250),
                    while: (connected) => !connected,
                  }),
                  Effect.timeoutOrElse({
                    duration: Number(timeout) * 1000,
                    orElse: () =>
                      Effect.fail(
                        new Error(
                          `Timed out waiting for ${env.GHIDRA_MCP_URL}; see ${log}`,
                        ),
                      ),
                  }),
                );
              }
              child = yield* bridge(receipt, args, env);
              break;
            }
            default:
              return yield* Effect.fail(
                new Error(`Unknown native Ghidra command: ${action}`),
              );
          }
          return yield* attempt(() => child.exited);
        }),
      ),
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.aborted) return interrupted;
    throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await launch(Bun.argv[2] ?? "", Bun.argv.slice(3));
  } catch (error) {
    console.error(
      `ai ghidra: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
