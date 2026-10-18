import { randomUUID } from "node:crypto";
import { readFileSync as readResource } from "node:fs";
import { run } from "@ai/core/effect/effect";
import { render } from "@ai/core/template/template";
import { Effect } from "effect";
import * as v from "valibot";
import {
  type ScriptTransport,
  scriptCommandEffect,
} from "../../../client/execution/execution";

const probeScript = readResource(new URL("./probe.sh", import.meta.url), "utf8");

const probeText = v.pipe(v.string(), v.minLength(1));
const probeBoolean = v.pipe(
  v.picklist(["yes", "no"]),
  v.transform((value) => value === "yes"),
);
const platformProbeSchema = v.strictTuple([
  probeText,
  probeText,
  probeText,
  probeBoolean,
  v.pipe(
    v.string(),
    v.transform((value) => value.split(/\s+/u)),
  ),
  probeBoolean,
]);

import { MANAGERS } from "../../tools/schemas/managers";

export type Manager = (typeof MANAGERS)[number];
export type SupportedManager = Manager;

export type Platform = {
  os: string;
  arch: string;
  distribution: string;
  immutable: boolean;
  available: Manager[];
  recommended: Manager | null;
  systemdUser: boolean;
};

function recommendManager(os: string, available: readonly Manager[]): Manager | null {
  return ["Linux", "Darwin"].includes(os) && available.includes("nix") ? "nix" : null;
}

/** Probe over plain SSH so discovery also works before the helper exists */
const inspectPlatformEffect = Effect.fnUntraced(function* (
  transport: ScriptTransport,
): Effect.fn.Return<Platform, unknown> {
  const marker = `FARSTEP_${randomUUID().replaceAll("-", "")}`;
  const output = yield* scriptCommandEffect(
    transport,
    render(probeScript, { MANAGERS: MANAGERS.join(" "), MARKER: marker }),
  );
  const frame = `\0${marker}\0`;
  const start = output.indexOf(frame);
  const end = output.indexOf(frame, start + frame.length);
  if (start < 0 || end < 0)
    return yield* Effect.fail(new Error("Incomplete helper platform probe"));
  const facts = v.safeParse(
    platformProbeSchema,
    output.slice(start + frame.length, end).split("\0"),
  );
  if (!facts.success)
    return yield* Effect.fail(new Error("Invalid helper platform probe"));
  const [os, arch, distribution, immutable, managers, systemdUser] = facts.output;
  const available = MANAGERS.filter((manager) => managers.includes(manager));
  const recommended = recommendManager(os, available);
  return {
    os,
    arch,
    distribution,
    immutable,
    available,
    recommended,
    systemdUser,
  };
});

export function inspectPlatform(
  transport: ScriptTransport,
  signal?: AbortSignal,
): Promise<Platform> {
  return run(inspectPlatformEffect(transport), signal);
}

export function selectManager(
  platform: Platform,
  requested?: Manager,
): SupportedManager {
  if (platform.os !== "Linux" && platform.os !== "Darwin")
    throw new Error("farstep supports Linux and macOS jobs");
  const manager = requested ?? platform.recommended;
  if (manager !== "nix" || !platform.available.includes(manager))
    throw new Error("Install Nix on the target host before deploying Farstep");
  return manager;
}
