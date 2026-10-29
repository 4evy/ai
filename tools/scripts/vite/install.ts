import { existsSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { packageJsonSchema } from "@ai/values/schema/package";
import { isRecord } from "@ai/values/value/value";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { withDefault } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument, flag } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import * as Records from "effect/Record";
import * as v from "valibot";
import { files, projects, repo } from "./projects.ts";

const parsed = parseSync(
  object({
    destination: argument(string({ metavar: "DIRECTORY" })),
    modulesOnly: withDefault(flag("--modules-only"), false),
  }),
  Bun.argv.slice(2),
);
if (!parsed.success) throw new Error(formatMessage(parsed.error));
const { destination, modulesOnly } = parsed.value;
const output = resolve(destination);

function compiled(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/(?<!\.d)\.ts$/, ".js");
  if (Array.isArray(value)) return value.map(compiled);
  if (isRecord(value)) return Records.map(value, compiled);
  return value;
}

const selected = projects();
for (const project of selected) {
  const copies = [
    ...project.install.modules,
    ...(modulesOnly ? [] : project.install.resources),
  ];
  for (const copy of copies) {
    const source = join(repo, copy.from);
    if (copy.optional && !existsSync(source)) continue;
    await cp(source, join(output, copy.to), { recursive: true });
  }
}
for (const project of selected) {
  const path = join(output, project.directory, "package.json");
  const metadata = v.parse(
    packageJsonSchema,
    JSON.parse(await readFile(join(repo, project.directory, "package.json"), "utf8")),
  );
  for (const field of ["exports", "imports", "bin"] as const)
    if (metadata[field]) metadata[field] = compiled(metadata[field]);
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
  for (const file of files({ include: project.install.remove }, output))
    await rm(join(output, file));
}
