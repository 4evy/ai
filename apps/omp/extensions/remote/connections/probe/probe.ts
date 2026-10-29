import { randomUUID } from "node:crypto";
import { readFileSync as readResource } from "node:fs";
import { attempt, run } from "@ai/runtime/effect/effect";
import { render } from "@ai/values/template/template";
import type {
  SSHConnectionTarget,
  SSHHostInfo,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import { quotePosixArgument } from "@oh-my-pi/pi-coding-agent/utils/shell-quote";
import { ptree } from "@oh-my-pi/pi-utils";
import { Effect } from "effect";
import * as v from "valibot";
import { argvEffect as argv } from "../command";
import { pathValue } from "../target";

const posixScript = readResource(new URL("./posix.sh", import.meta.url), "utf8");
const windowsScript = readResource(new URL("./windows.ps1", import.meta.url), "utf8");

const posixPath = v.pipe(v.string(), v.startsWith("/"));
const optionalPosixPath = v.union([v.literal(""), posixPath]);
const posixFactsSchema = v.strictTuple([
  posixPath,
  posixPath,
  posixPath,
  optionalPosixPath,
  v.pipe(v.string(), v.minLength(1), v.regex(/^[^\s\p{Cc}]+$/u)),
  optionalPosixPath,
]);
const windowsPath = v.pipe(v.string(), v.regex(/^[A-Za-z]:[\\/]/u));
const windowsFactsSchema = v.object({
  home: windowsPath,
  cwd: windowsPath,
  arch: v.pipe(v.string(), v.toLowerCase()),
});

const PROBE_ERRORS: Readonly<Record<number, string>> = {
  72: "Remote cwd does not exist or cannot be entered",
  73: "Remote Bash executable is unavailable",
  255: "SSH probe did not complete; remote state is unknown",
};

export const probeConnectionEffect = Effect.fnUntraced(function* (
  target: SSHConnectionTarget,
  info: SSHHostInfo,
  requested: string | undefined,
  cwd: string,
) {
  if (requested !== undefined)
    yield* Effect.try({
      try: () => pathValue(requested, "Remote cwd"),
      catch: (error) => error,
    });
  if (info.os === "windows") return yield* windowsProbe(target, info, requested, cwd);
  const destinationCwd = yield* Effect.try({
    try: () => probeDirectory(requested),
    catch: (error) => error,
  });
  const marker = `OMP_REMOTE_PROBE_${randomUUID().replaceAll("-", "")}`;
  const script = render(posixScript, { MARKER: marker, DIRECTORY: destinationCwd });
  const args = yield* argv(target, info, script, false);
  const result = yield* attempt(
    (signal) =>
      ptree.exec(["ssh", ...args], {
        cwd,
        timeout: 30_000,
        signal,
        allowNonZero: true,
        allowAbort: true,
      }),
    { awaitOnInterrupt: true },
  );
  return yield* Effect.try({
    try: () => {
      assertProbeCompleted(result);
      return posixFacts(result.stdout, marker);
    },
    catch: (error) => error,
  });
});

export function probeConnection(
  target: SSHConnectionTarget,
  info: SSHHostInfo,
  requested: string | undefined,
  cwd: string,
  signal?: AbortSignal,
) {
  return run(probeConnectionEffect(target, info, requested, cwd), signal);
}

const windowsProbe = Effect.fnUntraced(function* (
  target: SSHConnectionTarget,
  info: SSHHostInfo,
  requested: string | undefined,
  cwd: string,
) {
  const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
  const script = render(windowsScript, {
    DIRECTORY: requested ? quote(requested) : "$env:USERPROFILE",
  });
  const args = yield* argv(target, info, script, false);
  const result = yield* attempt(
    (signal) =>
      ptree.exec(["ssh", ...args], {
        cwd,
        timeout: 30_000,
        signal,
        allowNonZero: true,
        allowAbort: true,
      }),
    { awaitOnInterrupt: true },
  );
  if (!result.ok || result.exitCode !== 0)
    return yield* Effect.fail(
      new Error(`Windows connection probe failed: ${result.stderr}`),
    );
  return yield* Effect.try({
    try: () => windowsFacts(result.stdout),
    catch: (error) => error,
  });
});

function probeDirectory(requested: string | undefined): string {
  if (requested?.startsWith("~") && requested !== "~" && !requested.startsWith("~/")) {
    throw new Error("Remote cwd supports '~/' but not another user's '~name' home");
  }
  const destinationCwd =
    requested === undefined || requested === "~"
      ? '"$home"'
      : requested.startsWith("~/")
        ? `"$home"/${quotePosixArgument(requested.slice(2))}`
        : requested.startsWith("/")
          ? quotePosixArgument(requested)
          : `"$home"/${quotePosixArgument(requested)}`;
  return destinationCwd;
}

function assertProbeCompleted(result: Awaited<ReturnType<typeof ptree.exec>>): void {
  if (!result.ok || result.exitCode !== 0) {
    const reason =
      result.exitCode === null
        ? "SSH probe did not complete; remote state is unknown"
        : (PROBE_ERRORS[result.exitCode] ??
          `Remote connection probe failed (SSH exit ${result.exitCode})`);
    throw new Error(`${reason}${result.stderr ? `: ${result.stderr.trimEnd()}` : ""}`);
  }
}

function posixFacts(stdout: string, marker: string) {
  const frame = `\0${marker}\0`;
  const start = stdout.indexOf(frame);
  const end = stdout.indexOf(frame, start + frame.length);
  if (start < 0 || end < 0)
    throw new Error(
      "SSH probe returned no complete remote facts frame; remote state is unknown",
    );
  const fields = stdout.slice(start + frame.length, end).split("\0");
  return validatedPosixFacts(fields);
}

function windowsFacts(stdout: string) {
  const facts = v.safeParse(windowsFactsSchema, JSON.parse(stdout.trim()));
  if (!facts.success) throw new Error("Invalid Windows connection facts");
  return { ...facts.output, bash: "powershell.exe" };
}

function validatedPosixFacts(fields: string[]) {
  const facts = v.safeParse(posixFactsSchema, fields);
  if (!facts.success) {
    throw new Error("SSH probe returned invalid remote facts");
  }
  const [home, directory, bash, timeout, arch, zsh] = facts.output;
  return {
    home,
    cwd: directory,
    bash,
    ...(zsh ? { zsh } : {}),
    ...(timeout ? { timeout } : {}),
    arch,
  };
}
