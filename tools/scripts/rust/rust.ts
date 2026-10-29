import { resolve } from "node:path";
import { run } from "@ai/runtime/effect/effect";
import { executeCommand } from "@ai/runtime/effect/process/process";

const root = resolve(import.meta.dir, "../../..");
const configurations = [
  ["farstep-protocol", []],
  ["farstep-desktop-runtime", []],
  ["farstep-protocol", ["schema"]],
  ["farstep-desktop-runtime", ["backend"]],
  ["farstep-desktop-runtime", ["image"]],
  ["farstep-desktop-runtime", ["server"]],
  ["farstep-desktop", []],
  ["farstep-desktop", ["cli"]],
  ["farstep-desktop", ["desktop"]],
  ...(process.platform === "linux"
    ? ([["farstep-desktop", ["systemd"]]] as const)
    : []),
] as const;

async function cargo(arguments_: string[]): Promise<void> {
  const command = [process.env.CARGO ?? "cargo", ...arguments_];
  const { code: status } = await run(
    executeCommand(command, {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  if (status !== 0) throw new Error(`${command.join(" ")} failed (${status})`);
}

await cargo(["fmt", "--all", "--check"]);
for (const [name, features] of configurations)
  await cargo([
    "clippy",
    "--locked",
    "--all-targets",
    "--package",
    name,
    "--no-default-features",
    ...(features.length ? ["--features", features.join(",")] : []),
  ]);
await cargo(["clippy", "--locked", "--workspace", "--all-targets", "--all-features"]);
