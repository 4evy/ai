import { run } from "./process";

export async function updateSkylight() {
  await run(["bun", "install", "--ignore-scripts"]);
  await run(["bun", "tools/scripts/sky/update.ts"]);
}
