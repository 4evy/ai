import { randomUUID } from "node:crypto";
import { readFileSync as readResource } from "node:fs";
import { run } from "@ai/core/effect/effect";
import { quotePosixArgument as quote } from "@ai/core/shell/shell";
import { render } from "@ai/core/template/template";
import { Effect } from "effect";
import * as v from "valibot";
import {
  type ExecutionTarget,
  type ScriptTransport,
  scriptCommandEffect,
} from "../../client/execution/execution";

const preludeScript = readResource(new URL("./prelude.sh", import.meta.url), "utf8");
const workspaceScript = readResource(
  new URL("./workspace.sh", import.meta.url),
  "utf8",
);
const createScript = readResource(new URL("./create.sh", import.meta.url), "utf8");
const listScript = readResource(new URL("./list.sh", import.meta.url), "utf8");
const SCRATCH_TIMEOUT_MS = 30_000;
const removeScript = readResource(new URL("./remove.sh", import.meta.url), "utf8");

import {
  scratchRecordSchema as recordSchema,
  scratchParameters,
} from "../tools/schemas/scratch";

function prelude(target: ExecutionTarget, create: boolean): string {
  const stat =
    target.info.os === "macos"
      ? '/usr/bin/stat -f "%u:%Lp" "$1"'
      : 'stat -c "%u:%a" -- "$1"';
  return render(preludeScript, {
    STAT: stat,
    ROOT: create
      ? 'if [ ! -e "$root" ] && [ ! -L "$root" ]; then mkdir "$root" || [ -d "$root" ]; fi'
      : 'if [ ! -e "$root" ] && [ ! -L "$root" ]; then printf \'%s\\n\' "$root"; exit 0; fi',
  });
}

function checkWorkspace(id: string): string {
  return render(workspaceScript, { ID: quote(id) });
}

function describe(
  target: ExecutionTarget,
  root: string,
  record: v.InferOutput<typeof recordSchema>,
) {
  const cwd = `${root}/${record.id}/work`;
  return {
    ...record,
    target: target.id,
    cwd,
    run: { ...(target.backend === "local" ? {} : { target: target.id }), cwd },
    files:
      target.backend === "local"
        ? { path: `${cwd}/` }
        : { connection: target.id, path: `${cwd}/` },
  };
}

const manageScratchEffect = Effect.fnUntraced(function* (
  target: ExecutionTarget,
  transport: ScriptTransport,
  input: v.InferOutput<typeof scratchParameters>,
) {
  if (target.info.os !== "linux" && target.info.os !== "macos")
    return yield* Effect.fail(
      new Error("Scratch workspaces require a Linux or macOS target"),
    );
  const args = yield* Effect.try({
    try: () => v.parse(scratchParameters, input),
    catch: (error) => error,
  });
  const id =
    args.action === "create"
      ? randomUUID()
      : "workspace" in args
        ? args.workspace
        : undefined;
  const script = yield* Effect.try({
    try: () => scratchScript(target, args, id),
    catch: (error) => error,
  });
  const output = yield* scriptCommandEffect(
    transport,
    script,
    SCRATCH_TIMEOUT_MS,
    "Scratch operation",
  );
  const [root, ...lines] = output.trimEnd().split("\n");
  if (!root || !/^\/tmp\/omp-scratch-\d+$/u.test(root))
    return yield* Effect.fail(new Error("Invalid scratch root returned by target"));
  const records = yield* Effect.try({
    try: () =>
      lines.map((line) => {
        const tab = args.action === "list" ? line.indexOf("\t") : -1;
        const record = v.parse(
          recordSchema,
          JSON.parse(tab < 0 ? line : line.slice(tab + 1)),
        );
        if (record.id !== (args.action === "list" ? line.slice(0, tab) : id))
          throw new Error("Workspace record does not match its managed directory");
        return record;
      }),
    catch: (error) => error,
  });
  if (args.action !== "list" && records.length !== 1)
    return yield* Effect.fail(new Error(`Unknown scratch workspace: ${id}`));
  if (args.action === "remove") {
    const record = records[0];
    if (!record) return yield* Effect.fail(new Error("Missing workspace record"));
    yield* scriptCommandEffect(
      transport,
      render(removeScript, {
        PRELUDE: prelude(target, false),
        WORKSPACE: checkWorkspace(args.workspace),
        RECORD: quote(JSON.stringify(record)),
      }),
      SCRATCH_TIMEOUT_MS,
      "Scratch operation",
    );
    return { action: args.action, target: target.id, removed: args.workspace };
  }
  return {
    action: args.action,
    target: target.id,
    workspaces: records.map((record) => describe(target, root, record)),
  };
});

export function manageScratch(
  target: ExecutionTarget,
  transport: ScriptTransport,
  input: v.InferOutput<typeof scratchParameters>,
  signal?: AbortSignal,
) {
  return run(manageScratchEffect(target, transport, input), signal);
}

function scratchScript(
  target: ExecutionTarget,
  args: v.InferOutput<typeof scratchParameters>,
  id: string | undefined,
): string {
  const script = prelude(target, args.action === "create");
  switch (args.action) {
    case "create": {
      const record = v.parse(recordSchema, {
        version: 1,
        id,
        name: args.name,
        createdAt: new Date().toISOString(),
      });
      return (
        script +
        render(createScript, {
          ID: quote(record.id),
          RECORD: quote(JSON.stringify(record)),
        })
      );
    }
    case "list":
      return script + listScript;
    default:
      return `${script}${checkWorkspace(args.workspace)}cat "$directory/record.json"\n`;
  }
}
