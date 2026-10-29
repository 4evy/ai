import { posix, resolve } from "node:path";
import { attempt } from "@ai/runtime/effect/effect";
import { ptree } from "@oh-my-pi/pi-utils";
import { Effect } from "effect";
import type { HelperConfig } from "../../transport/connection/bun";

export interface ExecutionTarget {
  backend?: "local" | "ssh" | undefined;
  id: string;
  home: string;
  cwd: string;
  bash: string;
  zsh?: string | undefined;
  info: { os: string };
}

// Harnesses resolve their own SSH configuration and connection reuse
export type ScriptTransport = (script: string, pty: boolean) => Promise<HelperConfig>;

export function pathValue(value: string, label: string): string {
  if (!value || value.includes("\0"))
    throw new Error(`${label} must be nonempty and contain no NUL`);
  return value;
}

export function resolveRemoteCwd(
  target: Pick<ExecutionTarget, "home" | "cwd">,
  cwd?: string,
): string {
  return resolveCwd(target, cwd, posix.resolve, "Remote");
}

export function resolveExecutionCwd(target: ExecutionTarget, cwd?: string): string {
  return target.backend === "local"
    ? resolveCwd(target, cwd, resolve, "Local")
    : resolveRemoteCwd(target, cwd);
}

function resolveCwd(
  target: Pick<ExecutionTarget, "home" | "cwd">,
  cwd: string | undefined,
  resolvePath: typeof resolve,
  label: string,
): string {
  if (cwd === undefined) return target.cwd;
  pathValue(cwd, `${label} cwd`);
  if (cwd === "~") return target.home;
  if (cwd.startsWith("~/")) return resolvePath(target.home, cwd.slice(2));
  if (cwd.startsWith("~"))
    throw new Error(`${label} cwd supports '~/' but not another user's '~name' home`);
  return resolvePath(target.cwd, cwd);
}

export const scriptCommandEffect = Effect.fnUntraced(function* (
  transport: ScriptTransport,
  script: string,
  timeout = 30_000,
  label = "Helper command",
) {
  const config = yield* attempt(() => transport(script, false), {
    awaitOnInterrupt: true,
  });
  const result = yield* attempt(
    (signal) =>
      ptree.exec([config.command, ...(config.args ?? [])], {
        timeout,
        signal,
        allowNonZero: true,
        allowAbort: true,
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.env === undefined ? {} : { env: config.env }),
      }),
    { awaitOnInterrupt: true },
  );
  if (!result.ok || result.exitCode !== 0)
    return yield* Effect.fail(
      new Error(
        `${label} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      ),
    );
  return result.stdout;
});
