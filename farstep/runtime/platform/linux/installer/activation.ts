import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "@ai/core/effect/effect";
import { errorMessage } from "@ai/core/error/error";
import { render } from "@ai/core/template/template";
import { Effect, Schedule } from "effect";
import * as v from "valibot";
import { desktopHealthEffect } from "#farstep/runtime/desktop";
import { replaceLink } from "#farstep/runtime/installer/shared";
import { verifyBrokerRuntime } from "#farstep/runtime/jobs/jobs";
import { atomicWrite, exists, paths } from "#farstep/runtime/state";
import { command } from "./command";
import {
  KDE_WORKSPACE_FILES,
  KDE_WORKSPACE_UNIT,
  type Locations,
  NATIVE_WORKSPACE_FILES,
  UNIT,
  WORKSPACE_EXTENSION_FILES,
} from "./locations";
import type { artifact } from "./packages";
import type { Generation, InstallationRecord, Preparation } from "./schemas";
import {
  GNOME_SHELL_VERSION,
  kdeExtensionEnabled,
  kdeSession,
  workspaceExtensionEnabled,
} from "./workspace/workspace";

async function assertDisplay(
  display: string | undefined,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  if (
    !display ||
    !/^[A-Za-z0-9_.-]+$/u.test(display) ||
    display === "." ||
    display === ".."
  ) {
    throw new Error(
      "Desktop prerequisite: a valid user-manager WAYLAND_DISPLAY or explicit waylandDisplay is required",
    );
  }
  const runtime = dirname(paths().runtime);
  const socket = await lstat(join(runtime, display));
  if (!socket.isSocket() || socket.uid !== process.getuid?.())
    throw new Error("Selected Wayland display is not an owned socket");
  if (values.XDG_RUNTIME_DIR !== runtime || !(await exists(join(runtime, "bus")))) {
    throw new Error(
      "Desktop prerequisite: user-manager runtime directory and graphical D-Bus integration are missing",
    );
  }
}

export async function desktopEnvironment(waylandDisplay?: string) {
  const graphical =
    (
      await command(
        ["systemctl", "--user", "is-active", "graphical-session.target"],
        true,
      )
    ).code === 0;
  const manager = (await command(["systemctl", "--user", "show-environment"])).stdout;
  const values = v.parse(v.record(v.string(), v.string()), JSON.parse(manager));
  const display = waylandDisplay ?? values.WAYLAND_DISPLAY;
  if (graphical || waylandDisplay !== undefined) await assertDisplay(display, values);
  return {
    graphical,
    environment:
      waylandDisplay === undefined ? "" : `WAYLAND_DISPLAY=${waylandDisplay}\n`,
  };
}

export async function healthyDesktop(
  installationId: string,
  version: string,
): Promise<void> {
  try {
    await run(
      desktopHealthEffect(installationId, version).pipe(
        Effect.retry({ times: 29, schedule: Schedule.spaced(100) }),
      ),
    );
  } catch (error) {
    throw new Error(
      "Activated desktop service failed its protocol/identity health check",
      { cause: error },
    );
  }
}

export async function stageDesktopFiles(
  packagePath: string,
  environment: string,
  p: Locations,
): Promise<Map<string, string>> {
  const staged = new Map<string, string>();
  const templates = [
    { source: "farstep-desktop.service.in", destination: p.unit },
    { source: "org.farstep.Farstep.desktop.in", destination: p.descriptor },
  ];
  const replacements = {
    PACKAGE: packagePath,
    ENVIRONMENT_FILE: p.environment.replaceAll("%", "%%"),
  };
  for (const { source, destination } of templates) {
    const content = await readFile(join(packagePath, "share/farstep", source), "utf8");
    staged.set(destination, render(content, replacements));
  }
  staged.set(p.environment, environment);
  for (const name of WORKSPACE_EXTENSION_FILES) {
    const source = await readFile(
      join(packagePath, "share/farstep/gnome", name),
      "utf8",
    );
    staged.set(
      join(p.workspaceExtension, name),
      name === "extension.js"
        ? source.replace(
            "@SOURCE_HASH@",
            createHash("sha256").update(source).digest("hex"),
          )
        : source,
    );
  }
  const kde = join(packagePath, "share/farstep/kde");
  const main = await readFile(join(kde, "contents/code/main.js"), "utf8");
  const hash = createHash("sha256")
    .update(main)
    .update(await readFile(join(kde, "broker.js")))
    .update(await readFile(join(kde, "contents/ui/bridge/libfarstepbridge.so")))
    .digest("hex");
  for (const name of KDE_WORKSPACE_FILES) {
    let content = await readFile(join(kde, name), "utf8");
    content = content
      .replaceAll("@SOURCE_HASH@", hash)
      .replaceAll("@BRIDGE@", pathToFileURL(join(kde, "contents/ui/bridge")).href);
    staged.set(join(p.kdeExtension, name), content);
  }
  const brokerUnit = render(
    await readFile(join(kde, "farstep-workspaces.service.in"), "utf8"),
    { GJS: "gjs", BROKER: join(p.kdeExtension, "broker.js") },
  );
  staged.set(p.kdeUnit, brokerUnit);
  for (const name of NATIVE_WORKSPACE_FILES)
    staged.set(
      join(p.nativeRules, name),
      (
        await readFile(join(packagePath, "share/farstep/native", name), "utf8")
      ).replaceAll("@PACKAGE@", packagePath),
    );
  return staged;
}

