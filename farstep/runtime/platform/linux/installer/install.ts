import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { verifyBrokerRuntime } from "#farstep/runtime/jobs/jobs";
import { loadIdentity, privateDirectory } from "#farstep/runtime/state";
import { enableSystem } from "#farstep/runtime/system/system";
import {
  activateDesktop,
  backupFiles,
  desktopEnvironment,
  packageGeneration,
  rollbackActivation,
  stageDesktopFiles,
} from "./activation";
import { assertIdle } from "./busy";
import { command } from "./command";
import { KDE_WORKSPACE_UNIT, locations, UNIT } from "./locations";
import { assertOwned } from "./ownership";
import { artifact, packageOwnership } from "./packages";
import type { InstallationRecord, Preparation } from "./schemas";
import { installed, installerLock } from "./state";
import { status } from "./status";

async function assertExistingInstallation(
  action: "install" | "upgrade",
  waylandDisplay: string | undefined,
  environment: string,
  installationId: string,
): Promise<void> {
  if (action === "upgrade") await assertIdle(installationId);
  if (
    waylandDisplay !== undefined &&
    (await readFile(locations().environment, "utf8")) !== environment
  ) {
    throw new Error(
      "Installed artifact already exists with a different display; release work and uninstall before rebinding it",
    );
  }
  await verifyBrokerRuntime();
}

async function savedWaylandDisplay(
  old: InstallationRecord | undefined,
  waylandDisplay: string | undefined,
) {
  const savedDisplay =
    old && waylandDisplay === undefined
      ? (await readFile(locations().environment, "utf8")).match(
          /^WAYLAND_DISPLAY=([A-Za-z0-9_.-]+)\n$/u,
        )?.[1]
      : undefined;
  return savedDisplay;
}

function assertPendingGeneration(
  preparation: Preparation | undefined,
  old: InstallationRecord | undefined,
  packagePath: string,
): void {
  if (
    preparation &&
    old?.current.packagePath !== preparation.original.packagePath &&
    old?.current.packagePath !== packagePath
  )
    throw new Error("Pending upgrade does not match the installed generation");
}

async function prepareInstallation(
  action: "install" | "upgrade",
  packagePath: string,
  waylandDisplay: string | undefined,
  preparation: Preparation | undefined,
  installationId: string,
) {
  const manifest = await artifact(packagePath);
  const old = await installed();
  if (action === "upgrade" && !old)
    throw new Error("Helper is not installed; use install");
  await assertOwned(old);
  const savedDisplay = await savedWaylandDisplay(old, waylandDisplay);
  const environment = await desktopEnvironment(waylandDisplay ?? savedDisplay);
  assertPendingGeneration(preparation, old, packagePath);
  const oldOwnership = old ? await packageOwnership(old.current) : undefined;
  if (old && !oldOwnership?.owned && !preparation)
    throw new Error(
      "Current package is unavailable; an upgrade must be prepared before its package manager removes the payload",
    );
  if (old?.current.packagePath === packagePath && !preparation) {
    await assertExistingInstallation(
      action,
      waylandDisplay,
      environment.environment,
      installationId,
    );
    return;
  }
  return { manifest, old, environment, oldOwnership };
}

async function removeOldRoots(
  old: InstallationRecord | undefined,
  previous: InstallationRecord["current"] | undefined,
): Promise<void> {
  if (
    old?.previous?.manager === "nix" &&
    old.previous.root !== (previous?.manager === "nix" ? previous.root : undefined)
  ) {
    await rm(old.previous.root, { force: true });
  }
  if (old?.current.manager === "nix" && previous !== old.current)
    await rm(old.current.root, { force: true });
}

async function prepareDesktopDirectories(
  p: ReturnType<typeof locations>,
  manager: InstallationRecord["current"]["manager"],
): Promise<void> {
  await privateDirectory(p.data);
  if (manager === "nix") await privateDirectory(p.roots);
  await mkdir(dirname(p.unit), { recursive: true });
  await mkdir(dirname(p.descriptor), { recursive: true });
  await mkdir(p.workspaceExtension, { recursive: true });
}

export async function install(
  action: "install" | "upgrade",
  packagePath: string,
  waylandDisplay?: string,
  maintenanceToken?: string,
) {
  if (process.platform !== "linux")
    throw new Error("farstep installation requires Linux");
  const identity = await loadIdentity();
  let workspaceActivationError: string | undefined;
  await installerLock(maintenanceToken, async (preparation) => {
    const prepared = await prepareInstallation(
      action,
      packagePath,
      waylandDisplay,
      preparation,
      identity.installationId,
    );
    if (!prepared) return;
    const { manifest, old, environment, oldOwnership } = prepared;
    await assertIdle(identity.installationId);
    const p = locations();
    await prepareDesktopDirectories(p, manifest.manager);
    const generation = packageGeneration(manifest, packagePath, p.roots);
    const previous =
      oldOwnership?.owned && old?.current.packagePath !== packagePath
        ? old?.current
        : undefined;
    const staged = await stageDesktopFiles(packagePath, environment.environment, p);
    for (const file of staged.keys()) await mkdir(dirname(file), { recursive: true });
    const backups = await backupFiles(staged.keys());
    const wasActive =
      (await command(["systemctl", "--user", "is-active", UNIT], true)).code === 0;
    const wasEnabled =
      (await command(["systemctl", "--user", "is-enabled", UNIT], true)).code === 0;
    const kdeWasEnabled =
      (await command(["systemctl", "--user", "is-enabled", KDE_WORKSPACE_UNIT], true))
        .code === 0;
    const kdeWasActive =
      (await command(["systemctl", "--user", "is-active", KDE_WORKSPACE_UNIT], true))
        .code === 0;
    if (generation.manager === "nix")
      await command([
        "nix-store",
        "--add-root",
        generation.root,
        "--indirect",
        "--realise",
        packagePath,
      ]);
    try {
      workspaceActivationError = await activateDesktop({
        p,
        staged,
        generation,
        previous,
        preparation,
        wasActive,
        graphical: environment.graphical,
        installationId: identity.installationId,
      });
    } catch (error) {
      try {
        await rollbackActivation({
          p,
          backups,
          old,
          oldOwned: oldOwnership?.owned ?? false,
          preparation,
          wasActive,
          wasEnabled,
          kdeWasEnabled,
          kdeWasActive,
          generation,
          installationId: identity.installationId,
        });
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          "Activation and per-user rollback failed; package-manager state was not rolled back and recovery data was retained",
        );
      }
      throw error;
    }
    await removeOldRoots(old, previous);
  });
  await enableSystem();
  const result = await status();
  return workspaceActivationError
    ? {
        ...result,
        workspaceIsolation: {
          status: "prerequisite",
          reason: workspaceActivationError,
        },
      }
    : result;
}
