import { join } from "node:path";
import * as v from "valibot";
import { updateBridgeLock } from "../../../apps/ghidra/mcp/update";
import { root, run, writeJson } from "./process";

const sourcePinSchema = v.looseObject({
  rev: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/u)),
  version: v.string(),
  hash: v.string(),
  upstreamVersion: v.optional(v.string()),
});
const commitSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({ commit: v.object({ committer: v.object({ date: v.string() }) }) }),
);
const prefetchSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({ storePath: v.string(), hash: v.string() }),
);
const projectSchema = v.object({
  project: v.object({ version: v.pipe(v.string(), v.nonEmpty()) }),
});

export async function updateSources(changed: Set<string>): Promise<void> {
  for (const [path, repository] of [
    ["apps/ghidra/mcp/source.json", "bethington/ghidra-mcp"],
    ["apps/ghidra/extensions/apple-api-types/source.json", "PoomSmart/IDAObjcTypes"],
    [
      "apps/ghidra/extensions/windows-api-types/source.json",
      "winsiderss/systeminformer",
    ],
  ] as const) {
    if (!changed.has(path)) continue;
    const pin = v.parse(sourcePinSchema, await Bun.file(join(root, path)).json());
    const commit = v.parse(
      commitSchema,
      await run(["gh", "api", `repos/${repository}/commits/${pin.rev}`]),
    );
    const date = commit.commit.committer.date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error(`Invalid commit date in ${repository}`);
    const source = v.parse(
      prefetchSchema,
      await run([
        "nix",
        "store",
        "prefetch-file",
        "--unpack",
        "--json",
        `https://github.com/${repository}/archive/${pin.rev}.tar.gz`,
      ]),
    );
    if (repository === "bethington/ghidra-mcp") {
      const metadata = await Bun.file(join(source.storePath, "pyproject.toml")).text();
      const { project } = v.parse(projectSchema, Bun.TOML.parse(metadata));
      pin.upstreamVersion = project.version;
    }
    const version = pin.upstreamVersion ?? pin.version.split("-unstable-")[0];
    pin.version = `${version}-unstable-${date}`;
    pin.hash = source.hash;
    await writeJson(join(root, path), pin);
    if (repository === "bethington/ghidra-mcp")
      await updateBridgeLock(source.storePath);
  }
}
