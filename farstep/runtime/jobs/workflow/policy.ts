import { resolve } from "node:path";
import type { WorkflowGuard } from "#farstep/protocol/workflow/workflow";
import { entryExists } from "./readiness/context";

export { waitForReady } from "./readiness/readiness";
export { validateReadiness } from "./readiness/validation";

export async function evaluateGuards(
  guards: WorkflowGuard[],
  cwd: string,
): Promise<{ run: boolean; reason?: string }> {
  // These ordered observations are not filesystem locks or atomic with launch
  for (const guard of guards) {
    const path = resolve(cwd, guard.path);
    const exists = await entryExists(path);
    if (exists !== (guard.when === "exists")) {
      return {
        run: false,
        reason: `Guard skipped execution: ${path} ${exists ? "exists" : "is missing"}; required ${guard.when}`,
      };
    }
  }
  return { run: true };
}
