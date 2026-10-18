import { existsSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { packageJsonSchema } from "@ai/core/schema/package";
import { isRecord } from "@ai/core/value/value";
import * as Records from "effect/Record";
import * as v from "valibot";
import { files, manifest, projects, repo } from "./projects.ts";

const destination = process.argv[2];
if (!destination) throw new Error("Usage: bun tools/scripts/vite/install.ts DIRECTORY");
const output = resolve(destination);

function compiled(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/(?<!\.d)\.ts$/, ".js");
  if (Array.isArray(value)) return value.map(compiled);
  if (isRecord(value)) return Records.map(value, compiled);
  return value;
}

for (const project of projects) {
  for (const copy of project.install.copies) {
    const source = join(repo, copy.from);
    if (copy.optional && !existsSync(source)) continue;
    await cp(source, join(output, copy.to), { recursive: true });
  }
}
for (const project of projects) {
  const path = join(output, project.directory, "package.json");
  const metadata = v.parse(
    packageJsonSchema,
    project.directory === "." ? manifest : JSON.parse(await readFile(path, "utf8")),
  );
  for (const field of ["exports", "imports", "bin"] as const)
    if (metadata[field]) metadata[field] = compiled(metadata[field]);
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
  for (const file of files({ include: project.install.remove }, output))
    await rm(join(output, file));
}
