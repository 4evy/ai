import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { exists, loadIdentity } from "#farstep/runtime/state";
import { disableSystem } from "#farstep/runtime/system/system";
import { assertIdle } from "./busy";
import { command } from "./command";
import { locations, UNIT } from "./locations";
import { assertOwned } from "./ownership";
import type { InstallationRecord } from "./schemas";

import { installed, installerLock } from "./state";
import {
  GNOME_SHELL_VERSION,
  kdeExtensionEnabled,
  workspaceExtensionEnabled,
} from "./workspace/workspace";

async function assertTokenDirectory(tokens: string): Promise<void> {
  if (await exists(tokens)) {
    const info = await lstat(tokens);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error("Refusing unsafe restore-token directory");
    }
  }
}

async function disableWorkspaceExtensions(
  record: InstallationRecord,
  p: ReturnType<typeof locations>,
): Promise<void> {
  if (record.files.some((file) => file.path.startsWith(`${p.workspaceExtension}/`))) {
    const shell = await command(GNOME_SHELL_VERSION, true);
    try {
      await workspaceExtensionEnabled(false);
    } catch (error) {
      if (shell.code === 0) throw error;
    }
  }
  if (record.files.some((file) => file.path === p.kdeUnit))
    await kdeExtensionEnabled(false);
}

export async function uninstall(maintenanceToken?: string) {
  return installerLock(maintenanceToken, async () => {
    const record = await installed();
    if (!record) return { installed: false, status: "not-installed" };
    await assertOwned(record);
    const identity = await loadIdentity();
    await assertIdle(identity.installationId);
    const p = locations();
    const tokens = join(p.state, "tokens");
    await assertTokenDirectory(tokens);
    await disableSystem();
    await command(["systemctl", "--user", "disable", "--now", UNIT]);
    await disableWorkspaceExtensions(record, p);
    await rm(tokens, { recursive: true, force: true });
    for (const file of record.files) await rm(file.path);
    for (const path of [
      p.current,
      p.previous,
      record.current.manager === "nix" ? record.current.root : undefined,
      record.previous?.manager === "nix" ? record.previous.root : undefined,
      p.record,
    ]) {
      if (path) await rm(path, { force: true });
    }
    await command(["systemctl", "--user", "daemon-reload"]);
    return { installed: false, status: "uninstalled", historyRetained: true };
  });
}
