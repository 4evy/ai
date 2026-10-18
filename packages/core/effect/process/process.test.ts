import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { run } from "../effect";
import { executeCommand } from "./process";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "ai process tests "));
  directories.push(path);
  return path;
}

test("preserves Unicode and shell metacharacters as literal arguments", async () => {
  const arguments_ = ["a b", "a'b\"c", "$HOME; $(echo injected)", "🩷 日本語", ""];
  const result = await Effect.runPromise(
    executeCommand([
      process.execPath,
      "-e",
      "console.log(JSON.stringify(process.argv.slice(1)))",
      ...arguments_,
    ]),
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(arguments_);
  expect(result.stderr).toBe("");
});

test("drains stdout and stderr beyond pipe capacity without deadlocking", async () => {
  const bytes = 256 * 1024;
  const result = await Effect.runPromise(
    executeCommand([
      process.execPath,
      "-e",
      `process.stdout.write('o'.repeat(${bytes})); process.stderr.write('e'.repeat(${bytes}))`,
    ]),
  );
  expect(result).toEqual({
    code: 0,
    stdout: "o".repeat(bytes),
    stderr: "e".repeat(bytes),
  });
}, 10_000);

test("delivers stdin including Unicode and embedded newlines", async () => {
  const input = "first line\n🩷 日本語\n";
  const result = await Effect.runPromise(
    executeCommand(
      [process.execPath, "-e", "process.stdout.write(await Bun.stdin.text())"],
      {
        stdin: new TextEncoder().encode(input),
      },
    ),
  );
  expect(result).toEqual({ code: 0, stdout: input, stderr: "" });
});

test("keeps output and the exit code of a failed command", async () => {
  const result = await Effect.runPromise(
    executeCommand([
      process.execPath,
      "-e",
      "console.log('partial output'); console.error('command failed'); process.exitCode = 17",
    ]),
  );
  expect(result).toEqual({
    code: 17,
    stdout: "partial output\n",
    stderr: "command failed\n",
  });
});

test("honors working directories with spaces and explicit environment values", async () => {
  const cwd = await directory();
  const result = await Effect.runPromise(
    executeCommand(
      [
        process.execPath,
        "-e",
        "console.log(JSON.stringify({cwd: process.cwd(), value: process.env.AI_PROCESS_TEST}))",
      ],
      { cwd, env: { ...process.env, AI_PROCESS_TEST: "literal $value 🩷" } },
    ),
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    cwd: realpathSync(cwd),
    value: "literal $value 🩷",
  });
});

test("terminates a command that exceeds its timeout", async () => {
  const result = await Effect.runPromise(
    executeCommand(
      [process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
      {
        timeout: 1000,
      },
    ),
  );
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("ready\n");
}, 10_000);

test("aborting waits for child cleanup and preserves the cancellation reason", async () => {
  const ready = join(await directory(), "ready");
  const controller = new AbortController();
  const reason = new Error("Cancelled by the test");
  const command = run(
    executeCommand([
      process.execPath,
      "-e",
      "await Bun.write(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
      ready,
    ]),
    controller.signal,
  );
  // Observe rejection immediately while waiting for the child readiness handshake
  const outcome = command.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    const deadline = performance.now() + 5000;
    while (!(await Bun.file(ready).exists())) {
      if (performance.now() >= deadline) throw new Error("Child never became ready");
      await Bun.sleep(10);
    }
    const pid = Number(await readFile(ready, "utf8"));
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort(reason);
    await outcome;
  }
}, 10_000);
