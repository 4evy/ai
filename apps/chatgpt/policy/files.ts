import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import { errorCode, errorMessage } from "@ai/core/error/error";
import { walkSync } from "@nodelib/fs.walk";
import { writeFileSync } from "atomically";
import { Struct } from "effect";
import { POLICY_RULES } from "./decision";
import {
  applyRewrites,
  type FilePatchResult,
  type RewriteRule,
  type Status,
} from "./rewrites";
import { SKILL_RULES } from "./skills";

const POLICY_BASENAME = "computer-use-policy.js";
const SKILL_BASENAMES = new Set(["SKILL.md", "computer-use-node-repl.md"]);
const COMPUTER_USE_DIR = "computer-use";
type FileKind = {
  include: (filename: string) => boolean;
  extraRoots: boolean;
  rules: readonly RewriteRule[];
  missing: (app: string) => string;
};

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function fsError(action: string, path: string, error: unknown): Error {
  return new Error(`${action} ${path}: ${errorMessage(error)}`);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

function resolveExisting(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw fsError("resolve", path, error);
  }
}

// Confine both traversal and results to canonical paths, including symlink targets
function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const rootReal = resolveExisting(root);
  const files = new Set<string>();
  const seen = new Set([rootReal]);
  const confinedPath = (path: string): string | undefined => {
    try {
      const real = realpathSync(path);
      return isInsideRoot(rootReal, real) ? real : undefined;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw fsError("resolve", path, error);
    }
  };
  walkSync(rootReal, {
    followSymbolicLinks: true,
    fs: {
      // Resolve again at traversal time in case a queued alias was retargeted
      readdirSync(directory, options) {
        const real = resolveExisting(directory);
        return isInsideRoot(rootReal, real) ? readdirSync(real, options) : [];
      },
      // Keep broken and external links as links; other stat errors remain fatal
      statSync(path) {
        const real = confinedPath(path);
        return real === undefined ? lstatSync(path) : statSync(real);
      },
    },
    entryFilter(entry) {
      if (entry.dirent.isFile()) {
        const real = confinedPath(entry.path);
        if (real !== undefined) files.add(real);
      }
      // Collect canonical names directly instead of retaining duplicate aliases
      return false;
    },
    deepFilter(entry) {
      const real = confinedPath(entry.path);
      if (real === undefined || seen.has(real)) return false;
      seen.add(real);
      return true;
    },
  });
  return [...files];
}

const FILE_KINDS = {
  policy: {
    include: (filename) => basename(filename) === POLICY_BASENAME,
    extraRoots: false,
    rules: POLICY_RULES,
    missing: (app) => `computer-use policy file not found under ${app}`,
  },
  skill: {
    include: (filename) =>
      SKILL_BASENAMES.has(basename(filename)) &&
      filename.split(sep).includes(COMPUTER_USE_DIR),
    extraRoots: true,
    rules: SKILL_RULES,
    missing: () => "Computer Use skill files were not found",
  },
} satisfies Record<string, FileKind>;

function discoverFiles(
  app: string,
  options?: { extraRoots?: readonly string[] },
): Record<keyof typeof FILE_KINDS, string[]> {
  const matches = { policy: new Set<string>(), skill: new Set<string>() };
  const roots = new Map<string, boolean>();
  const appRoot = join(app, "Contents/Resources");
  for (const root of [appRoot, ...(options?.extraRoots ?? [])]) {
    if (!existsSync(root)) continue;
    const real = resolveExisting(root);
    roots.set(real, roots.get(real) === true || root === appRoot);
  }
  for (const [root, inApp] of roots) {
    for (const filename of listFiles(root)) {
      matchFile(filename, inApp, matches);
    }
  }
  return {
    policy: [...matches.policy].toSorted(),
    skill: [...matches.skill].toSorted(),
  };
}

function matchFile(
  filename: string,
  inApp: boolean,
  matches: Record<keyof typeof FILE_KINDS, Set<string>>,
): void {
  const names = Struct.keys(FILE_KINDS);
  for (const name of names) {
    const kind = FILE_KINDS[name];
    if ((inApp || kind.extraRoots) && kind.include(filename)) {
      matches[name].add(filename);
    }
  }
}

type PlannedPatch = {
  filename: string;
  original: string;
  next: string;
  status: Status;
};

function restoreFilePatches(
  written: readonly { filename: string; original: string }[],
): void {
  const restoreErrors: string[] = [];
  for (const item of written.toReversed()) {
    try {
      writeFileSync(item.filename, item.original, { timeout: 0 });
    } catch (error) {
      restoreErrors.push(`${item.filename}: ${errorMessage(error)}`);
    }
  }
  if (restoreErrors.length > 0) {
    throw new Error(
      `failed to restore Computer Use files after a partial write:\n${restoreErrors.join("\n")}`,
    );
  }
}

function commitFilePatches(planned: readonly PlannedPatch[]): FilePatchResult[] {
  // Atomic replacement leaves the failing file intact, then restores earlier files
  // Disable the library's default retries so filesystem failures remain immediate
  const written: { filename: string; original: string }[] = [];
  try {
    for (const item of planned) {
      if (item.status !== "patched") continue;
      writeFileSync(item.filename, item.next, { timeout: 0 });
      written.push({ filename: item.filename, original: item.original });
    }
  } catch (error) {
    try {
      restoreFilePatches(written);
    } catch (restoreError) {
      throw new Error(`${errorMessage(error)}; ${errorMessage(restoreError)}`, {
        cause: error,
      });
    }
    throw error;
  }
  return planned.map(({ filename, status }) => ({ filename, status }));
}

function planKindPatches(
  app: string,
  kind: FileKind,
  files: readonly string[],
): PlannedPatch[] {
  if (files.length === 0) throw new Error(kind.missing(app));
  return files.map((filename) => {
    const original = readFileSync(filename, "utf8");
    const transformed = applyRewrites(original, filename, kind.rules);
    return {
      filename,
      original,
      next: transformed.source,
      status: transformed.status,
    };
  });
}

export function applyFilePatches(
  app: string,
  options?: { extraRoots?: readonly string[] },
): FilePatchResult[] {
  const files = discoverFiles(app, options);
  return commitFilePatches(
    Struct.keys(FILE_KINDS).flatMap((name) =>
      planKindPatches(app, FILE_KINDS[name], files[name]),
    ),
  );
}
