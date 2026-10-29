#!/usr/bin/env bun
import { flushObservability } from "@ai/core/effect/effect";
import { errorMessage } from "@ai/core/error/error";
import { schemaJsonSchema } from "@ai/core/schema/json";
import { object } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { optional, withDefault } from "@optique/core/modifiers";
import { parseSync } from "@optique/core/parser";
import { flag, option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import * as v from "valibot";
import { remoteDefinitions } from "../remote/remote";
import { ToolClient, toolRequestSchema } from "./client";
import { forwardService } from "./forward";
import { retrieveFile } from "./transfer";

const approvals = {
  connect: "exec",
  reconnect: "read",
  launch: "exec",
  observe: "read",
  stop: "exec",
  forward: "exec",
  retrieve: "write",
} as const;

export function toolCatalog() {
  return {
    executable: "bun run farstep:tools --state DIRECTORY",
    input:
      "One JSON request on stdin. Each invocation opens a fresh authenticated connection. No operation is automatically replayed",
    parameters: schemaJsonSchema(toolRequestSchema),
    approvals,
    lifecycle:
      "Jobs persist until explicit stop. Forward listeners exist only while their CLI process and owning job remain live. SIGINT/SIGTERM releases the forward, not the service",
    sourceTools: Object.values(remoteDefinitions).map((tool) => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      loadMode: tool.loadMode,
      approval: typeof tool.approval === "function" ? "input-dependent" : tool.approval,
      parameters: schemaJsonSchema(tool.parameters),
    })),
  };
}

function print(result: unknown) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main() {
  const parsed = parseSync(
    object({
      state: optional(option("--state", string())),
      discover: withDefault(flag("--discover"), false),
      help: withDefault(flag("--help"), false),
    }),
    Bun.argv.slice(2),
  );
  if (!parsed.success) throw new Error(formatMessage(parsed.error));
  const values = parsed.value;
  if (values.discover) {
    print(toolCatalog());
    return;
  }
  if (values.help) {
    process.stdout.write(
      "farstep-tools --state DIRECTORY < request.json\nfarstep-tools --discover\n\nUse discover for the validated JSON action schema and approval metadata.\nConnect once with target (local or OpenSSH destination) and absolute cwd.\nThe private state directory pins helper installation, scope, owner, and native job identities.\nKeep it for observe, reconnect, retrieve, forward, and stop from another invocation.\nLaunch names are single-use. A lost launch reply must be observed, never replayed.\nRemote targets require OpenSSH batch authentication, Bash, and activated Farstep.\nLocal targets require Bun, Bash, and activated Farstep. No installation is performed.\nForward requires launch.ready.port with host 127.0.0.1 and a live ready job.\nRun forward in a managed local process, then stop that process to release its listener.\nRetrieve accepts regular files up to 16 MiB and verifies source/staged SHA-256.\nexpectedSha256:null creates a new destination, a hash permits replacing matching content.\n",
    );
    return;
  }
  if (!values.state)
    throw new Error(
      "--state DIRECTORY is required. Use --discover for request schemas",
    );
  const source = await Bun.stdin.text();
  if (Buffer.byteLength(source) > 128 * 1024)
    throw new Error("Request exceeds 128 KiB");
  const request = v.parse(toolRequestSchema, JSON.parse(source));
  if (request.action === "connect") {
    await using client = await ToolClient.connect(values.state, {
      target: request.target,
      cwd: request.cwd,
    });
    print(client.identity());
    return;
  }
  await using client = await ToolClient.reconnect(values.state);
  switch (request.action) {
    case "reconnect":
      print(client.identity());
      break;
    case "launch": {
      const { action: _, ...input } = request;
      print(await client.launch(input));
      break;
    }
    case "observe":
      print(await client.observe(request.name));
      break;
    case "stop":
      print(await client.stop(request.name));
      break;
    case "retrieve":
      await client.inspect(request.name);
      print(
        await retrieveFile(
          client.connection,
          client.gateway.scriptRunner.application,
          request.source,
          request.destination,
          request.expectedSha256,
        ),
      );
      break;
    case "forward": {
      const abort = new AbortController();
      const stop = () => abort.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        await forwardService(
          client,
          request.name,
          request.localPort,
          abort.signal,
          print,
        );
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
      break;
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    print({ status: "error", error: errorMessage(error), replayed: false });
    process.exitCode = 1;
  } finally {
    await flushObservability();
  }
}
