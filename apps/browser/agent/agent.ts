import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { attempt, flushObservability, run } from "@ai/core/effect/effect";
import { executeCommand } from "@ai/core/effect/process/process";
import { errorCode, errorMessage } from "@ai/core/error/error";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import { or } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { map, multiple } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { command, flag, option, passThrough } from "@optique/core/primitives";
import { valibot } from "@optique/valibot";
import { writeFile } from "atomically";
import { Effect, Schedule } from "effect";
import * as v from "valibot";

const pathValue = valibot(
  v.pipe(v.string(), v.nonEmpty(), v.excludes("\0", "NUL is not allowed")),
  { metavar: "PATH", placeholder: "" },
);

export const START_TIMEOUT_MS = 15_000;

export type BrowserConfiguration = {
  commandName: string;
  browserName: string;
  environmentVariable: string;
  browserCommands: readonly string[];
  macosBrowsers: readonly (readonly [string, string])[];
  usage: string;
  probe: (command: string[]) => Effect.Effect<string, unknown>;
};

type Options = {
  browser: string | undefined;
  browserArguments: string[];
  help: boolean;
  refresh: boolean;
};

export function hasErrorCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

// Partially written discovery files are retried; native exits and I/O failures
// fail immediately, and one scoped deadline cancels the entire polling loop
export function readBrowserPort(
  path: string,
  browser: Bun.Subprocess,
  interfaceName: string,
  decode: (text: string) => number | undefined,
) {
  const pending = new Error(
    `Browser did not expose a ${interfaceName} port within ${START_TIMEOUT_MS / 1000} seconds`,
  );
  return attempt(async (signal) => {
    if (browser.exitCode !== null)
      throw new Error(`Browser exited with status ${browser.exitCode}`);
    try {
      const port = decode(await readFile(path, { encoding: "utf8", signal }));
      if (port !== undefined && Number.isInteger(port) && port > 0 && port <= 65_535)
        return port;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !(error instanceof SyntaxError))
        throw toError(error);
    }
    throw pending;
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced(25),
      while: (error) => error === pending,
    }),
    Effect.timeoutOrElse({
      duration: START_TIMEOUT_MS,
      orElse: () => Effect.fail(pending),
    }),
  );
}

function parseArguments(
  arguments_: string[],
  configuration: BrowserConfiguration,
): Options {
  const forwarded = passThrough({ format: "greedy" });
  // Keep the separator branch active until its entire opaque tail is consumed
  // Empty tails still complete, even though they cannot be skipped mid-parse
  const browserArguments = command("--", {
    ...forwarded,
    canSkip: (state: readonly string[]) => state.length > 0,
  });
  const parsed = parseSync(
    multiple(
      or(
        map(browserArguments, (browserArguments) => ({ browserArguments })),
        map(option("--browser", pathValue), (browser) => ({ browser })),
        map(flag("--refresh"), () => ({ refresh: true })),
        map(flag("--help", "-h"), () => ({ help: true })),
      ),
    ),
    arguments_,
  );
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  const values: Partial<Options> = {};
  for (const value of parsed.value) {
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(values, key))
        throw new Error(`Option specified more than once: ${key}`);
    }
    Object.assign(values, value);
  }
  return {
    browser: values.browser ?? Bun.env[configuration.environmentVariable],
    browserArguments: values.browserArguments ?? [],
    help: values.help ?? false,
    refresh: values.refresh ?? false,
  };
}

function resolveBrowser(
  executable: string | undefined,
  configuration: BrowserConfiguration,
): string {
  if (executable !== undefined) {
    const launcher = Bun.which(executable);
    if (!launcher) {
      throw new Error(`Browser executable not found: ${executable}`);
    }
    return launcher;
  }

  for (const command of configuration.browserCommands) {
    const launcher = Bun.which(command);
    if (launcher) return launcher;
  }

  const macos = process.platform === "darwin" ? macosBrowser(configuration) : undefined;
  if (macos) return macos;

  throw new Error(
    `No ${configuration.browserName} browser found; use --browser EXECUTABLE or set ${configuration.environmentVariable}`,
  );
}

