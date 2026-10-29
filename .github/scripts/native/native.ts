import { join } from "node:path";
import { formatMessage } from "@optique/core/message";
import { optional } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { argument } from "@optique/core/primitives";
import { choice } from "@optique/core/valueparser";
import * as v from "valibot";
import { root, run } from "../run/run.ts";

const parsed = parseSync(
  optional(argument(choice(["rust-install", "clippy", "tests"] as const))),
  Bun.argv.slice(2),
);
if (!parsed.success) throw new Error(formatMessage(parsed.error));
const operation = parsed.value ?? process.env.TASK;
switch (operation) {
  case "rust-install": {
    const manifest = await Bun.file(join(root, "Cargo.toml")).text();
    const { workspace } = v.parse(
      v.object({
        workspace: v.object({
          package: v.object({ "rust-version": v.pipe(v.string(), v.nonEmpty()) }),
        }),
      }),
      Bun.TOML.parse(manifest),
    );
    const version = workspace.package["rust-version"];
    await run([
      "rustup",
      "toolchain",
      "install",
      version,
      "--profile",
      "minimal",
      "--component",
      "clippy",
    ]);
    await run(["rustup", "override", "set", version]);
    break;
  }
  case "clippy":
    await run([
      "cargo",
      "clippy",
      "--locked",
      "--workspace",
      "--all-targets",
      "--all-features",
    ]);
    break;
  case "tests":
    await run(["cargo", "test", "--locked", "--workspace", "--all-features"]);
    await run(["cargo", "build", "--locked", "--workspace", "--all-features"]);
    for (const name of ["farstep-desktop", "farstep-service"])
      await run([
        join(
          root,
          "target/debug",
          `${name}${process.platform === "win32" ? ".exe" : ""}`,
        ),
        "--help",
      ]);
    break;
  default:
    throw new Error(`Unknown native operation: ${operation ?? "(unset)"}`);
}
