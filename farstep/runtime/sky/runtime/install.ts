import { constants } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { attempt, run } from "@ai/runtime/effect/effect";
import { downloadFile } from "@ai/runtime/effect/http/http";
import { TempDir, withFileLock } from "@oh-my-pi/pi-utils";
import { extractArchive, openArchive } from "@oh-my-pi/pi-utils/ar";
import { Effect } from "effect";
import {
  ARTIFACT,
  RUNTIME,
  type RuntimeArtifact,
  referencePaths,
  runtimePaths,
} from "./paths";
import pins from "./pins.json";

const GIB = 1024 ** 3;
const RECEIPT = JSON.stringify({ version: pins.version, artifact: ARTIFACT });

export function downloadRuntimeEffect(url: string, destination: string) {
  return downloadFile(url, destination, "Sky download").pipe(
    Effect.timeoutOrElse({
      duration: 10 * 60_000,
      orElse: () => Effect.fail(new Error("Sky download timed out")),
    }),
  );
}

export function downloadRuntime(
  url: string,
  destination: string,
  signal?: AbortSignal,
) {
  return run(downloadRuntimeEffect(url, destination), signal);
}

export const extractRuntimeEffect = Effect.fnUntraced(function* (
  archive: string,
  destination: string,
) {
  const limits = { maxInMemorySize: 4 * GIB, maxMemberSize: GIB };
  if (extname(archive) !== ".msix") {
    return yield* attempt(() => extractArchive(archive, destination, { limits }), {
      awaitOnInterrupt: true,
    });
  }
  // MSIX is ZIP with URI-encoded member names, including Node package scopes
  const contents = yield* attempt(
    () => openArchive({ path: archive, format: "zip" }, { limits }),
    { awaitOnInterrupt: true },
  );
  const root = resolve(destination);
  const written = new Set<string>();
  let count = 0;
  for (const entry of contents.indexEntries()) {
    // Windows needs only CUA's portable binaries, modules, and their resources
    if (!entry.path.startsWith("app/resources/cua_node/")) continue;
    const parts = yield* Effect.try({
      try: () => entry.path.split("/").map((part) => decodeURIComponent(part)),
      catch: (error) => error,
    });
    if (
      parts.some((part) => part === "." || part === ".." || /[\\/\0:]/.test(part)) ||
      entry.storage?.type === "link"
    ) {
      return yield* Effect.fail(new Error(`Invalid MSIX member: ${entry.path}`));
    }
    const path = resolve(root, ...parts);
    if (
      path === root ||
      !path.startsWith(root + sep) ||
      written.has(path.toLowerCase())
    ) {
      return yield* Effect.fail(
        new Error(`Invalid or duplicate MSIX member: ${entry.path}`),
      );
    }
    written.add(path.toLowerCase());
    if (entry.isDirectory) {
      yield* attempt(() => mkdir(path, { recursive: true }), {
        awaitOnInterrupt: true,
      });
    } else {
      yield* attempt(() => mkdir(dirname(path), { recursive: true }), {
        awaitOnInterrupt: true,
      });
      const content = yield* attempt(() => contents.readFile(entry.path), {
        awaitOnInterrupt: true,
      });
      yield* attempt(() => Bun.write(path, content.bytes), { awaitOnInterrupt: true });
    }
    count++;
  }
  return count;
});

export function extractRuntime(archive: string, destination: string) {
  return run(extractRuntimeEffect(archive, destination));
}