function macosBrowser(configuration: BrowserConfiguration): string | undefined {
  for (const directory of [join(homedir(), "Applications"), "/Applications"]) {
    for (const [bundle, executable] of configuration.macosBrowsers) {
      const launcher = Bun.which(join(directory, bundle, "Contents/MacOS", executable));
      if (launcher) return launcher;
    }
  }
  return undefined;
}

const readBrowserVersion = Effect.fnUntraced(function* (command: string[]) {
  const {
    code: exitCode,
    stderr,
    stdout,
  } = yield* executeCommand([...command, "--version"], {
    timeout: START_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (exitCode !== 0) {
    const detail = stderr.trim();
    return yield* Effect.fail(
      new Error(`Browser version check failed${detail ? `: ${detail}` : ""}`),
    );
  }
  const version = stdout.trim();
  if (!version)
    return yield* Effect.fail(new Error("Browser version check returned no output"));
  return version;
});

function userAgentCachePath(command: string[], commandName: string): string {
  const cacheHome = Bun.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const key = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(command))
    .digest("hex");
  return join(cacheHome, commandName, `${key}.json`);
}

const readCachedUserAgent = Effect.fnUntraced(
  function* (path: string, browserVersion: string) {
    const contents = yield* attempt((signal) =>
      readFile(path, { encoding: "utf8", signal }),
    );
    const value = yield* Effect.try({
      try: () => JSON.parse(contents),
      catch: (error) => error,
    });
    const entry = v.safeParse(
      v.object({
        browserVersion: v.literal(browserVersion),
        userAgent: v.pipe(v.string(), v.nonEmpty()),
      }),
      value,
    );
    return entry.success ? entry.output.userAgent : undefined;
  },
  (effect) =>
    effect.pipe(
      Effect.catch((error) =>
        hasErrorCode(error, "ENOENT") || error instanceof SyntaxError
          ? Effect.succeed(undefined)
          : Effect.fail(error),
      ),
    ),
);

const writeCachedUserAgent = Effect.fnUntraced(function* (
  path: string,
  browserVersion: string,
  userAgent: string,
) {
  const cacheDirectory = dirname(path);
  yield* attempt(() => mkdir(cacheDirectory, { recursive: true }), {
    awaitOnInterrupt: true,
  });
  // Finish the library's queued write and cleanup before interruption returns
  yield* attempt(
    () =>
      writeFile(path, `${JSON.stringify({ browserVersion, userAgent })}\n`, {
        mode: 0o600,
      }),
    { awaitOnInterrupt: true },
  );
});

const main = Effect.fnUntraced(function* (configuration: BrowserConfiguration) {
  const options = yield* Effect.try({
    try: () => parseArguments(Bun.argv.slice(2), configuration),
    catch: (error) => error,
  });
  if (options.help) {
    console.log(configuration.usage.replaceAll("@COMMAND@", configuration.commandName));
    return;
  }
  const launcher = yield* Effect.try({
    try: () => resolveBrowser(options.browser, configuration),
    catch: (error) => error,
  });
  const command = [launcher, ...options.browserArguments];
  const browserVersion = yield* readBrowserVersion(command);
  const cachePath = userAgentCachePath(command, configuration.commandName);
  const cached = options.refresh
    ? undefined
    : yield* readCachedUserAgent(cachePath, browserVersion);
  if (cached) {
    console.log(cached);
    return;
  }
  const userAgent = yield* configuration.probe(command);
  yield* writeCachedUserAgent(cachePath, browserVersion, userAgent);
  console.log(userAgent);
});

export async function runUserAgent(configuration: BrowserConfiguration): Promise<void> {
  try {
    await run(main(configuration));
  } catch (error) {
    console.error(`${configuration.commandName}: ${errorMessage(error)}`);
    process.exitCode = 1;
  } finally {
    await flushObservability();
  }
}
