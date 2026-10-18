import { choice, run } from "../run/run.ts";

if (Bun.argv[2] === "install") {
  await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"]);
  await run([
    process.execPath,
    "install",
    "--cwd",
    "tools/scripts/dependencies",
    "--frozen-lockfile",
    "--ignore-scripts",
  ]);
} else if (Bun.argv[2] === undefined) {
  const task = choice("TASK", [
    "biome",
    "dependencies",
    "architecture",
    "sky",
    "patches",
    "typecheck",
    "build",
    "test",
  ]);
  const workspace = choice("WORKSPACE", ["root", "core", "chatgpt", "omp", "farstep"]);
  const directories = {
    root: ".",
    core: "packages/core",
    chatgpt: "apps/chatgpt",
    omp: "apps/omp",
    farstep: "farstep",
  };
  const directory = directories[workspace];
  if (task === "typecheck") {
    await run(
      workspace === "root"
        ? [process.execPath, "x", "--no-install", "tsc", "-p", "tsconfig.json"]
        : [process.execPath, "run", "--cwd", directory, "typecheck"],
    );
  } else if (task === "build") {
    await run(
      workspace === "root"
        ? [process.execPath, "run", "build:root"]
        : [process.execPath, "run", "--cwd", directory, "build"],
    );
  } else {
    await run([process.execPath, "run", task === "test" ? "test" : `check:${task}`]);
  }
} else {
  throw new Error(`Unknown Bun operation: ${Bun.argv[2]}`);
}
