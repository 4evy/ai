import { join } from "node:path";
import { getAvailableTranspilers } from "dependency-cruiser";

// TypeScript 7 has no JavaScript compiler API, so this analyzer uses an isolated
// TypeScript 6 dependency and rejects upgrades that would skip TypeScript sources
const typescript = getAvailableTranspilers().find(({ name }) => name === "typescript");
if (!typescript?.available)
  throw new Error("Architecture checks require dependency-cruiser's TypeScript API");

const child = Bun.spawn(
  [
    process.execPath,
    join(import.meta.dir, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs"),
    ...Bun.argv.slice(2),
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
process.exitCode = await child.exited;
