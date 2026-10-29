import { globSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageJsonSchema } from "@ai/values/schema/package";
import * as v from "valibot";

export const repo = fileURLToPath(new URL("../../../", import.meta.url));

type Selection = { include: string[]; exclude?: string[] };
type Copy = { from: string; to: string; optional?: boolean };
type Settings = {
  roots?: string[];
  entries?: string[];
  exclude?: string[];
  copies?: Copy[];
  remove?: string[];
};

export type Project = {
  directory: string;
  roots: string[];
  entries: Selection;
  resources: Selection;
  install: { modules: Copy[]; resources: Copy[]; remove: string[] };
};

const ignored = [
  "**/{node_modules,dist,build,tmp,upstream,dependencies}/**",
  "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
];
const settings: Record<string, Settings> = {
  ".": {
    roots: [
      "apps/browser",
      "apps/codex",
      "apps/claude",
      "apps/opencode",
      "config/settings",
      "apps/ghidra",
      "tools/scripts",
    ],
    entries: [
      "apps/browser/{chromium,firefox}/*.ts",
      "apps/codex/codex.ts",
      // Preserve Codex exports imported by ChatGPT across project builds
      "apps/codex/lib/**/*.ts",
      "apps/claude/claude.ts",
      "apps/opencode/opencode.ts",
      "config/settings/generate/generate.ts",
      "apps/ghidra/macos/macos.ts",
      "apps/ghidra/native/{install,runtime}.ts",
      "tools/scripts/format/format.ts",
      "tools/scripts/cli/cli.ts",
      "tools/scripts/omp/{update,runtime/{runtime,launch},patches/patches}.ts",
      "tools/scripts/sky/{sky,update}.ts",
      "tools/scripts/renovate/artifacts.ts",
      "tools/scripts/rust/rust.ts",
      "tools/scripts/setup/{setup,automatic}.ts",
    ],
  },
  "apps/chatgpt": {
    entries: [
      "apps/chatgpt/{launcher,configure/configure,plugins/plugins,policy/policy,repl/repl}.ts",
    ],
  },
  "apps/omp": {
    exclude: ["apps/omp/runtime/overlays/**"],
    copies: [
      {
        from: "apps/omp/runtime/upstream/package.json",
        to: "apps/omp/runtime/upstream/package.json",
      },
      {
        from: "apps/omp/runtime/upstream/bun.lock",
        to: "apps/omp/runtime/upstream/bun.lock",
      },
    ],
    // OMP loads index.ts before index.js when both files exist
    remove: ["apps/omp/extensions/*/index.ts"],
  },
  farstep: {
    entries: [
      "farstep/runtime/main.ts",
      "farstep/runtime/jobs/script/script.ts",
      "farstep/runtime/jobs/broker/main.ts",
      "farstep/runtime/jobs/workflow/worker.ts",
      "farstep/runtime/sky/linux/service.ts",
    ],
    copies: [
      { from: "farstep/dist/extensions", to: "farstep/extensions" },
      { from: "farstep/sky", to: "farstep/sky" },
    ],
  },
};

function targets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(targets);
  return [];
}

export function projects(
  directories = process.env.AI_BUILD_PROJECTS?.split(","),
): Project[] {
  const selected: string[] = directories ?? [
    ".",
    ...JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).workspaces.packages,
  ];
  return selected.map((directory) => {
    const metadata = v.parse(
      packageJsonSchema,
      JSON.parse(readFileSync(join(repo, directory, "package.json"), "utf8")),
    );
    const config = settings[directory] ?? {};
    const roots = config.roots ?? [directory];
    return {
      directory,
      roots,
      entries: {
        include: [
          ...targets(metadata.exports)
            .filter((target) => target.endsWith(".ts") && !target.endsWith(".d.ts"))
            .map((target) => join(directory, target.replaceAll("*", "**/*"))),
          ...targets(metadata.bin).map((target) => join(directory, target)),
          ...(config.entries ?? []),
        ],
        exclude: [
          ...ignored,
          "**/*.d.ts",
          "**/vite.config.ts",
          ...(config.exclude ?? []),
        ],
      },
      // Keep sources for overlays, fingerprints, and native packaging
      resources: {
        include: roots.map((root) => `${root}/**/*`),
        exclude: [...ignored, "**/vite.config.ts", "tools/scripts/vite/**"],
      },
      install: {
        modules: [
          { from: join(directory, "dist", directory), to: directory },
          ...(directory === "."
            ? []
            : [
                {
                  from: join(directory, "dist/_virtual"),
                  to: "_virtual",
                  optional: true,
                },
              ]),
        ] satisfies Copy[],
        resources: config.copies ?? [],
        remove: config.remove ?? [],
      },
    };
  });
}

export function files(selection: Selection, cwd = repo): string[] {
  return [
    ...new Set(
      globSync(selection.include, { cwd, exclude: selection.exclude ?? [] }).filter(
        (file) => statSync(resolve(cwd, file)).isFile(),
      ),
    ),
  ].sort();
}
