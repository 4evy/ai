import { quotePosixArgument as quote } from "@ai/core/shell/shell";
import { readText } from "@ai/core/text/text";
import {
  type Manager,
  type Platform,
  type SupportedManager,
  selectManager,
} from "../platform/platform";

export type Operation = "install" | "upgrade" | "uninstall";

export type Request = {
  action: "inspect" | "plan" | "install" | "upgrade" | "uninstall";
  operation?: Operation | undefined;
  manager?: Manager | undefined;
  artifact?: string | undefined;
  waylandDisplay?: string | undefined;
  maintenanceToken?: string | undefined;
};

import { currentHelper } from "#farstep/client/execution/helper";

export { currentHelper };

export function activationCommand(
  executable: string,
  action: string | readonly string[],
  request: Partial<Request>,
  packagePath?: string,
): string {
  const args = typeof action === "string" ? [action] : [...action];
  if (packagePath) args.push("--package-path", packagePath);
  if (request.waylandDisplay) args.push("--wayland-display", request.waylandDisplay);
  if (request.maintenanceToken)
    args.push("--maintenance-token", request.maintenanceToken);
  return `${executable} ${args.map(quote).join(" ")}`;
}

export const MANAGER_OWNERS = { nix: "nix" } as const satisfies Record<
  SupportedManager,
  string
>;
const OPERATION_ORDER = {
  install: ["activate"],
  upgrade: ["activate"],
  uninstall: ["deactivate"],
} satisfies Record<Operation, string[]>;

function nixPlan(_platform: Platform, operation: Operation, request: Request): string {
  if (
    operation !== "uninstall" &&
    !/^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$/u.test(request.artifact ?? "")
  ) {
    throw new Error(readText(new URL("./plan.md", import.meta.url), "nix"));
  }
  const activation =
    operation === "uninstall"
      ? activationCommand(currentHelper, "uninstall", request)
      : `nix-store --query --hash ${quote(request.artifact ?? "")} >/dev/null && ${activationCommand(quote(`${request.artifact}/bin/farstep`), operation, request, request.artifact)}`;
  return activation;
}

export function installationPlan(platform: Platform, request: Request) {
  const manager = selectManager(platform, request.manager);
  const operation =
    request.action === "plan" ? (request.operation ?? "install") : request.action;
  if (operation === "inspect")
    throw new Error("Inspection does not need an installation plan");
  assertActivation(platform, operation);
  const activation = nixPlan(platform, operation, request);
  return {
    manager,
    operation,
    activation,
    prepare:
      operation === "upgrade" && !request.maintenanceToken
        ? activationCommand(currentHelper, ["upgrade", "prepare"], {})
        : null,
    order: [...OPERATION_ORDER[operation]],
    artifact: request.artifact ?? null,
    warnings: [
      "Nix GC roots retain this per-user installation and its previous generation",
    ],
  };
}

function assertActivation(platform: Platform, operation: Operation): void {
  if (operation !== "uninstall" && platform.os === "Linux" && !platform.systemdUser)
    throw new Error(
      "The selected SSH user has no reachable systemd user manager; establish the user session before activation",
    );
}
