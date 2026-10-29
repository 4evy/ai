import { formatMessage } from "@optique/core/message";
import { optional } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { command, constant } from "@optique/core/primitives";
import { choice, run } from "../run/run.ts";

const parsed = parseSync(
  optional(command("install", constant("install"))),
  Bun.argv.slice(2),
);
if (!parsed.success) throw new Error(formatMessage(parsed.error));
if (parsed.value === "install") {
  await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"]);
  await run([
    process.execPath,
    "install",
    "--cwd",
    "tools/scripts/dependencies",
    "--frozen-lockfile",
    "--ignore-scripts",
  ]);
} else {
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
}
