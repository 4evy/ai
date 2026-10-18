#!/usr/bin/env bun
import { join } from "node:path";
import { flushObservability, operation } from "@ai/core/effect/effect";
import { errorMessage } from "@ai/core/error/error";
import { Match } from "effect";
import { commandHelp, parseCommand } from "./cli/cli";
import { relayDesktop } from "./desktop";
import { runDeadline } from "./jobs/deadline";
import { runJobs } from "./jobs/jobs";
import { runWorkflow } from "./jobs/workflow/worker";
import { platform } from "./platform/platform";
import { runSky } from "./sky/sky";
import { exists, PROTOCOL_MAJOR, paths, VERSION } from "./state";
import { disableSystem, enableSystem, systemExec, systemStatus } from "./system/system";
import { runSystem } from "./system/tools";

async function assertActivated(): Promise<void> {
  const state = paths().state;
  if (
    (await exists(join(state, "maintenance.lock"))) ||
    !(await exists(join(state, "installer.json")))
  )
    throw new Error("Helper is not activated or is undergoing maintenance");
}

async function main(): Promise<void> {
  const native = await platform();
  process.umask(0o077);
  if (process.argv[2] === "deadline") {
    await runDeadline(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "workflow") {
    await runWorkflow(process.argv.slice(3));
    return;
  }
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(commandHelp(args.filter((arg) => arg !== "--help")));
    return;
  }
  const options = parseCommand(args);
  await executeCommand(options, native);
}

type Command = ReturnType<typeof parseCommand>;
type Native = Awaited<ReturnType<typeof platform>>;

async function writeResult(result: unknown): Promise<void> {
  process.stdout.write(`${JSON.stringify(await result)}\n`);
}

async function installCommand(
  options: Extract<Command, { action: "install" | "upgrade" }>,
  management: Native["management"],
): Promise<void> {
  const packagePath = options.packagePath ?? process.env.FARSTEP_PACKAGE_PATH;
  if (!packagePath || process.env.FARSTEP_PACKAGE_PATH !== packagePath)
    throw new Error("Invoke the selected package's bin/farstep for install or upgrade");
  await writeResult(
    management.install(
      options.action,
      packagePath,
      options.waylandDisplay,
      options.maintenanceToken,
    ),
  );
}

function executeCommand(options: Command, native: Native): Promise<void> {
  const management = native.management;
  return Match.value(options).pipe(
    Match.withReturnType<Promise<void>>(),
    Match.discriminatorsExhaustive("action")({
      "system-exec": async (request) => {
        const reply = await systemExec({
          command: request.command,
          cwd: request.cwd,
          timeout: request.timeout,
        });
        await writeResult(reply);
        process.exitCode = reply.exitCode === 0 ? 0 : 1;
      },
      "system-status": () => writeResult(systemStatus()),
      "system-enable": () => writeResult(enableSystem()),
      "system-disable": () => writeResult(disableSystem()),
      "system-connect": () => runSystem(),
      sky: (request) => runSky(request.cwd ?? process.cwd()),
      desktop: async (request) => {
        if (!native.desktopEndpoint)
          throw new Error(
            "Farstep desktop has no native backend for this platform; use Skylight on macOS",
          );
        await assertActivated();
        await relayDesktop(request.wireCodec === "zstd");
      },
      jobs: async (request) => {
        await assertActivated();
        await runJobs(request.scope, request.owner);
      },
      status: () => writeResult(management.status()),
      prepare: () => writeResult(management.prepareUpgrade()),
      cancel: (request) =>
        writeResult(management.cancelUpgrade(request.maintenanceToken)),
      uninstall: (request) =>
        writeResult(management.uninstall(request.maintenanceToken)),
      install: (request) => installCommand(request, management),
      upgrade: (request) => installCommand(request, management),
    }),
  );
}

if (import.meta.main) {
  try {
    await operation("farstep.main", { component: "farstep" }, () => main());
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ status: "error", protocolMajor: PROTOCOL_MAJOR, version: VERSION, error: errorMessage(error) })}\n`,
    );
    process.exitCode = 1;
  } finally {
    await flushObservability();
  }
}
