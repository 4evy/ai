import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type InlineConfig, mergeConfig } from "vite";
import type { Bundle } from "../../../farstep/native/desktop/platform/linux/extensions/bundles.ts";
import { modes } from "./options.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

export function bundleConfig({ entry, qml }: Bundle): InlineConfig {
  const config: InlineConfig = {
    root: repo,
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    plugins: [
      {
        name: "protocol-xml",
        async load(id) {
          if (id.endsWith(".xml"))
            return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
          return undefined;
        },
      },
    ],
    build: {
      write: false,
      target: "esnext",
      lib: {
        entry: join(repo, "farstep/native/desktop/platform/linux/extensions", entry),
        formats: [qml ? "iife" : "es"],
        name: "FarstepKWin",
      },
      rolldownOptions: {
        preserveEntrySignatures: "strict",
        external: [/^gi:\/\//, /^resource:\/\//],
        output: { codeSplitting: false },
      },
    },
  };
  return mergeConfig(config, { build: modes.production });
}
