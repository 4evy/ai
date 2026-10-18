import { run } from "../run/run.ts";

await run([process.execPath, ".github/scripts/actionlint/actionlint.ts"]);
await run(["zizmor", "--offline", "--persona", "pedantic", ".github/workflows"]);
