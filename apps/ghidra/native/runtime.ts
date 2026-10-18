#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { writeFile as atomicWrite } from "atomically";
import {
  type Installation,
  installed,
  java,
  javaHome,
  platform,
  stateHome,
} from "./common.ts";

// Recursive readdir follows directory symlinks, which must not extend the classpath
async function jars(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await jars(path)));
    else if (entry.isFile() && entry.name.endsWith(".jar")) result.push(path);
  }
  return result.sort();
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

async function server(
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
  const classpath = (await jars(join(ghidra, "Ghidra"))).join(delimiter);
  let classpathArgs = ["-cp", classpath];
  if (platform().name === "win32") {
    // Ghidra's full classpath can exceed Windows' command-line length limit
    const digest = createHash("sha256").update(classpath).digest("hex");
    const file = join(stateHome(), "runtime", `classpath-${digest}.args`);
    await atomicWrite(
      file,
      `-cp\n"${classpath.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`,
    );
    classpathArgs = [`@${file}`];
  }
  return Bun.spawn(
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
  );
}

function bridge(receipt: Installation, args: string[], env: NodeJS.ProcessEnv) {
  return Bun.spawn(
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
  );
}

async function ready(env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const response = await fetch(
      `${env.GHIDRA_MCP_URL?.replace(/\/+$/, "")}/check_connection`,
      {
        signal: AbortSignal.timeout(1000),
        headers: env.GHIDRA_MCP_AUTH_TOKEN
          ? { Authorization: `Bearer ${env.GHIDRA_MCP_AUTH_TOKEN}` }
          : {},
      },
    );
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function ghidra(
  receipt: Installation,
  action: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const directory = join(receipt.directory, "ghidra");
  const launcher = Bun.spawn(
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
  const options = (await new Response(launcher.stdout).text())
    .split(/\r?\n/)
    .filter(Boolean);
  if ((await launcher.exited) !== 0)
    throw new Error("Ghidra launch settings could not be read");
  if (action === "analyzeHeadless") options.push("-Djava.awt.headless=true");
  options.push(...(env.JAVA_OPTS ?? "").trim().split(/\s+/).filter(Boolean));
  return Bun.spawn(
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
  );
}

export async function launch(action: string, args: string[]): Promise<number> {
  const receipt = await installed();
  if (!receipt)
    throw new Error("Install the native runtime with ai ghidra install first");
  const env = await environment(receipt);
  const owned: Bun.Subprocess[] = [];
  let interrupted = 0;
  const stop = (signal: NodeJS.Signals) => {
    interrupted = signal === "SIGINT" ? 130 : 143;
    for (const child of owned) child.kill();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    let child: Bun.Subprocess;
    const direct = ["gui", "analyzeHeadless", "httpd", "bridge"].includes(action);
    const help = args.includes("--help") || args.includes("-h");
    switch (!direct && help ? "bridge" : action) {
      case "gui":
      case "analyzeHeadless":
        child = await ghidra(receipt, action, args, env);
        break;
      case "httpd":
        child = await server(receipt, args, env);
        break;
      case "bridge":
        child = bridge(receipt, args, env);
        break;
      case "headless": {
        const timeout = env.GHIDRA_MCP_STARTUP_TIMEOUT ?? "120";
        if (!/^[1-9]\d*$/.test(timeout))
          throw new Error("GHIDRA_MCP_STARTUP_TIMEOUT must be a positive integer");
        const log = env.GHIDRA_MCP_HTTPD_LOG ?? join(stateHome(), "httpd.log");
        let backend: Bun.Subprocess | undefined;
        if (env.GHIDRA_MCP_START_HTTPD !== "0" && !(await ready(env))) {
          const url = new URL(env.GHIDRA_MCP_URL ?? "");
          if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
            throw new Error(
              "A remote Ghidra backend is unavailable; start it on its host",
            );
          await mkdir(dirname(log), { recursive: true, mode: 0o700 });
          const descriptor = openSync(log, "a", 0o600);
          try {
            backend = await server(receipt, [], env, descriptor);
            owned.push(backend);
          } finally {
            closeSync(descriptor);
          }
        }
        if (env.GHIDRA_MCP_SKIP_WAIT !== "1") {
          const deadline = Date.now() + Number(timeout) * 1000;
          while (!(await ready(env))) {
            if (interrupted) return interrupted;
            if (backend?.exitCode !== null && backend?.exitCode !== undefined)
              throw new Error(
                `Ghidra MCP backend exited with ${backend.exitCode}; see ${log}`,
              );
            if (Date.now() >= deadline)
              throw new Error(
                `Timed out waiting for ${env.GHIDRA_MCP_URL}; see ${log}`,
              );
            await Bun.sleep(250);
          }
        }
        child = bridge(receipt, args, env);
        break;
      }
      default:
        throw new Error(`Unknown native Ghidra command: ${action}`);
    }
    owned.push(child);
    if (interrupted) child.kill();
    const code = await child.exited;
    return interrupted || code;
  } finally {
    for (const child of owned) if (child.exitCode === null) child.kill();
    await Promise.all(owned.map((child) => child.exited));
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