export async function backupFiles(
  files: Iterable<string>,
): Promise<Map<string, string | undefined>> {
  return new Map(
    await Array.fromAsync(
      files,
      async (file) =>
        [
          file,
          (await exists(file)) ? await readFile(file, "utf8") : undefined,
        ] as const,
    ),
  );
}

async function restoreFiles(
  backups: ReadonlyMap<string, string | undefined>,
): Promise<void> {
  for (const [file, content] of backups) {
    if (content === undefined) await rm(file, { force: true });
    else await atomicWrite(file, content);
  }
}

async function generationLinks(
  p: Locations,
  current: Generation | undefined,
  previous: Generation | undefined,
): Promise<void> {
  for (const [path, generation] of [
    [p.current, current],
    [p.previous, previous],
  ] as const) {
    if (generation) await replaceLink(path, generation.packagePath);
    else await rm(path, { force: true });
  }
}

interface ActivationBackup {
  p: Locations;
  backups: ReadonlyMap<string, string | undefined>;
  old: InstallationRecord | undefined;
  oldOwned: boolean;
  preparation: Preparation | undefined;
  wasActive: boolean;
  wasEnabled: boolean;
  kdeWasEnabled: boolean;
  kdeWasActive: boolean;
  generation: Generation;
  installationId: string;
}

export async function rollbackActivation({
  p,
  backups,
  old,
  oldOwned,
  preparation,
  wasActive,
  wasEnabled,
  kdeWasEnabled,
  kdeWasActive,
  generation,
  installationId,
}: ActivationBackup): Promise<void> {
  const resumeOldServices = async () => {
    if (old && oldOwned && old.files.some((file) => file.path === p.kdeUnit)) {
      if (kdeWasEnabled)
        await command(["systemctl", "--user", "enable", KDE_WORKSPACE_UNIT]);
      if (kdeWasActive)
        await command(["systemctl", "--user", "start", KDE_WORKSPACE_UNIT]);
    }
    if (!preparation && old && oldOwned) {
      if (wasEnabled) await command(["systemctl", "--user", "enable", UNIT]);
      if (wasActive) {
        await command(["systemctl", "--user", "start", UNIT]);
        await healthyDesktop(installationId, old.current.version);
      }
    }
  };
  await command(["systemctl", "--user", "stop", UNIT], true);
  await command(["systemctl", "--user", "stop", KDE_WORKSPACE_UNIT], true);
  if (preparation || !wasEnabled)
    await command(["systemctl", "--user", "disable", UNIT], true);
  if (!kdeWasEnabled)
    await command(["systemctl", "--user", "disable", KDE_WORKSPACE_UNIT], true);
  await restoreFiles(backups);
  if (!old?.files.some((file) => file.path.startsWith(`${p.workspaceExtension}/`))) {
    await workspaceExtensionEnabled(false).catch(() => {});
  }
  if (!old?.files.some((file) => file.path === p.kdeUnit))
    await kdeExtensionEnabled(false).catch(() => {});
  await generationLinks(p, old?.current, old?.previous);
  await command(["systemctl", "--user", "daemon-reload"]);
  await resumeOldServices();
  if (generation.manager === "nix") await rm(generation.root, { force: true });
}

export function packageGeneration(
  manifest: Awaited<ReturnType<typeof artifact>>,
  packagePath: string,
  roots: string,
): Generation {
  return {
    manager: "nix",
    packagePath,
    version: manifest.version,
    root: join(roots, randomUUID()),
  };
}

interface DesktopActivation {
  p: Locations;
  staged: ReadonlyMap<string, string>;
  generation: Generation;
  previous: Generation | undefined;
  preparation: Preparation | undefined;
  wasActive: boolean;
  graphical: boolean;
  installationId: string;
}

export async function activateDesktop({
  p,
  staged,
  generation,
  previous,
  preparation,
  wasActive,
  graphical,
  installationId,
}: DesktopActivation): Promise<string | undefined> {
  let workspaceActivationError: string | undefined;
  const activateGnome = async () => {
    const shell = await command(GNOME_SHELL_VERSION, true);
    try {
      await workspaceExtensionEnabled(true);
    } catch (error) {
      if (shell.code === 0)
        workspaceActivationError = `Workspace adapter activation failed: ${errorMessage(error)}`;
    }
  };
  const activateKde = async () => {
    try {
      if (await kdeSession()) await kdeExtensionEnabled(true);
      else await command(["systemctl", "--user", "enable", KDE_WORKSPACE_UNIT]);
    } catch (error) {
      if (await kdeSession())
        workspaceActivationError = `KDE workspace adapter activation failed: ${errorMessage(error)}`;
      else throw error;
    }
  };
  if (wasActive) await command(["systemctl", "--user", "stop", UNIT]);
  await command(["systemctl", "--user", "stop", KDE_WORKSPACE_UNIT], true);
  for (const [file, content] of staged) await atomicWrite(file, content);
  await activateGnome();
  await generationLinks(p, generation, previous);
  await command(["systemctl", "--user", "daemon-reload"]);
  await command([
    "systemctl",
    "--user",
    preparation?.wasEnabled === false ? "disable" : "enable",
    UNIT,
  ]);
  await activateKde();
  await verifyBrokerRuntime();
  if (preparation ? preparation.wasActive : graphical) {
    await command(["systemctl", "--user", "start", UNIT]);
    await healthyDesktop(installationId, generation.version);
  }
  const record: InstallationRecord = {
    version: 2,
    current: generation,
    ...(previous ? { previous } : {}),
    files: [...staged].map(([path, content]) => ({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  };
  await atomicWrite(p.record, `${JSON.stringify(record)}\n`);
  return workspaceActivationError;
}
