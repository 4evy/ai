import { gzipSync } from "node:zlib";
import { build, mergeConfig, rolldownVersion, type UserConfig, version } from "vite";
import { bundles } from "../../../farstep/native/desktop/platform/linux/extensions/bundles.ts";
import { bundleConfig } from "./desktop.ts";
import { type Mode, modes } from "./options.ts";
import { projects } from "./projects.ts";
import { runtimeConfig } from "./vite.ts";

type Metrics = {
  bytes: number;
  gzip: number;
  chunks: number;
  entries: number;
  entryExports: number;
  resources: number;
  maps: number;
  externals: string[];
};

type Measurements = Omit<Metrics, "externals">;
type BundleOutput = Extract<Awaited<ReturnType<typeof build>>, { output: unknown }>;
type BundleFile = BundleOutput["output"][number];

function countOutput(
  output: BundleOutput,
  metrics: Measurements,
  externals: Set<string>,
): void {
  const chunks = output.output.filter((file) => file.type === "chunk");
  const names = new Set(chunks.map((chunk) => chunk.fileName));
  for (const chunk of chunks) {
    countChunk(chunk, metrics);
    for (const id of [...chunk.imports, ...chunk.dynamicImports])
      if (!names.has(id)) externals.add(id);
  }
  for (const file of output.output)
    if (file.type === "asset") countAsset(file, metrics);
}

function countChunk(
  chunk: Extract<BundleFile, { type: "chunk" }>,
  metrics: Measurements,
): void {
  metrics.bytes += Buffer.byteLength(chunk.code);
  metrics.gzip += gzipSync(chunk.code, { level: 9 }).length;
  metrics.chunks++;
  if (chunk.isEntry) {
    metrics.entries++;
    metrics.entryExports += chunk.exports.length;
  }
}

function countAsset(
  file: Extract<BundleFile, { type: "asset" }>,
  metrics: Measurements,
): void {
  const bytes =
    typeof file.source === "string"
      ? Buffer.byteLength(file.source)
      : file.source.byteLength;
  if (file.fileName.endsWith(".map")) metrics.maps += bytes;
  else metrics.resources += bytes;
}

async function measure(configs: UserConfig[], mode: Mode): Promise<Metrics> {
  const metrics = {
    bytes: 0,
    gzip: 0,
    chunks: 0,
    entries: 0,
    entryExports: 0,
    resources: 0,
    maps: 0,
  };
  const externals = new Set<string>();
  for (const config of configs) {
    const result = await build(
      mergeConfig(config, {
        configFile: false,
        logLevel: "silent",
        build: { ...(mode === "production" ? {} : modes[mode]), write: false },
      }),
    );
    const outputs = Array.isArray(result) ? result : [result];
    for (const output of outputs) {
      if ("on" in output) throw new Error("Unexpected watch build");
      countOutput(output, metrics, externals);
    }
  }
  return { ...metrics, externals: [...externals].sort() };
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--json"))
  throw new Error("Usage: bun run build:report [--json]");

const groups = [
  ...projects.map((project) => ({
    name: project.directory === "." ? "root" : project.directory,
    configs: [runtimeConfig(project.directory)],
  })),
  {
    name: "desktop",
    configs: bundles.map(bundleConfig),
  },
];
const rows = [];
for (const group of groups) {
  const unoptimized = await measure(group.configs, "unoptimized");
  const shaken = await measure(group.configs, "shaken");
  const production = await measure(group.configs, "production");
  rows.push({ name: group.name, unoptimized, shaken, production });
}
if (args.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        toolchain: { vite: version, rolldown: rolldownVersion, bun: Bun.version },
        rows,
      },
      null,
      2,
    ),
  );
} else {
  console.table(
    rows.map(({ name, unoptimized, shaken, production }) => ({
      project: name,
      "unoptimized bytes": unoptimized.bytes,
      "shaken bytes": shaken.bytes,
      "production bytes": production.bytes,
      "shaking saved": `${(100 * (1 - shaken.bytes / unoptimized.bytes)).toFixed(1)}%`,
      "production gzip bytes": production.gzip,
      "source map bytes": production.maps,
      "retained resource bytes": production.resources,
      "external imports": production.externals.length,
    })),
  );
  console.log(
    "Production uses the build configuration unchanged, with writes disabled. JS sizes include map links; maps and retained resources are counted separately. Desktop sizes precede hash substitution and asset copying. External dependencies are not bundled.",
  );
}
