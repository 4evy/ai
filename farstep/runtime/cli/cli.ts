import { conditional, object, or } from "@optique/core/constructs";
import { formatDocPage } from "@optique/core/doc";
import { formatMessage } from "@optique/core/message";
import { map, optional, withDefault } from "@optique/core/modifiers";
import { getDocPageSync, parseSync } from "@optique/core/parser";
import { argument, command, constant, option } from "@optique/core/primitives";
import { valibot } from "@optique/valibot";
import * as v from "valibot";

const text = valibot(v.pipe(v.string(), v.nonEmpty()), { placeholder: "" });
const installation = {
  packagePath: optional(option("--package-path", text)),
  waylandDisplay: optional(option("--wayland-display", text)),
  maintenanceToken: optional(option("--maintenance-token", text)),
};
const parser = or(
  command(
    "sky",
    command(
      "connect",
      object({
        action: constant("sky"),
        cwd: optional(option("--cwd", text)),
      }),
    ),
  ),
  command("status", constant({ action: "status" } as const)),
  command("install", object({ action: constant("install"), ...installation })),
  command(
    "upgrade",
    map(
      conditional(
        argument(
          valibot(v.picklist(["prepare", "cancel"]), {
            metavar: "ACTION",
            placeholder: "prepare",
          }),
        ),
        {
          prepare: constant({ action: "prepare" } as const),
          cancel: object({
            action: constant("cancel"),
            maintenanceToken: option("--maintenance-token", text),
          }),
        },
        object({ action: constant("upgrade"), ...installation }),
      ),
      ([, options]) => options,
    ),
  ),
  command(
    "uninstall",
    object({
      action: constant("uninstall"),
      maintenanceToken: installation.maintenanceToken,
    }),
  ),
  command(
    "desktop",
    command(
      "connect",
      object({
        action: constant("desktop"),
        wireCodec: optional(
          option("--wire-codec", valibot(v.literal("zstd"), { placeholder: "zstd" })),
        ),
      }),
    ),
  ),
  command(
    "jobs",
    object({
      action: constant("jobs"),
      scope: option("--scope", text),
      owner: option("--owner", text),
    }),
  ),
  command(
    "system",
    or(
      command("status", constant({ action: "system-status" } as const)),
      command("enable", constant({ action: "system-enable" } as const)),
      command("disable", constant({ action: "system-disable" } as const)),
      command("connect", constant({ action: "system-connect" } as const)),
      command(
        "exec",
        object({
          action: constant("system-exec"),
          command: withDefault(option("--command", text), ""),
          cwd: withDefault(option("--cwd", text), "/"),
          timeout: withDefault(
            option(
              "--timeout",
              valibot(v.pipe(v.string(), v.toNumber(), v.finite(), v.minValue(0)), {
                placeholder: 60,
              }),
            ),
            60,
          ),
        }),
      ),
    ),
  ),
);

export function parseCommand(args: readonly string[]) {
  const result = parseSync(parser, args);
  if (!result.success) throw new Error(formatMessage(result.error));
  return result.value;
}

export function commandHelp(args: readonly string[]): string {
  const page = getDocPageSync(parser, args) ?? getDocPageSync(parser, []);
  if (!page) throw new Error("Helper command help is unavailable");
  return formatDocPage("farstep", page, { showChoices: true, showDefault: true });
}
