import { conditional, object, or } from "@optique/core/constructs";
import { runParserSync } from "@optique/core/facade";
import { formatMessage } from "@optique/core/message";
import { map, optional, withDefault } from "@optique/core/modifiers";
import type { InferValue } from "@optique/core/parser";
import {
  argument,
  command,
  constant,
  option,
  passThrough,
} from "@optique/core/primitives";
import { valibot } from "@optique/valibot";
import * as v from "valibot";

const text = valibot(v.pipe(v.string(), v.nonEmpty()), { placeholder: "" });
const installation = {
  packagePath: optional(option("--package-path", text)),
  waylandDisplay: optional(option("--wayland-display", text)),
  maintenanceToken: optional(option("--maintenance-token", text)),
};
const pageNumber = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) =>
  valibot(
    v.pipe(
      v.string(),
      v.toNumber(),
      v.safeInteger(),
      v.minValue(minimum),
      v.maxValue(maximum),
    ),
    { placeholder: minimum },
  );
const parser = or(
  command(
    "deadline",
    object({
      action: constant("deadline"),
      args: withDefault(passThrough({ format: "greedy" }), []),
    }),
    { hidden: true },
  ),
  command(
    "workflow",
    object({
      action: constant("workflow"),
      args: withDefault(passThrough({ format: "greedy" }), []),
    }),
    { hidden: true },
  ),
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
  command(
    "doctor",
    object({
      action: constant("doctor"),
      command: optional(option("--command", text)),
      scope: optional(
        option(
          "--scope",
          valibot(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)), {
            placeholder: "scope-id",
          }),
        ),
      ),
    }),
  ),
  command(
    "work",
    command(
      "list",
      object({
        action: constant("work-list"),
        project: optional(option("--project", text)),
        cursor: withDefault(option("--cursor", pageNumber(0)), 0),
        limit: withDefault(option("--limit", pageNumber(1, 100)), 50),
      }),
    ),
  ),
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

export type Command = Exclude<
  InferValue<typeof parser>,
  { action: "deadline" | "workflow" }
>;

export function parseCommand(args: readonly string[]) {
  let help: string | undefined;
  const result = runParserSync(parser, "farstep", args, {
    help: { option: true, onShow: () => {} },
    showChoices: true,
    showDefault: true,
    stdout: (text) => {
      help = text;
    },
    stderr: () => {},
    onError: (_exitCode, error) => {
      throw new Error(formatMessage(error));
    },
  });
  return help === undefined ? result : { action: "help" as const, text: help };
}
