import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { localHelper } from "farstep/client/execution/local";
import { structuredResult } from "farstep/protocol/identity";
import {
  SYSTEM_CAPABILITY,
  systemExecResultSchema,
  systemExecSchema,
  systemStatusSchema,
} from "farstep/protocol/system";
import { remoteDefinitions } from "farstep/remote/remote";
import { connectHelper } from "farstep/transport/connection/bun";
import * as v from "valibot";
import { registerSchemaTool } from "#apps/omp/lib/schema/tool";
import { helperCommand, remoteArgv } from "../connections/command";
import type { Connections } from "../connections/state";
import type { ExecutionTarget } from "../connections/types";

const SYSTEM_EXEC_GRACE_SECONDS = 15;
const SYSTEM_PLATFORMS = {
  macos: "darwin",
  windows: "win32",
  linux: "linux",
  unknown: "linux",
} as const;

async function transport(target: ExecutionTarget) {
  if (target.backend !== "local")
    return {
      command: "ssh",
      args: await remoteArgv(
        target,
        helperCommand(target, ["system", "connect"]),
        false,
      ),
    };
  try {
    return { command: await localHelper(target), args: ["system", "connect"] };
  } catch (error) {
    const source = fileURLToPath(import.meta.resolve("farstep/cli"));
    if (!(await Bun.file(source).exists())) throw error;
    return { command: process.execPath, args: [source, "system", "connect"] };
  }
}

export function registerSystemTool(api: ExtensionAPI, { execution }: Connections) {
  registerSchemaTool(api, {
    ...remoteDefinitions.system,
    async execute(_id, input, signal, _update, ctx) {
      const target = await execution(input.target, ctx.cwd);
      await using helper = await connectHelper(
        "farstep-system",
        await transport(target),
        signal ? { signal } : {},
      );
      if (!helper.identity.capabilities.includes(SYSTEM_CAPABILITY))
        throw new Error("Upgrade Farstep to a version with system access");
      const platform = SYSTEM_PLATFORMS[target.info.os];
      if (helper.identity.platform !== platform)
        throw new Error("System helper platform mismatch");
      const reply =
        input.action === "inspect"
          ? await helper.call("system.inspect", {}, signal)
          : await helper.call(
              "system.exec",
              v.parse(systemExecSchema, {
                command: input.command,
                cwd: input.cwd,
                timeout: input.timeout,
              }),
              signal,
              (input.timeout + SYSTEM_EXEC_GRACE_SECONDS) * 1000,
            );
      const metadata =
        input.action === "inspect"
          ? v.parse(systemStatusSchema, structuredResult(reply))
          : v.parse(systemExecResultSchema, structuredResult(reply));
      return {
        content: [{ type: "text", text: JSON.stringify(metadata, null, 2) }],
        details: metadata,
        ...(reply.isError ? { isError: true } : {}),
      };
    },
  });
}
