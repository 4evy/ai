import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { attempt, run as runEffect } from "@ai/runtime/effect/effect";
import { temporaryDirectory } from "@ai/runtime/effect/fs/fs";
import { errorCode } from "@ai/values/error/error";
import { packageJsonSchema } from "@ai/values/schema/package";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { multiple } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { flag } from "@optique/core/primitives";
import { applyPatch, formatPatch, structuredPatch } from "diff";
import { Effect } from "effect";
import {
  applyProfileEffect as applyProfile,
  runCommandEffect as run,
  runtimeRoot,
} from "omp-agent-runtime/runtime/profile";
import { sourceSchema } from "omp-agent-runtime/runtime/source/source";
import * as v from "valibot";
import {
  downloadArchiveEffect as download,
  extractArchiveEffect as extractArchive,
} from "../../archive/archive";

const repo = join(import.meta.dir, "../../../..");
const targets = [
  { name: "pi-coding-agent", directory: "coding-agent", patch: "agent/agent.patch" },
  { name: "pi-tui", directory: "tui", patch: "tui/tui.patch" },
];

const files = Effect.fnUntraced(function* (root: string) {
  const entries = yield* attempt(() =>
    readdir(root, { recursive: true, withFileTypes: true }),
  );
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
});

const bytes = (file: string) =>
  attempt((signal) => readFile(file, { signal })).pipe(
    Effect.catch((error) =>
      errorCode(error) === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(error),
    ),
  );

const changedFiles = Effect.fnUntraced(function* (before: string, after: string) {
  const [oldFiles, nextFiles] = yield* Effect.all([files(before), files(after)], {
    concurrency: "unbounded",
  });
  const all = new Set(oldFiles).union(new Set(nextFiles));
  const changed: string[] = [];
  for (const file of [...all].sort()) {
    const [old, next] = yield* Effect.all(
      [bytes(join(before, file)), bytes(join(after, file))],
      { concurrency: "unbounded" },
    );
    if (old === undefined || next === undefined || !old.equals(next))
      changed.push(file);
  }
  return changed;
});

const declarations = Effect.fnUntraced(function* (
  tree: string,
  directory: string,
  output: string,
) {
  yield* run([
    process.execPath,
    "x",
    "--no-install",
    "tsc",
    "-p",
    join(tree, "packages", directory, "tsconfig.publish.json"),
    "--outDir",
    output,
    "--typeRoots",
    `${join(repo, "node_modules/@types")},${join(tree, "types")}`,
  ]);
  // Match upstream's published ESM declaration specifiers
  const { fixEmitExtensions } = yield* attempt(
    () => import(pathToFileURL(join(tree, "scripts/fix-emit-extensions.ts")).href),
  );
  yield* attempt(() => fixEmitExtensions(output, ".d.ts"), { awaitOnInterrupt: true });
});

const copyChange = Effect.fnUntraced(function* (source: string, target: string) {
  const content = yield* bytes(source);
  if (content === undefined)
    yield* attempt(() => rm(target, { force: true }), { awaitOnInterrupt: true });
  else {
    yield* attempt(() => mkdir(dirname(target), { recursive: true }), {
      awaitOnInterrupt: true,
    });
    yield* attempt((signal) => writeFile(target, content, { signal }), {
      awaitOnInterrupt: true,
    });
  }
});

const diff = Effect.fnUntraced(function* (before: string, after: string) {
  const sections: string[] = [];
  for (const file of yield* changedFiles(before, after)) {
    if (file.endsWith(".orig") || file.endsWith(".rej"))
      return yield* Effect.fail(
        new Error(`Patch application artifact cannot be published: ${file}`),
      );
    const [old, next] = yield* Effect.all(
      [bytes(join(before, file)), bytes(join(after, file))],
      { concurrency: "unbounded" },
    );
    const oldText = old?.toString("utf8") ?? "";
    const nextText = next?.toString("utf8") ?? "";
    const patch = structuredPatch(
      old === undefined ? "/dev/null" : `a/${file}`,
      next === undefined ? "/dev/null" : `b/${file}`,
      oldText,
      nextText,
      undefined,
      undefined,
      { context: 3 },
    );
    patch.isGit = true;
    patch.isCreate = old === undefined;
    patch.isDelete = next === undefined;
    const output = formatPatch(patch);
    if (
      applyPatch(oldText, output, { fuzzFactor: 0, autoConvertLineEndings: false }) !==
      nextText
    )
      return yield* Effect.fail(
        new Error(`Generated patch does not reproduce ${file}`),
      );
    sections.push(output);
  }
  return sections.join("");
});

