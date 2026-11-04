import { resolve as resolvePath } from "node:path";
import { PassThrough } from "node:stream";
import { attempt, run as runPromise } from "@ai/runtime/effect/effect";
import { Process } from "@oh-my-pi/pi-natives";
import {
  type Config,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { $, type Options, type ProcessOutput, type ProcessPromise } from "zx";
import { Environment, EnvironmentError, type EnvironmentValues } from "./environment";
import { CommandError, commandError } from "./errors";
import {
  type CommandIO,
  type CommandResult,
  connectPipeline,
  type PreparedIO,
  prepareIO,
  validateIO,
} from "./io";
import { Query } from "./query";

export interface CommandOptions extends CommandIO {
  cwd?: string;
  /** Literal records patch the scope, Environment plans replace it */
  env?: Environment | EnvironmentValues;
  signal?: AbortSignal;
  timeout?: Exclude<Options["timeout"], undefined>;
  verbose?: boolean;
  quiet?: boolean;
  okExitCodes?: readonly number[];
}

export interface LineOptions extends CommandOptions {
  delimiter?: string;
}

export type CommandStage =
  | readonly string[]
  | {
      readonly argv: readonly string[];
      readonly options?: CommandOptions;
    };
export type ConfigOptions = Pick<CommandOptions, "cwd" | "env" | "signal">;
type Decodable = Schema.ConstraintDecoder<unknown>;
type JsonOptions = CommandOptions & { schema?: Schema.Constraint };
interface ResolvedOptions extends Omit<CommandOptions, "cwd" | "env"> {
  cwd: string;
  env: Environment;
}

export interface CommandEffects {
  run(
    argv: readonly string[],
    options?: CommandOptions,
  ): Effect.Effect<CommandResult, CommandError>;
  text(
    argv: readonly string[],
    options?: CommandOptions,
  ): Effect.Effect<string, CommandError>;
  bytes(
    argv: readonly string[],
    options?: CommandOptions,
  ): Effect.Effect<Uint8Array, CommandError>;
  json<S extends Schema.Constraint>(
    argv: readonly string[],
    options: CommandOptions & { schema: S },
  ): Effect.Effect<S["Type"], CommandError | Schema.SchemaError, S["DecodingServices"]>;
  json(
    argv: readonly string[],
    options?: CommandOptions,
  ): Effect.Effect<unknown, CommandError | Schema.SchemaError>;
  lines(
    argv: readonly string[],
    options?: LineOptions,
  ): Effect.Effect<string[], CommandError>;
  pipe(
    stages: readonly CommandStage[],
    options?: CommandOptions,
  ): Effect.Effect<CommandResult, CommandError>;
  config<A>(
    config: Config.Config<A>,
    options?: ConfigOptions,
  ): Effect.Effect<A, EnvironmentError | Config.ConfigError>;
}

export interface CommandQueries {
  lines(argv: readonly string[], options?: CommandOptions): Query<string, CommandError>;
  jsonl<S extends Schema.Constraint>(
    argv: readonly string[],
    options: CommandOptions & { schema: S },
  ): Query<S["Type"], CommandError | Schema.SchemaError, S["DecodingServices"]>;
  jsonl(
    argv: readonly string[],
    options?: CommandOptions,
  ): Query<unknown, CommandError | Schema.SchemaError>;
  json<S extends Schema.Constraint>(
    argv: readonly string[],
    options: CommandOptions & { schema: S },
  ): Query<S["Type"], CommandError | Schema.SchemaError, S["DecodingServices"]>;
  json(
    argv: readonly string[],
    options?: CommandOptions,
  ): Query<unknown, CommandError | Schema.SchemaError>;
}

export interface Commands {
  readonly cwd: string;
  readonly env: Environment;
  readonly effect: CommandEffects;
  readonly query: CommandQueries;
  run(argv: readonly string[], options?: CommandOptions): Promise<CommandResult>;
  text(argv: readonly string[], options?: CommandOptions): Promise<string>;
  bytes(argv: readonly string[], options?: CommandOptions): Promise<Uint8Array>;
  json<S extends Decodable>(
    argv: readonly string[],
    options: CommandOptions & { schema: S },
  ): Promise<S["Type"]>;
  json(argv: readonly string[], options?: CommandOptions): Promise<unknown>;
  lines(argv: readonly string[], options?: LineOptions): Promise<string[]>;
  pipe(
    stages: readonly CommandStage[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
  config<A>(config: Config.Config<A>, options?: ConfigOptions): Promise<A>;
  with(options: CommandOptions): Commands;
  map<T, R>(
    items: readonly T[],
    callback: (item: T, index: number, signal: AbortSignal) => R | PromiseLike<R>,
    options: { concurrency: number; signal?: AbortSignal },
  ): Promise<R[]>;
  execute<A, E>(
    effect: Effect.Effect<A, E>,
    options?: { signal?: AbortSignal },
  ): Promise<A>;
}

interface PreparedCommand {
  argv: readonly string[];
  options: ResolvedOptions;
  environment: NodeJS.ProcessEnv;
  io: PreparedIO;
}
interface OwnedProcess {
  prepared: PreparedCommand;
  command: ProcessPromise;
  controller: AbortController;
  reference: Process | null;
  pump?: Fiber.Fiber<void, CommandError>;
  stream?: PassThrough;
}

function checkArgv(argv: readonly string[]): void {
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    !argv[0] ||
    argv.some((value) => typeof value !== "string" || value.includes("\0"))
  )
    throw new Error(
      "Command argv must contain an executable and NUL-free string arguments",
    );
}

function validateOptions(options: CommandOptions, capture = false): void {
  if ("input" in options) throw new Error("Use stdin descriptors instead of input");
  validateIO(options);
  if (capture && options.stdout !== undefined && options.stdout !== "capture")
    throw new Error("Text, bytes and query helpers require captured stdout");
}

function withSignal<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal?: AbortSignal,
): Effect.Effect<A, E, R> {
  if (!signal) return effect;
  return Effect.suspend(() =>
    signal.aborted
      ? Effect.interrupt
      : Effect.raceFirst(
          Effect.callback<never>((resume) => {
            const abort = () => resume(Effect.interrupt);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
            return Effect.sync(() => signal.removeEventListener("abort", abort));
          }),
          effect,
        ),
  );
}

function mergeContext(base: ResolvedOptions, options: CommandOptions): ResolvedOptions {
  const resolved: ResolvedOptions = {
    ...base,
    ...options,
    cwd: options.cwd === undefined ? base.cwd : resolvePath(base.cwd, options.cwd),
    env:
      options.env instanceof Environment
        ? options.env
        : options.env === undefined
          ? base.env
          : base.env.set(options.env),
  };
  if (typeof options.stdin === "object") resolved.stdin = { ...options.stdin };
  if (typeof options.stdout === "object") resolved.stdout = { ...options.stdout };
  if (typeof options.stderr === "object") resolved.stderr = { ...options.stderr };
  if (options.okExitCodes !== undefined)
    resolved.okExitCodes = options.okExitCodes.slice();
  return resolved;
}

function checkExit(
  output: ProcessOutput,
  result: CommandResult,
  prepared: PreparedCommand,
): CommandResult {
  const { options, argv } = prepared;
  const failure = options.signal?.aborted
    ? commandError(argv, "execute", options.signal.reason)
    : output.cause ||
        output.signal ||
        output.exitCode === null ||
        !(options.okExitCodes ?? [0]).includes(output.exitCode)
      ? commandError(argv, "exit", output)
      : undefined;
  if (failure)
    throw new CommandError({
      message: failure.message,
      phase: failure.phase,
      argv,
      cause: failure.cause,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  return result;
}

function releaseProcess(owned: OwnedProcess): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (owned.command.stage === "halted") return;
    // Unpiping can resume zx's other data listeners. Hold readable mode until
    // the tree is dead, while interrupting pumps and draining issued writes
    owned.command.stdout?.on("readable", owned.command.stdout.pause).pause();
    owned.command.stderr?.on("readable", owned.command.stderr.pause).pause();
    const reference = owned.reference;
    yield* Effect.all(
      [
        owned.pump ? Fiber.interrupt(owned.pump) : Effect.void,
        Effect.gen(function* () {
          if (reference && owned.command.stage === "running") {
            const stopped = yield* attempt(() =>
              reference.terminate({ gracefulMs: -1, timeoutMs: 1000 }),
            );
            if (!stopped)
              return yield* Effect.fail(new Error("Command process tree did not exit"));
          }
        }),
      ],
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        owned.controller.abort();
        // Paused capture pipes may still buffer data after the tree is dead
        // Close their owned fds before waiting for Node's child close event
        owned.command.stdout?.destroy();
        owned.command.stderr?.destroy();
        if (owned.command.stage !== "halted")
          yield* attempt(() => Promise.resolve(owned.command), {
            awaitOnInterrupt: true,
          });
        owned.stream?.destroy();
      }).pipe(Effect.orDie),
    ),
    Effect.orDie,
  );
}