export const validateRuntimeEffect = Effect.fnUntraced(function* (
  root: string,
  artifact: RuntimeArtifact,
) {
  const paths = runtimePaths(
    join(root, artifact.resources),
    artifact.platform,
    artifact.arch,
  );
  const sky = yield* attempt(() =>
    Bun.file(join(paths.modules, "@oai/sky/package.json")).json(),
  );
  if (sky.version !== artifact.skyVersion) {
    return yield* Effect.fail(
      new Error(`Pinned ChatGPT must contain @oai/sky ${artifact.skyVersion}`),
    );
  }
  for (const path of [
    paths.node,
    paths.repl,
    ...(artifact.platform === "darwin"
      ? [paths.codex, join(paths.service, "Contents/MacOS/SkyComputerUseService")]
      : [paths.service]),
  ]) {
    // Windows executables have no Unix mode bits when inspected on another host
    yield* attempt(() =>
      access(path, artifact.platform === "win32" ? constants.R_OK : constants.X_OK),
    );
  }
  for (const path of [
    join(paths.modules, "@oai/sky/dist/project/cua/sky_js/src/index.d.ts"),
    join(paths.modules, "@oai/sky/dist/project/cua/sky_js/src/service.d.ts"),
    paths.cuaRepl,
    join(paths.modules, "@oai/browser-desktop/scripts/browser-service.mjs"),
    join(paths.modules, "@oai/browser-desktop/scripts/browser-client.mjs"),
    ...referencePaths(artifact.platform).map((path) => join(paths.modules, path)),
  ]) {
    yield* attempt(() => access(path, constants.R_OK));
  }
});

export function validateRuntime(root: string, artifact: RuntimeArtifact) {
  return run(validateRuntimeEffect(root, artifact));
}

const isInstalled = Effect.fnUntraced(function* (
  root: string,
  artifact: RuntimeArtifact,
) {
  return yield* Effect.gen(function* () {
    if (
      !isDeepStrictEqual(
        yield* attempt(() => Bun.file(join(root, "complete.json")).json()),
        JSON.parse(RECEIPT),
      )
    )
      return false;
    yield* validateRuntimeEffect(root, artifact);
    return true;
  }).pipe(Effect.catch(() => Effect.succeed(false)));
});

const installLockedRuntimeEffect = Effect.fnUntraced(function* (
  root: string,
  artifact: RuntimeArtifact,
) {
  if (yield* isInstalled(root, artifact)) return;
  const staging = yield* Effect.acquireDisposable(
    attempt(() => TempDir.create(join(dirname(root), ".install-"))),
  );
  const archive = staging.join(`chatgpt${extname(artifact.url)}`);
  if ((yield* downloadRuntimeEffect(artifact.url, archive)) !== artifact.sha256) {
    return yield* Effect.fail(
      new Error(`Pinned ChatGPT ${pins.version} archive checksum mismatch`),
    );
  }
  const unpacked = staging.join("unpacked");
  // ChatGPT includes members larger than the general archive defaults
  yield* extractRuntimeEffect(archive, unpacked);
  yield* validateRuntimeEffect(unpacked, artifact);
  yield* Effect.gen(function* () {
    yield* attempt(() => Bun.write(join(unpacked, "complete.json"), RECEIPT));
    yield* attempt(() => rm(root, { recursive: true, force: true }));
    yield* attempt(() => rename(unpacked, root));
  }).pipe(Effect.uninterruptible);
}, Effect.scoped);

export const ensureRuntimeEffect = Effect.fnUntraced(function* () {
  if (!ARTIFACT || !RUNTIME) {
    return yield* Effect.fail(
      new Error(
        `No pinned Skylight runtime for ${process.platform}-${process.arch}, or FARSTEP_SKY_RUNTIME is missing from the Nix launcher`,
      ),
    );
  }
  const artifact = ARTIFACT;
  const root = RUNTIME;
  if (process.platform !== "win32") {
    if (!root.startsWith("/nix/store/") || !(yield* isInstalled(root, artifact)))
      return yield* Effect.fail(
        new Error("Use the Nix Farstep package for the pinned Sky runtime"),
      );
    return;
  }
  if (yield* isInstalled(root, artifact)) return;
  yield* attempt(() => mkdir(dirname(root), { recursive: true, mode: 0o700 }), {
    awaitOnInterrupt: true,
  });
  // The library retains its lease through installation and cancellation cleanup
  yield* attempt(
    (signal) =>
      withFileLock(
        root,
        () => run(installLockedRuntimeEffect(root, artifact), signal),
        {
          signal,
          retries: 2400,
          retryDelayMs: 250,
        },
      ),
    { awaitOnInterrupt: true },
  );
});

export function ensureRuntime(signal?: AbortSignal) {
  return run(ensureRuntimeEffect(), signal);
}
