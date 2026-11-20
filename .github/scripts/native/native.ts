import { join } from "node:path";
import { root, run } from "../run/run.ts";

await run(["cargo", "test", "--locked", "--workspace", "--all-features"]);
await run(["cargo", "build", "--locked", "--workspace", "--all-features"]);
for (const name of ["farstep-desktop", "farstep-service"])
  await run([
    join(root, "target/debug", `${name}${process.platform === "win32" ? ".exe" : ""}`),
    "--help",
  ]);