function waitProcess(owned: OwnedProcess): Effect.Effect<ProcessOutput, CommandError> {
  return attempt(
    (signal) => {
      const abort = () => owned.controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      return Promise.resolve(owned.command).finally(() =>
        signal.removeEventListener("abort", abort),
      );
    },
    { awaitOnInterrupt: true },
  ).pipe(
    Effect.mapError((error) => commandError(owned.prepared.argv, "execute", error)),
  );
}

function acquireProcesses(
  prepared: readonly PreparedCommand[],
  streamOutput = false,
): Effect.Effect<OwnedProcess[], CommandError, Scope.Scope> {
  const owned: OwnedProcess[] = [];
  const release = () =>
    Effect.forEach(owned, releaseProcess, { concurrency: "unbounded", discard: true });
  return Effect.acquireRelease(
    Effect.gen(function* () {
      yield* Effect.try({
        try: () => {
          for (const stage of prepared) {
            const controller = new AbortController();
            const { cwd, signal, timeout, verbose, quiet } = stage.options;
            const ioOptions = { ...stage.io.options };
            if (owned.length > 0 && Array.isArray(ioOptions.stdio))
              ioOptions.stdio = ["pipe", ...ioOptions.stdio.slice(1)];
            const command = $({
              ...ioOptions,
              cwd,
              env: stage.environment,
              nothrow: true,
              halt: true,
              ...(timeout === undefined ? {} : { timeout }),
              ...(verbose === undefined ? {} : { verbose }),
              ...(quiet === undefined ? {} : { quiet }),
              signal: signal
                ? AbortSignal.any([controller.signal, signal])
                : controller.signal,
            })`${stage.argv}`;
            owned.push({ prepared: stage, command, controller, reference: null });
          }
          const last = owned[owned.length - 1]!;
          // Start consumers first and connect the real fds before yielding to I/O
          // zx's bus leaves upstream pipes open when an early consumer exits
          for (let index = owned.length - 1; index >= 0; index--)
            owned[index]!.command.run();
          for (const process of owned)
            process.reference = process.command.pid
              ? Process.fromPid(process.command.pid)
              : null;
          if (streamOutput) {
            last.stream = new PassThrough();
            last.command.stdout.pipe(last.stream);
          }
        },
        catch: (error) => commandError([], "execute", error),
      });
      for (const [index, process] of owned.entries())
        process.pump = yield* Effect.forkScoped(
          Effect.all(
            [
              process.prepared.io.connect(process.command),
              index < owned.length - 1
                ? connectPipeline(
                    process.command.stdout,
                    owned[index + 1]!.command.stdin,
                  )
                : Effect.void,
            ],
            { concurrency: "unbounded", discard: true },
          ).pipe(
            Effect.mapError((error) =>
              commandError(process.prepared.argv, "execute", error),
            ),
          ),
          { startImmediately: true, uninterruptible: false },
        );
      return owned;
    }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? release() : Effect.void))),
    release,
  );
}

