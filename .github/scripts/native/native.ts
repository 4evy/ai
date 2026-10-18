import { join } from "node:path";
import { root, run } from "../run/run.ts";

const operation = Bun.argv[2] ?? process.env.TASK;
switch (operation) {
  case "rust-install": {
    const manifest = await Bun.file(join(root, "Cargo.toml")).text();
    const version = /^rust-version = "([^"]+)"$/m.exec(manifest)?.[1];
    if (!version) throw new Error("Cargo.toml has no rust-version");
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
