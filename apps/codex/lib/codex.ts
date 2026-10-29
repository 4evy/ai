import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { run } from "@ai/runtime/effect/effect";
import { errorMessage } from "@ai/values/error/error";
import { isRecord } from "@ai/values/value/value";
import { object, or } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { map, multiple } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument, command, option, passThrough } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { Effect } from "effect";
import * as v from "valibot";
import { type AppServer, appServer } from "./server.ts";

function projectRoot(path: string, git: string | null): string {
  path = realpathSync(path);
  if (!statSync(path).isDirectory() || !git) return path;
  const result = Bun.spawnSync([git, "-C", path, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 3000,
  });
  return result.exitCode === 0 ? realpathSync(result.stdout.toString().trim()) : path;
}

function parseThreadPage(result: unknown): { paths: string[]; cursor: string | null } {
  if (!isRecord(result) || !Array.isArray(result.data))
    throw new Error("Codex thread/list returned an invalid response");
  const cursor = result.nextCursor ?? null;
  if (cursor !== null && typeof cursor !== "string")
    throw new Error("Codex thread/list returned an invalid cursor");
  const paths = result.data.flatMap((thread: unknown) => {
    const parsed = v.safeParse(v.object({ cwd: v.string() }), thread);
    return parsed.success && isAbsolute(parsed.output.cwd) ? [parsed.output.cwd] : [];
  });
  return { paths, cursor };
}

const launchPaths = Effect.fnUntraced(function* (server: AppServer, cwd: string) {
  const paths = new Set([cwd]);
  let cursor: string | null = null;
  const seen = new Set<string>();
  while (true) {
    const result = yield* server.requestEffect("thread/list", {
      archived: false,
      cursor,
      limit: 100,
      modelProviders: [],
      sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "unknown"],
      useStateDbOnly: true,
    });
    const page = parseThreadPage(result);
    for (const path of page.paths) paths.add(path);
    if (page.cursor === null) return paths;
    if (seen.has(page.cursor))
      throw new Error("Codex thread/list repeated a pagination cursor");
    seen.add(page.cursor);
    cursor = page.cursor;
  }
});

function hookTrustState(hooks: unknown[]): Record<string, { trusted_hash: string }> {
  const trust: Record<string, { trusted_hash: string }> = {};
  for (const hook of hooks) {
    if (
      !isRecord(hook) ||
      !["untrusted", "modified"].includes(String(hook.trustStatus))
    )
      continue;
    if (typeof hook.key !== "string" || typeof hook.currentHash !== "string")
      throw new Error("Codex hooks/list returned invalid hook trust metadata");
    Object.defineProperty(trust, hook.key, {
      value: { trusted_hash: hook.currentHash },
      enumerable: true,
    });
  }
  return trust;
}

const trustHooks = Effect.fnUntraced(function* (server: AppServer, cwd: string) {
  const result = yield* server.requestEffect("hooks/list", { cwds: [cwd] });
  if (!isRecord(result) || !Array.isArray(result.data))
    throw new Error("Codex hooks/list returned an invalid response");
  const entry: unknown = result.data.find(
    (value: unknown) => isRecord(value) && value.cwd === cwd,
  );
  if (!isRecord(entry))
    throw new Error("Codex hooks/list did not include the launch directory");
  if (entry.errors && (!Array.isArray(entry.errors) || entry.errors.length))
    throw new Error("Codex hooks/list could not load launch hooks");
  if (!Array.isArray(entry.hooks))
    throw new Error("Codex hooks/list returned invalid hooks");
  const trust = hookTrustState(entry.hooks);
  if (Object.keys(trust).length) {
    yield* server.requestEffect("config/batchWrite", {
      edits: [{ keyPath: "hooks.state", mergeStrategy: "upsert", value: trust }],
      reloadUserConfig: true,
    });
  }
});

function trustedProject(config: unknown, path: string): boolean {
  if (!isRecord(config) || !isRecord(config.projects)) return false;
  const project: unknown = config.projects[path];
  return isRecord(project) && project.trust_level === "trusted";
}

export async function trustLaunchProjects(
  real: string,
  cwd: string,
  agents: boolean,
): Promise<void> {
  const configPath = join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "config.toml",
  );
  const config: unknown = existsSync(configPath)
    ? Bun.TOML.parse(readFileSync(configPath, "utf8"))
    : {};
  await run(
    Effect.gen(function* () {
      const server = yield* appServer(real);
      const paths = agents ? yield* launchPaths(server, cwd) : new Set([cwd]);
      const git = Bun.which("git");
      const projects = new Set(
        [...paths]
          .filter((path) => existsSync(path) && statSync(path).isDirectory())
          .map((path) => projectRoot(path, git)),
      );
      const untrusted = [...projects]
        .sort()
        .filter((path) => !trustedProject(config, path));
      if (untrusted.length) {
        yield* server.requestEffect("config/batchWrite", {
          edits: untrusted.map((path) => ({
            keyPath: `projects.${JSON.stringify(path)}.trust_level`,
            mergeStrategy: "upsert",
            value: "trusted",
          })),
        });
      }
      yield* trustHooks(server, cwd);
    }).pipe(Effect.scoped),
  );
}

export function launchDirectory(args: string[]): string {
  const token = argument(string());
  const forwarded = passThrough({ format: "greedy" });
  // Keep the separator branch active until its entire opaque tail is consumed
  // Empty tails still complete, even though they cannot be skipped mid-parse
  const afterSeparator = command("--", {
    ...forwarded,
    canSkip: (state: readonly string[]) => state.length > 0,
  });
  // Unknown upstream flags are opaque tokens, not our CLI's options
  const rawToken = {
    ...token,
    parse(context: Parameters<typeof token.parse>[0]) {
      const result = token.parse({ ...context, optionsTerminated: true });
      return result.success
        ? {
            ...result,
            next: { ...result.next, optionsTerminated: context.optionsTerminated },
          }
        : result;
    },
  };
  const parsed = parseSync(
    multiple(
      or(
        afterSeparator,
        command(
          "-C",
          map(rawToken, (directory) => {
            if (!directory) throw new Error("-C requires a directory");
            return { directory };
          }),
        ),
        command(
          "--cd",
          map(rawToken, (directory) => {
            if (!directory) throw new Error("--cd requires a directory");
            return { directory };
          }),
        ),
        object({ directory: option("--cd", string()) }),
        rawToken,
      ),
    ),
    args,
  );
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  let cwd = process.cwd();
  for (const value of parsed.value) {
    if (typeof value === "object" && "directory" in value) cwd = value.directory;
  }
  return resolve(cwd);
}

export async function prepareLaunch(real: string, args: string[]): Promise<boolean> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (interactive) {
    try {
      await trustLaunchProjects(real, launchDirectory(args), args.includes("agents"));
    } catch (error) {
      console.error(`codex: could not trust launch projects: ${errorMessage(error)}`);
      process.exit(1);
    }
  }
  return interactive;
}

export { launchProcess as execProcess } from "@ai/runtime/process/launch";