function processResult(
  owned: OwnedProcess,
): Effect.Effect<CommandResult, CommandError> {
  // Successful acquisition installs all pumps before publishing the processes
  const pump = owned.pump as Fiber.Fiber<void, CommandError>;
  return Effect.all([waitProcess(owned), Fiber.join(pump)], {
    concurrency: "unbounded",
  }).pipe(
    Effect.flatMap(([output]) =>
      Effect.try({
        try: () => checkExit(output, owned.prepared.io.result(output), owned.prepared),
        catch: (error) => commandError(owned.prepared.argv, "exit", error),
      }),
    ),
  );
}

export function createCommands(defaults: CommandOptions = {}): Commands {
  return scopedCommands(
    mergeContext(
      {
        cwd: process.cwd(),
        env: defaults.env instanceof Environment ? defaults.env : Environment.inherit(),
      },
      defaults,
    ),
  );
}

function scopedCommands(context: ResolvedOptions): Commands {
  function merge(options: CommandOptions): ResolvedOptions {
    return mergeContext(context, options);
  }
  function evaluate<A, E>(
    effect: Effect.Effect<A, E>,
    options: { signal?: AbortSignal } = {},
  ): Promise<A> {
    return runPromise(effect, options.signal ?? context.signal);
  }
  function resolveOptions(
    argv: readonly string[],
    options: CommandOptions,
    capture = false,
  ) {
    return Effect.try({
      try: () => {
        const merged = merge(options);
        checkArgv(argv);
        validateOptions(merged, capture);
        return merged;
      },
      catch: (error) => commandError(argv, "input", error),
    });
  }
  function prepare(
    argv: readonly string[],
    options: ResolvedOptions,
  ): Effect.Effect<PreparedCommand, CommandError, Scope.Scope> {
    return Effect.gen(function* () {
      const { values: environment } = yield* options.env
        .resolve(options.cwd)
        .pipe(Effect.mapError((error) => commandError(argv, "input", error)));
      const io = yield* prepareIO(options, options.cwd).pipe(
        Effect.mapError((error) => commandError(argv, "execute", error)),
      );
      return { argv, options, environment, io };
    });
  }
  function command(argv: readonly string[], options: CommandOptions, capture = false) {
    return Effect.scoped(
      Effect.gen(function* () {
        const resolved = yield* resolveOptions(argv, options, capture);
        const prepared = yield* prepare(argv, resolved);
        const processes = yield* acquireProcesses([prepared]);
        return yield* processResult(processes[0]!);
      }),
    );
  }
  function configContext(options: ConfigOptions = {}) {
    return Effect.try({
      try: () => merge(options),
      catch: () =>
        new EnvironmentError({
          operation: "resolve",
          message: "Invalid execution context",
        }),
    }).pipe(Effect.flatMap((resolved) => resolved.env.resolve(resolved.cwd)));
  }

  function jsonEffect<S extends Schema.Constraint>(
    argv: readonly string[],
    options: CommandOptions & { schema: S },
  ): Effect.Effect<S["Type"], CommandError | Schema.SchemaError, S["DecodingServices"]>;
  function jsonEffect(
    argv: readonly string[],
    options?: CommandOptions,
  ): Effect.Effect<unknown, CommandError | Schema.SchemaError>;
  function jsonEffect(
    argv: readonly string[],
    { schema = Schema.Unknown, ...options }: JsonOptions = {},
  ): Effect.Effect<unknown, CommandError | Schema.SchemaError, unknown> {
    return withSignal(
      command(argv, options, true).pipe(
        Effect.flatMap((result) =>
          Effect.try({
            try: (): unknown => JSON.parse(result.stdout),
            catch: (error) => commandError(argv, "decode", error),
          }),
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      ),
      options.signal ?? context.signal,
    );
  }

  const effects: CommandEffects = {
    run(argv, options = {}) {
      return withSignal(command(argv, options), options.signal ?? context.signal);
    },
    text(argv, options = {}) {
      return withSignal(
        command(argv, options, true).pipe(Effect.map((result) => result.stdout)),
        options.signal ?? context.signal,
      );
    },
    bytes(argv, options = {}) {
      return withSignal(
        command(argv, options, true).pipe(Effect.map((result) => result.stdoutBytes)),
        options.signal ?? context.signal,
      );
    },
    json: jsonEffect,
    lines(argv, { delimiter, ...options }: LineOptions = {}) {
      return withSignal(
        Effect.gen(function* () {
          if (delimiter === "")
            return yield* Effect.fail(
              commandError(
                argv,
                "input",
                new Error("Line delimiter must not be empty"),
              ),
            );
          const { stdout } = yield* command(argv, options, true);
          if (!stdout) return [];
          const rows = stdout.split(delimiter ?? /\r?\n/u);
          if (stdout.endsWith(delimiter ?? "\n")) rows.pop();
          return rows;
        }),
        options.signal ?? context.signal,
      );
    },
    config(config, options = {}) {
      return withSignal(
        configContext(options).pipe(
          Effect.flatMap(({ provider }) => config.parse(provider)),
        ),
        options.signal ?? context.signal,
      );
    },
    pipe(stages, options = {}) {
      return withSignal(
        Effect.scoped(
          Effect.gen(function* () {
            const plans = yield* Effect.try({
              try: () => {
                if (!stages.length)
                  throw new Error("Pipeline must contain at least one command");
                const common = merge(options);
                return stages.map((stage, index) => {
                  const descriptor = "argv" in stage ? stage : { argv: stage };
                  const base = { ...common };
                  if (index > 0) delete base.stdin;
                  if (index < stages.length - 1) delete base.stdout;
                  const explicit = descriptor.options ?? {};
                  if (index > 0 && explicit.stdin !== undefined)
                    throw new Error(
                      "Only the first pipeline stage can configure stdin",
                    );
                  if (
                    index < stages.length - 1 &&
                    explicit.stdout !== undefined &&
                    explicit.stdout !== "capture"
                  )
                    throw new Error("Only the last pipeline stage can redirect stdout");
                  const resolved = mergeContext(base, explicit);
                  checkArgv(descriptor.argv);
                  validateOptions(resolved);
                  return { argv: descriptor.argv, options: resolved };
                });
              },
              catch: (error) => commandError([], "input", error),
            });
            // Resolve every environment before opening output files or launching work
            const environments = yield* Effect.forEach(plans, (plan) =>
              plan.options.env
                .resolve(plan.options.cwd)
                .pipe(
                  Effect.mapError((error) => commandError(plan.argv, "input", error)),
                ),
            );
            const prepared = yield* Effect.forEach(plans, (plan, index) =>
              prepareIO(plan.options, plan.options.cwd).pipe(
                Effect.map((io) => ({
                  ...plan,
                  io,
                  environment: environments[index]!.values,
                })),
                Effect.mapError((error) => commandError(plan.argv, "execute", error)),
              ),
            );
            const processes = yield* acquireProcesses(prepared);
            const results = yield* Effect.all(
              processes.map((process) =>
                Effect.all(
                  [
                    waitProcess(process),
                    Fiber.join(process.pump as Fiber.Fiber<void, CommandError>),
                  ],
                  { concurrency: "unbounded" },
                ).pipe(
                  Effect.map(([output]) => ({
                    output,
                    result: process.prepared.io.result(output),
                    prepared: process.prepared,
                  })),
                ),
              ),
              { concurrency: "unbounded" },
            );
            return yield* Effect.try({
              try: () => {
                for (const result of results) {
                  checkExit(result.output, result.result, result.prepared);
                }
                return results[results.length - 1]!.result;
              },
              catch: (error) => commandError([], "exit", error),
            });
          }),
        ),
        options.signal ?? context.signal,
      );
    },
  };

  function linesQuery(
    argv: readonly string[],
    options: CommandOptions = {},
  ): Query<string, CommandError> {
    const signal = options.signal ?? context.signal;
    return new Query(
      Stream.unwrap(
        withSignal(
          Effect.gen(function* () {
            const resolved = yield* resolveOptions(argv, options, true);
            const prepared = yield* prepare(argv, resolved);
            const processes = yield* acquireProcesses([prepared], true);
            const owned = processes[0]!;
            const pump = owned.pump as Fiber.Fiber<void, CommandError>;
            return Stream.fromAsyncIterable<Uint8Array, CommandError>(
              owned.stream!,
              (error) => commandError(argv, "execute", error),
            ).pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.interruptWhen(
                withSignal(Fiber.join(pump).pipe(Effect.andThen(Effect.never)), signal),
              ),
              Stream.concat(Stream.fromEffectDrain(processResult(owned))),
            );
          }),
          signal,
        ),
      ),
    );
  }
  function jsonlQuery<S extends Schema.Constraint>(
    argv: readonly string[],
    options: CommandOptions & { schema: S },
  ): Query<S["Type"], CommandError | Schema.SchemaError, S["DecodingServices"]>;
  function jsonlQuery(
    argv: readonly string[],
    options?: CommandOptions,
  ): Query<unknown, CommandError | Schema.SchemaError>;
  function jsonlQuery(
    argv: readonly string[],
    { schema = Schema.Unknown, ...options }: JsonOptions = {},
  ): Query<unknown, CommandError | Schema.SchemaError, unknown> {
    return linesQuery(argv, options)
      .where((line) => line.trim() !== "")
      .mapEffect((line) =>
        Effect.try({
          try: (): unknown => JSON.parse(line),
          catch: (error) => commandError(argv, "decode", error),
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema))),
      );
  }
  function jsonQuery<S extends Schema.Constraint>(
    argv: readonly string[],
    options: CommandOptions & { schema: S },
  ): Query<S["Type"], CommandError | Schema.SchemaError, S["DecodingServices"]>;
  function jsonQuery(
    argv: readonly string[],
    options?: CommandOptions,
  ): Query<unknown, CommandError | Schema.SchemaError>;
  function jsonQuery(
    argv: readonly string[],
    { schema = Schema.Unknown, ...options }: JsonOptions = {},
  ): Query<unknown, CommandError | Schema.SchemaError, unknown> {
    return Query.fromEffect(
      jsonEffect(argv, options).pipe(
        Effect.flatMap((value) =>
          Array.isArray(value)
            ? Effect.succeed(value as unknown[])
            : Effect.fail(
                commandError(
                  argv,
                  "decode",
                  new Error("JSON query requires an array of rows"),
                ),
              ),
        ),
      ),
    ).decode(schema);
  }
  function json<S extends Decodable>(
    argv: readonly string[],
    options: CommandOptions & { schema: S },
  ): Promise<S["Type"]>;
  function json(argv: readonly string[], options?: CommandOptions): Promise<unknown>;
  function json(
    argv: readonly string[],
    {
      schema = Schema.Unknown,
      ...options
    }: CommandOptions & { schema?: Decodable } = {},
  ): Promise<unknown> {
    return evaluate(jsonEffect(argv, { ...options, schema }), options);
  }
  return {
    cwd: context.cwd,
    env: context.env,
    effect: effects,
    query: { lines: linesQuery, jsonl: jsonlQuery, json: jsonQuery },
    run(argv, options = {}) {
      return evaluate(effects.run(argv, options), options);
    },
    text(argv, options = {}) {
      return evaluate(effects.text(argv, options), options);
    },
    bytes(argv, options = {}) {
      return evaluate(effects.bytes(argv, options), options);
    },
    json,
    lines(argv, options = {}) {
      return evaluate(effects.lines(argv, options), options);
    },
    pipe(stages, options = {}) {
      return evaluate(effects.pipe(stages, options), options);
    },
    config(config, options = {}) {
      return evaluate(effects.config(config, options), options);
    },
    with(options) {
      return scopedCommands(merge(options));
    },
    map(items, callback, { concurrency, signal = context.signal }) {
      return runPromise(
        Effect.suspend(() =>
          Number.isSafeInteger(concurrency) && concurrency > 0
            ? Effect.forEach(
                items,
                (item, index) =>
                  attempt((signal) => Promise.resolve(callback(item, index, signal)), {
                    awaitOnInterrupt: true,
                  }),
                { concurrency },
              )
            : Effect.fail(new Error("map concurrency must be a positive safe integer")),
        ),
        signal,
      );
    },
    execute(effect, options = {}) {
      return evaluate(
        configContext().pipe(
          Effect.flatMap(({ provider }) =>
            Effect.provideService(effect, ConfigProvider.ConfigProvider, provider),
          ),
        ),
        options,
      );
    },
  };
}
