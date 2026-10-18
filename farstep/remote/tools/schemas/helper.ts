import * as v from "valibot";
import { maintenanceTokenSchema } from "#farstep/protocol/identity";
import { MANAGERS } from "./managers";

export function createHelperParameters() {
  const parameters = v.object({
    connection: v.pipe(v.string(), v.minLength(1)),
    action: v.picklist(["inspect", "plan", "install", "upgrade", "uninstall"]),
    subcommand: v.pipe(
      v.optional(v.literal("cancel")),
      v.description(
        "Use action upgrade with subcommand cancel to restore a prepared upgrade",
      ),
    ),
    operation: v.pipe(
      v.optional(v.picklist(["install", "upgrade", "uninstall"])),
      v.description("Operation to preview with action plan; defaults to install"),
    ),
    manager: v.pipe(
      v.optional(v.picklist(MANAGERS)),
      v.description("Nix is required on Linux and macOS"),
    ),
    artifact: v.pipe(
      v.optional(v.pipe(v.string(), v.minLength(1))),
      v.description(
        "Absolute remote path to a realized Nix store output; no downloads",
      ),
    ),
    waylandDisplay: v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+$/u))),
    maintenanceToken: v.pipe(
      v.optional(maintenanceTokenSchema),
      v.description(
        "Upgrade recovery token; inspect package state before resuming, restore the old package before cancelling",
      ),
    ),
    timeout: v.pipe(
      v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3600))),
      v.description("Activation timeout in seconds, default 60"),
    ),
  });
  return { parameters };
}
