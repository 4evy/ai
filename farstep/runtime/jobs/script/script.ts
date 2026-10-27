import {
  type ChildProcess,
  type SpawnSyncOptions,
  spawn,
  spawnSync,
} from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import { shellFlags } from "@ai/core/shell/flags";
import { Process } from "@oh-my-pi/pi-natives";
import * as v from "valibot";
import * as zx from "zx";
import {
  checkScriptInput,
  DEFAULT_CAPTURE_BYTES,
  scriptInputSchema,
} from "../../../protocol/script/script";

interface RunningCommand {
  child: ChildProcess;
  process: Process | null;
  closed: Promise<void>;
}

async function runScript(
  input: unknown,
  shell: "bash" | "zsh",
  application: string,
): Promise<number> {
  checkScriptInput(input);
  const script = v.parse(scriptInputSchema, input);
  const captureBytes = script.captureBytes ?? DEFAULT_CAPTURE_BYTES;
  const children = new Set<RunningCommand>();
  let captureError: Error | undefined;
  const captureFailure = Promise.withResolvers<never>();
  let directory: string | undefined;

  function stop(command: RunningCommand, signal = 9): void {
    try {
      command.process?.killTree(signal);
    } finally {
      if (command.child.exitCode === null && command.child.signalCode === null)
        command.child.kill(signal === 9 ? "SIGKILL" : "SIGTERM");
    }
  }

  function cleanup(signal = 9): void {
    for (const child of children) stop(child, signal);
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
  const signals = (
    [
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const
  ).map(([name, status]) => ({
    name,
    handle: () => {
      cleanup(15);
      process.exit(status);
    },
  }));
  for (const { name, handle } of signals) process.on(name, handle);

  Object.assign(zx.defaults, {
    shell: application,
    quote: zx.quote,
    prefix: "set -euo pipefail;",
    postfix: "",
    env: process.env,
    cwd: undefined,
    detached: false,
    verbose: false,
    quiet: false,
    stdio: "pipe",
    store: undefined,
    nothrow: false,
    sync: false,
    preferLocal: false,
  });

  // Use non-login shell flags for each command; the launch shell has already
  // loaded the chosen login/shared environment, envFiles and explicit overrides
  zx.$.spawn = ((command, args, options) => {
    if (captureError) throw captureError;
    const child = spawn(
      application,
      [...shellFlags(shell, false), "-c", String(command), ...(args ?? [])],
      {
        ...options,
        shell: false,
        detached: false,
      },
    );
    const running: RunningCommand = {
      child,
      process: child.pid ? Process.fromPid(child.pid) : null,
      closed: new Promise((resolve) =>
        child.once("close", () => {
          children.delete(running);
          resolve();
        }),
      ),
    };
    children.add(running);
    let bytes = 0;
    const bounded = (stream: Readable | null): Readable | null => {
      if (!stream) return null;
      const limit = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          const remaining = Math.max(0, captureBytes - bytes);
          bytes += chunk.length;
          if (remaining) this.push(chunk.subarray(0, remaining));
          if (bytes > captureBytes && !captureError) {
            captureError = new Error(
              `zx command output exceeds captureBytes (${captureBytes}); redirect large output to a target file`,
            );
            captureFailure.reject(captureError);
            stop(running);
          }
          callback();
        },
      });
      stream.on("error", (error) => child.emit("error", error));
      return stream.pipe(limit);
    };
    // Bound streams before zx retains them in stdout, stderr and stdall stores
    child.stdout = bounded(child.stdout);
    child.stderr = bounded(child.stderr);
    return child;
  }) as typeof spawn;

  zx.$.spawnSync = ((
    command: string,
    args: readonly string[] = [],
    options: SpawnSyncOptions = {},
  ) => {
    if (captureError) throw captureError;
    const result = spawnSync(
      application,
      [...shellFlags(shell, false), "-c", String(command), ...(args ?? [])],
      {
        ...options,
        shell: false,
        maxBuffer: captureBytes,
      },
    );
    if (
      (result.stdout?.length ?? 0) + (result.stderr?.length ?? 0) > captureBytes ||
      (result.error && "code" in result.error && result.error.code === "ENOBUFS")
    ) {
      captureError = new Error(
        `zx command output exceeds captureBytes (${captureBytes})`,
      );
      captureFailure.reject(captureError);
      throw captureError;
    }
    return result;
  }) as unknown as typeof spawnSync;

  zx.$.log = (entry) => {
    if (entry.kind === "stdout") {
      if (entry.verbose) process.stdout.write(entry.data);
    } else zx.log(entry);
  };

  try {
    directory = await mkdtemp(join(tmpdir(), "farstep-script-"));
    await mkdir(join(directory, "node_modules"), { mode: 0o700 });
    // Resolve imports of zx to the pinned package even when cwd has another zx
    await symlink(
      dirname(Bun.resolveSync("zx/package.json", import.meta.dir)),
      join(directory, "node_modules/zx"),
      "dir",
    );
    const source = join(directory, "script.ts");
    await writeFile(source, script.script, { mode: 0o600 });
    Object.assign(globalThis, { $: zx.$, zx, params: script.params ?? {} });
    await Promise.race([import(pathToFileURL(source).href), captureFailure.promise]);
    if (captureError) throw captureError;
    if (children.size)
      throw new Error(
        "Script finished with running zx commands; await every command before returning",
      );
    return Number(process.exitCode ?? 0);
  } catch (error) {
    console.error(
      error instanceof zx.ProcessOutput
        ? error.message
        : error instanceof Error
          ? (error.stack ?? error.message)
          : String(error),
    );
    return error instanceof zx.ProcessOutput && error.exitCode ? error.exitCode : 1;
  } finally {
    cleanup();
    await Promise.all(Array.from(children, (child) => child.closed));
    for (const { name, handle } of signals) process.off(name, handle);
  }
}

if (import.meta.main) {
  const [mode, shell, application, payload, ...extra] = Bun.argv.slice(2);
  if (
    mode !== "--script" ||
    (shell !== "bash" && shell !== "zsh") ||
    !application?.startsWith("/") ||
    !payload ||
    extra.length
  )
    throw new Error("Invalid native TypeScript script invocation");
  const status = await runScript(JSON.parse(payload), shell, application);
  process.exitCode = status;
  if (status !== 0) {
    // Failed scripts must not stay alive through timers left by their source
    await Promise.all(
      [process.stdout, process.stderr].map(
        (stream) => new Promise<void>((resolve) => stream.write("", () => resolve())),
      ),
    );
    process.exit(status);
  }
}
