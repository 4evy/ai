import { run } from "@ai/core/effect/effect";
import { readText } from "@ai/core/text/text";
import { toError } from "@oh-my-pi/pi-utils/type-guards";
import * as v from "valibot";
import {
  type ExecutionTarget,
  type ScriptTransport,
  scriptCommandEffect,
} from "#farstep/client/execution/execution";
import {
  type HelperStatus,
  helperStatus as inspectStatus,
} from "#farstep/client/execution/status";
import { maintenanceTokenSchema } from "#farstep/protocol/identity";
import type { createHelperParameters } from "../../tools/schemas/helper";
import {
  activationCommand,
  currentHelper,
  installationPlan,
  MANAGER_OWNERS,
  type Request,
} from "../plan/plan";
import { inspectPlatform } from "../platform/platform";

export interface HelperHost {
  transport: ScriptTransport;
  saveStatus(status: HelperStatus): void;
  disconnect(): Promise<void>;
}

function helperStatus(
  connection: ExecutionTarget,
  host: HelperHost,
  signal?: AbortSignal,
) {
  return inspectStatus(connection.info.os, host.transport, signal);
}

function remoteCommand(
  host: HelperHost,
  script: string,
  signal?: AbortSignal,
  timeout = 30_000,
) {
  return run(scriptCommandEffect(host.transport, script, timeout), signal);
}

const ACTIVATION_TIMEOUT_MS = 60_000;
const preparationSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.object({ maintenanceToken: maintenanceTokenSchema }),
);
const ARTIFACT_POLICY = readText(new URL("./manage.md", import.meta.url), "artifact");
const RECOVERY = {
  activation: {
    gated: readText(new URL("./manage.md", import.meta.url), "activationgated"),
    ungated: "Inspect the Nix output and activation state before retrying.",
  },
} as const;

export type HelperInput = v.InferInput<
  ReturnType<typeof createHelperParameters>["parameters"]
>;

function result(details: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

type InstallationPlan = ReturnType<typeof installationPlan>;

async function assertOperation(
  connection: ExecutionTarget,
  args: HelperInput,
  plan: InstallationPlan,
  host: HelperHost,
  signal?: AbortSignal,
): Promise<void> {
  const before = args.maintenanceToken
    ? undefined
    : await helperStatus(connection, host, signal);
  if (!args.maintenanceToken) assertInitialOperation(args, before);
  const owner = MANAGER_OWNERS[plan.manager];
  if (
    args.action !== "uninstall" &&
    before?.installed &&
    before.manager !== undefined &&
    before.manager !== owner
  )
    throw new Error(
      "Changing package-manager ownership requires an explicit uninstall first",
    );
}

function assertInitialOperation(
  args: HelperInput,
  before: Awaited<ReturnType<typeof helperStatus>> | undefined,
): void {
  if (args.action === "install" && before?.installed)
    throw new Error(
      "Helper is already activated; use upgrade so live work is quiesced before package replacement",
    );
  if (args.action === "upgrade" && !before?.installed)
    throw new Error("Helper is not activated; use install");
}

async function refreshHelper(
  connection: ExecutionTarget,
  host: HelperHost,
  signal?: AbortSignal,
): Promise<void> {
  host.saveStatus(await helperStatus(connection, host, signal));
}

export async function manageHelper(
  connection: ExecutionTarget,
  args: HelperInput,
  host: HelperHost,
  signal?: AbortSignal,
) {
  if (args.subcommand && args.action !== "upgrade")
    throw new Error("subcommand cancel is only valid with action upgrade");
  const platform = await inspectPlatform(host.transport, signal);
  if (args.action === "inspect") {
    const status = await helperStatus(connection, host, signal);
    host.saveStatus(status);
    return result({
      platform,
      status,
      artifactPolicy: ARTIFACT_POLICY,
    });
  }
  if (args.action === "upgrade" && args.subcommand === "cancel") {
    return cancelUpgrade(connection, args, platform, host, signal);
  }
  let request: Request = { ...args, action: args.action };
  let plan = installationPlan(platform, request);
  if (args.action === "plan") return result({ platform, plan });
  await assertOperation(connection, args, plan, host, signal);
  let maintenanceToken = args.maintenanceToken;
  return activate();

  async function activate() {
    try {
      if (plan.prepare) {
        const prepared = v.parse(
          preparationSchema,
          await remoteCommand(host, plan.prepare, signal),
        );
        maintenanceToken = prepared.maintenanceToken;
        if (!maintenanceToken) throw new Error("Helper returned no maintenance token");
        request = { ...request, maintenanceToken };
        plan = installationPlan(platform, request);
      }
      if (maintenanceToken) await host.disconnect();
      let status: unknown;
      if (args.action === "uninstall") {
        status = JSON.parse(await remoteCommand(host, plan.activation, signal));
        await host.disconnect();
      }
      if (args.action !== "uninstall")
        status = JSON.parse(
          await remoteCommand(
            host,
            plan.activation,
            signal,
            (args.timeout ?? ACTIVATION_TIMEOUT_MS / 1000) * 1000,
          ),
        );
      await refreshHelper(connection, host, signal);
      if (args.action === "upgrade") await host.disconnect();
      return result({ platform, plan, status });
    } catch (error) {
      return result(
        {
          platform,
          plan,
          maintenanceToken,
          error: toError(error).message,
          recovery: RECOVERY.activation[maintenanceToken ? "gated" : "ungated"],
        },
        true,
      );
    }
  }
}

async function cancelUpgrade(
  connection: ExecutionTarget,
  args: HelperInput,
  platform: Awaited<ReturnType<typeof inspectPlatform>>,
  host: HelperHost,
  signal?: AbortSignal,
) {
  if (!args.maintenanceToken)
    throw new Error("upgrade cancel requires the returned maintenanceToken");
  const status = JSON.parse(
    await remoteCommand(
      host,
      activationCommand(currentHelper, ["upgrade", "cancel"], {
        maintenanceToken: args.maintenanceToken,
      }),
      signal,
    ),
  );
  await refreshHelper(connection, host, signal);
  return result({ platform, status });
}
