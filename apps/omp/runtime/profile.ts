import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { attempt, run as runEffect } from "@ai/runtime/effect/effect";
import { executeCommand } from "@ai/runtime/effect/process/process";
import { object, or } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { optional, withDefault } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument, command, constant } from "@optique/core/primitives";
import { choice, string } from "@optique/core/valueparser";
import { Effect, Struct } from "effect";
import profiles from "./profiles.json";

export const runtimeRoot = import.meta.dir;
export type PatchProfile = keyof typeof profiles.profiles;

function patchExecutable(): string {
  const available = Bun.which(process.env.AI_TOOLS_PATCH ?? "patch");
  if (available) return available;
  if (process.platform === "win32") {
    const candidates = [
      process.env.OPENCODE_GIT_BASH_PATH &&
        join(dirname(process.env.OPENCODE_GIT_BASH_PATH), "../usr/bin/patch.exe"),
      process.env.ProgramFiles &&
        join(process.env.ProgramFiles, "Git/usr/bin/patch.exe"),
      process.env["ProgramFiles(x86)"] &&
        join(process.env["ProgramFiles(x86)"], "Git/usr/bin/patch.exe"),
      process.env.LOCALAPPDATA &&
        join(process.env.LOCALAPPDATA, "Programs/Git/usr/bin/patch.exe"),
    ];
    for (const candidate of candidates) {
      if (candidate && Bun.which(candidate)) return candidate;
    }
  }
  throw new Error("OMP patches require GNU patch; install it or set AI_TOOLS_PATCH");
}

export const runCommandEffect = Effect.fnUntraced(function* (
  command: string[],
  cwd?: string,
) {
  const { stdout: output, code } = yield* executeCommand(command, {
    cwd,
    stderr: "inherit",
  });
  if (code !== 0)
    return yield* Effect.fail(
      new Error(`Command failed: ${command.join(" ")}\n${output.trim()}`),
    );
  return output.trim();
});

export function run(command: string[], cwd?: string): Promise<string> {
  return runEffect(runCommandEffect(command, cwd));
}

function patchFiles(profile: PatchProfile): string[] {
  const selected = profiles.profiles[profile];
  const applied = new Set<string>();
  const dependencies: Record<string, string[]> = profiles.dependencies;
  return selected.map((name) => {
    if (applied.has(name)) throw new Error(`Duplicate patch: ${name}`);
    for (const dependency of dependencies[name] ?? []) {
      if (!applied.has(dependency))
        throw new Error(`${name} requires ${dependency} earlier in ${profile}`);
    }
    applied.add(name);
    return join(runtimeRoot, "patches", name);
  });
}

const validateProfiles = Effect.fnUntraced(function* () {
  const declared = new Set(Object.values(profiles.profiles).flat());
  const directory = join(runtimeRoot, "patches");
  const actual = (yield* attempt(() =>
    readdir(directory, { recursive: true, withFileTypes: true }),
  ))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".patch"))
    .map((entry) =>
      relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"),
    );
  if (actual.length !== declared.size || actual.some((name) => !declared.has(name)))
    return yield* Effect.fail(new Error("Patch inventory differs from profiles.json"));
  for (const profile of Struct.keys(profiles.profiles))
    yield* Effect.try({ try: () => patchFiles(profile), catch: (error) => error });
});

export const applyProfileEffect = Effect.fnUntraced(function* (
  tree: string,
  profile: PatchProfile,
) {
  yield* validateProfiles();
  const files = yield* Effect.try({
    try: () => patchFiles(profile),
    catch: (error) => error,
  });
  yield* Effect.forEach(
    files,
    (file) =>
      runCommandEffect(
        [
          patchExecutable(),
          "-p1",
          "-f",
          "-F",
          "0",
          "--no-backup-if-mismatch",
          "-i",
          file,
        ],
        tree,
      ),
    { discard: true },
  );
  for (const overlay of profiles.overlays) {
    if (!overlay.profiles.includes(profile)) continue;
    const target = join(tree, overlay.target);
    yield* attempt(() => mkdir(dirname(target), { recursive: true }), {
      awaitOnInterrupt: true,
    });
    if (yield* attempt(() => Bun.file(target).exists()))
      return yield* Effect.fail(
        new Error(`Overlay would replace an upstream file: ${overlay.target}`),
      );
    yield* attempt(() => copyFile(join(runtimeRoot, overlay.source), target), {
      awaitOnInterrupt: true,
    });
  }
});

export function applyProfile(tree: string, profile: PatchProfile): Promise<void> {
  return runEffect(applyProfileEffect(tree, profile));
}

const profileFingerprintEffect = Effect.fnUntraced(function* (profile: PatchProfile) {
  yield* validateProfiles();
  const patches = yield* Effect.try({
    try: () => patchFiles(profile),
    catch: (error) => error,
  });
  const hash = createHash("sha256");
  const files = [
    join(runtimeRoot, "profile.ts"),
    join(runtimeRoot, "profiles.json"),
    ...patches,
    ...profiles.overlays
      .filter((overlay) => overlay.profiles.includes(profile))
      .map((overlay) => join(runtimeRoot, overlay.source)),
  ];
  const contents = yield* Effect.forEach(
    files,
    (file) => attempt((signal) => readFile(file, { signal })),
    { concurrency: 4 },
  );
  for (const [index, file] of files.entries()) {
    hash.update(file.slice(runtimeRoot.length));
    hash.update("\0");
    const content = contents[index];
    if (!content)
      return yield* Effect.fail(new Error(`Missing profile content: ${file}`));
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
});

export function profileFingerprint(profile: PatchProfile): Promise<string> {
  return runEffect(profileFingerprintEffect(profile));
}

if (import.meta.main) {
  const profile = withDefault(argument(choice(["runtime", "sdk"] as const)), "runtime");
  const parsed = parseSync(
    or(
      command(
        "--apply",
        object({
          action: constant("apply"),
          tree: argument(string()),
          profile,
        }),
      ),
      command(
        "--fingerprint",
        object({
          action: constant("fingerprint"),
          tree: optional(argument(string())),
          profile,
        }),
      ),
    ),
    process.argv.slice(2),
  );
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  if (parsed.value.action === "apply") {
    if (!parsed.value.tree) throw new Error("--apply requires a tree");
    await applyProfile(parsed.value.tree, parsed.value.profile);
  } else console.log(await profileFingerprint(parsed.value.profile));
}
