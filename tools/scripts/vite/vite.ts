import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { mergeConfig, type Plugin, type UserConfig } from "vite";
import { modes } from "./options.ts";
import { files, type Project, projects, repo } from "./projects.ts";

function resources(project: Project): Plugin {
  return {
    name: "runtime-resources",
    async generateBundle(_options, bundle) {
      const modules = Object.values(bundle).flatMap((output) =>
        output.type === "chunk" ? Object.keys(output.modules) : [],
      );
      const owners = projects.filter(
        (owner) =>
          owner === project ||
          modules.some((id) =>
            owner.roots.some((root) => relative(repo, id).startsWith(`${root}/`)),
          ),
      );
      for (const file of new Set(owners.flatMap((owner) => files(owner.resources)))) {
        const absolute = join(repo, file);
        this.addWatchFile(absolute);
        if (bundle[file]) continue;
        this.emitFile({
          type: "asset",
          fileName: file,
          source: await readFile(absolute),
        });
      }
    },
  };
}

export function runtimeConfig(directory = "."): UserConfig {
  const project = projects.find((project) => project.directory === directory);
  if (!project) throw new Error(`Unknown Vite project: ${directory}`);
  const entries = files(project.entries);
  if (!entries.length) throw new Error(`No Vite entries for ${directory}`);
  const config: UserConfig = {
    root: repo,
    publicDir: false,
    plugins: [resources(project)],
    build: {
      ssr: true,
      target: "esnext",
      outDir: resolve(repo, directory, "dist"),
      emptyOutDir: true,
      sourcemap: true,
      reportCompressedSize: false,
      rolldownOptions: {
        input: entries.map((file) => join(repo, file)),
        external: (id) =>
          !id.startsWith(".") &&
          !id.startsWith("/") &&
          !id.startsWith("#") &&
          !id.startsWith("\0"),
        preserveEntrySignatures: "strict",
        output: {
          format: "es",
          entryFileNames: "[name].js",
          chunkFileNames: "[name].js",
          preserveModules: true,
          preserveModulesRoot: repo,
          virtualDirname: `_virtual/${directory === "." ? "root" : directory}`,
        },
      },
    },
  };
  return mergeConfig(config, { build: modes.production });
}
