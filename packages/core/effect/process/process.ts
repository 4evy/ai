import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import { boundedText } from "../../text/utf8";
import { assertTimerDelay } from "../../time/time";
import { attempt } from "../effect";

type Output = "pipe" | "inherit" | "ignore" | number;
export interface CommandOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: Uint8Array | "inherit" | "ignore" | undefined;
  stdout?: Output | undefined;
  stderr?: Output | undefined;
  timeout?: number | undefined;
  killSignal?: NodeJS.Signals | number | undefined;
  // Escalate to SIGKILL after this grace period, defaulting to one second
  terminationGraceMs?: number | undefined;
}

export type TerminationOptions = Pick<
  CommandOptions,
  "killSignal" | "terminationGraceMs"
>;

// Stop a child with the same bounded cleanup policy in every resource scope
export const terminateProcess = Effect.fnUntraced(function* (
  child: Pick<Bun.Subprocess, "exitCode" | "kill" | "exited">,
  options: TerminationOptions = {},
) {
  const grace = options.terminationGraceMs ?? 1000;
  yield* Effect.try({
    try: () => assertTimerDelay(grace, "Termination grace period"),
    catch: (error) => error,
  });
  if (child.exitCode !== null) return;
  yield* Effect.try({
    try: () => child.kill(options.killSignal ?? "SIGTERM"),
    catch: (error) => error,
  });
  const exited = yield* attempt(() => child.exited).pipe(
    Effect.interruptible,
    Effect.timeoutOption(grace),
  );
  if (Option.isNone(exited) && child.exitCode === null) {
    yield* Effect.try({ try: () => child.kill("SIGKILL"), catch: (error) => error });
    yield* attempt(() => child.exited);
  }
}, Effect.uninterruptible);

function capture(stream: ReadableStream<Uint8Array> | number | null | undefined) {
  return stream instanceof ReadableStream
    ? Stream.fromReadableStream({
        evaluate: () => stream,
        onError: (error) => error,
      }).pipe(Stream.decodeText, Stream.mkString)
    : Effect.succeed("");
}

// Acquisition and cleanup stay shared by ordinary and bounded command execution
const acquireCommand = Effect.fnUntraced(function* (
  command: string[],
  options: CommandOptions,
) {
  const grace = options.terminationGraceMs ?? 1000;
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        if (!command[0]) throw new Error("Missing executable");
        if (options.timeout !== undefined) assertTimerDelay(options.timeout);
        if (options.terminationGraceMs !== undefined)
          assertTimerDelay(options.terminationGraceMs, "Termination grace period");
        return Bun.spawn(command, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(options.killSignal === undefined
            ? {}
            : { killSignal: options.killSignal }),
          stdin: options.stdin ?? "ignore",
          stdout: options.stdout ?? "pipe",
          stderr: options.stderr ?? "pipe",
        });
      },
      catch: (error) => error,
    }),
    (child) => terminateProcess(child, options).pipe(Effect.orDie),
  );
  if (options.timeout)
    yield* Effect.forkScoped(
      Effect.sleep(options.timeout).pipe(
        Effect.andThen(Effect.sleep(grace)),
        Effect.andThen(
          Effect.sync(() => {
            // Bun sends the configured signal at timeout, which a
            // child can ignore
            if (child.exitCode === null) child.kill("SIGKILL");
          }),
        ),
      ),
    );
  return child;
});

// Drain both pipes while waiting for exit; the scope waits for child disposal
export const executeCommand = Effect.fnUntraced(function* (
  command: string[],
  options: CommandOptions = {},
) {
  const child = yield* acquireCommand(command, options);
  return yield* Effect.all(
    {
      stdout: capture(child.stdout),
      stderr: capture(child.stderr),
      code: Effect.promise(() => child.exited),
    },
    { concurrency: "unbounded" },
  );
}, Effect.scoped);

const boundedOutput = Effect.fnUntraced(function* (
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  limit: number,
  stop: Deferred.Deferred<void>,
) {
  if (!(stream instanceof ReadableStream)) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;
  yield* Stream.fromReadableStream({
    evaluate: () => stream,
    onError: (error) => error,
  }).pipe(
    Stream.interruptWhen(
      Deferred.await(stop).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            truncated = true;
          }),
        ),
      ),
    ),
    Stream.runForEach((bytes) =>
      Effect.sync(() => {
        const count = Math.min(bytes.length, limit - retained);
        if (count) chunks.push(bytes.slice(0, count));
        retained += count;
        truncated ||= count < bytes.length;
      }),
    ),
  );
  const decoded = boundedText(Buffer.concat(chunks), limit);
  return { text: decoded.text, truncated: truncated || decoded.limited };
});

export interface BoundedCommandOptions extends CommandOptions {
  maxOutputBytes: number;
  pipeDrainTimeoutMs: number;
}

// Retain a bounded prefix but keep draining, so output limits cannot block a child
export const executeBoundedCommand = Effect.fnUntraced(function* (
  command: string[],
  options: BoundedCommandOptions,
) {
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 0)
    return yield* Effect.fail(
      new Error("Output limit must be a nonnegative safe integer"),
    );
  yield* Effect.try({
    try: () => assertTimerDelay(options.pipeDrainTimeoutMs, "Pipe drain timeout"),
    catch: (error) => error,
  });
  const child = yield* acquireCommand(command, options);
  const stop = yield* Deferred.make<void>();
  const capture = (stream: ReadableStream<Uint8Array> | number | null | undefined) =>
    Effect.forkScoped(boundedOutput(stream, options.maxOutputBytes, stop));
  const stdout = yield* capture(child.stdout);
  const stderr = yield* capture(child.stderr);
  const [output, errors, code] = yield* Effect.all(
    [
      Fiber.join(stdout),
      Fiber.join(stderr),
      Effect.promise(() => child.exited).pipe(
        Effect.tap(() =>
          // Detached services can retain pipes after the launcher has
          // exited
          Effect.forkScoped(
            Effect.sleep(options.pipeDrainTimeoutMs).pipe(
              Effect.andThen(Deferred.succeed(stop, undefined)),
            ),
          ),
        ),
      ),
    ],
    { concurrency: "unbounded" },
  );
  return {
    code,
    stdout: output.text,
    stderr: errors.text,
    stdoutTruncated: output.truncated,
    stderrTruncated: errors.truncated,
  };
}, Effect.scoped);