const targetPatch = Effect.fnUntraced(function* (
  target: (typeof targets)[number],
  temporary: string,
  pristine: string,
  patched: string,
  version: string,
) {
  const published = join(temporary, target.name);
  const expected = `${published}-patched`;
  const packageArchive = `${published}.tgz`;
  yield* download(
    `https://registry.npmjs.org/@oh-my-pi/${target.name}/-/${target.name}-${version}.tgz`,
    packageArchive,
  );
  yield* extractArchive(packageArchive, published);
  yield* attempt(() => cp(published, expected, { recursive: true }), {
    awaitOnInterrupt: true,
  });
  const oldSource = join(pristine, "packages", target.directory, "src");
  const nextSource = join(patched, "packages", target.directory, "src");
  for (const file of yield* changedFiles(oldSource, nextSource)) {
    const [source, npm] = yield* Effect.all(
      [bytes(join(oldSource, file)), bytes(join(published, "src", file))],
      { concurrency: "unbounded" },
    );
    if (source ? !npm?.equals(source) : npm !== undefined)
      return yield* Effect.fail(
        new Error(`Published source differs from the tag: ${target.name}/${file}`),
      );
    yield* copyChange(join(nextSource, file), join(expected, "src", file));
  }
  const oldTypes = join(temporary, `${target.name}-old-types`);
  const nextTypes = join(temporary, `${target.name}-next-types`);
  yield* declarations(pristine, target.directory, oldTypes);
  yield* declarations(patched, target.directory, nextTypes);
  for (const file of yield* changedFiles(oldTypes, nextTypes)) {
    const destination = join(expected, "dist/types", file);
    const [old, next, publishedTypes] = yield* Effect.all(
      [bytes(join(oldTypes, file)), bytes(join(nextTypes, file)), bytes(destination)],
      { concurrency: "unbounded" },
    );
    if (old === undefined || next === undefined || publishedTypes === undefined) {
      yield* copyChange(join(nextTypes, file), destination);
      continue;
    }
    // Preserve published inference when the source-only build emits weaker types
    const delta = structuredPatch(
      file,
      file,
      old.toString("utf8"),
      next.toString("utf8"),
      undefined,
      undefined,
      { context: 0 },
    );
    const updated = applyPatch(publishedTypes.toString("utf8"), delta, {
      fuzzFactor: 0,
      autoConvertLineEndings: false,
    });
    if (updated === false)
      return yield* Effect.fail(
        new Error(`Published declarations differ at an API change: ${file}`),
      );
    yield* attempt((signal) => writeFile(destination, updated, { signal }));
  }
  return {
    path: join(runtimeRoot, "npm", target.patch),
    content: yield* diff(published, expected),
  };
});

const downloadSource = Effect.fnUntraced(function* (
  archive: string,
  version: string,
  pin: { version: string; sha256: string },
) {
  yield* download(
    `https://codeload.github.com/can1357/oh-my-pi/tar.gz/refs/tags/v${version}`,
    archive,
    { sha256: version === pin.version ? pin.sha256 : undefined },
  );
});

const syncPatchesEffect = Effect.fnUntraced(function* (options: {
  version?: string;
  archive?: string;
  check?: boolean;
}) {
  const pin = yield* attempt(async () =>
    v.parse(sourceSchema, await Bun.file(join(runtimeRoot, "source.json")).json()),
  );
  const version = options.version ?? pin.version;
  if (!/^\d+\.\d+\.\d+$/.test(version))
    return yield* Effect.fail(new Error(`Invalid OMP version: ${version}`));
  const workspace = yield* temporaryDirectory(join(tmpdir(), "omp-patches-"));
  const temporary = workspace.path;
  const archive = options.archive ?? join(temporary, "source.tar.gz");
  if (!options.archive) yield* downloadSource(archive, version, pin);
  const pristine = join(temporary, "source");
  const patched = join(temporary, "patched");
  yield* extractArchive(archive, pristine);
  if (
    (yield* attempt(async () =>
      v.parse(
        packageJsonSchema,
        await Bun.file(join(pristine, "packages/coding-agent/package.json")).json(),
      ),
    )).version !== version
  )
    return yield* Effect.fail(new Error("OMP source version mismatch"));
  yield* attempt(() => cp(pristine, patched, { recursive: true }), {
    awaitOnInterrupt: true,
  });
  // Publish plugin API changes; CLI preferences stay in the runtime profile
  yield* applyProfile(patched, "sdk");
  const generated: Array<{ path: string; content: string }> = [];
  for (const target of targets) {
    generated.push(yield* targetPatch(target, temporary, pristine, patched, version));
  }
  // The source baseline is no longer needed, so reuse it to check CLI-only patches
  yield* applyProfile(pristine, "runtime");
  // Generate every artifact before changing the checked-in patches
  for (const { path, content } of generated) {
    if ((yield* bytes(path))?.toString("utf8") === content) continue;
    if (options.check)
      return yield* Effect.fail(
        new Error(`${path} is stale; run just omp patches sync`),
      );
    yield* attempt((signal) => writeFile(path, content, { signal }), {
      awaitOnInterrupt: true,
    });
    console.log(`Updated ${path}`);
  }
}, Effect.scoped);

export function syncPatches(
  options: { version?: string; archive?: string; check?: boolean } = {},
): Promise<void> {
  return runEffect(syncPatchesEffect(options));
}

if (import.meta.main) {
  const parsed = parseSync(
    object({ check: multiple(flag("--check")) }),
    Bun.argv.slice(2),
  );
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  await syncPatches({ check: parsed.value.check.length > 0 });
}
