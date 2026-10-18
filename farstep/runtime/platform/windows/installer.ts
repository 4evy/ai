import { join } from "node:path";
import { errorMessage } from "@ai/core/error/error";
import * as v from "valibot";
import { desktopHealth } from "../../desktop";
import { exists, loadIdentity, paths, privateRead } from "../../state";
import { installPackage } from "./package/package";
import { powershell, quote } from "./state/state";

const installationSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.looseObject({
    version: v.literal(1),
    packagePath: v.string(),
    manager: v.string(),
    packageVersion: v.string(),
  }),
);

export async function status() {
  const identity = await loadIdentity();
  const record = join(paths().state, "installer.json");
  if (!(await exists(record)))
    return {
      installed: false,
      platform: "win32",
      status: "not-installed",
      ...identity,
    };
  const installed = v.parse(installationSchema, await privateRead(record));
  try {
    return {
      ...installed,
      ...identity,
      installed: true,
      platform: "win32",
      status: "ready",
      desktop: await desktopHealth(identity.installationId),
    };
  } catch (error) {
    return {
      ...installed,
      ...identity,
      installed: true,
      platform: "win32",
      status: "desktop-unavailable",
      desktopError: errorMessage(error),
    };
  }
}
async function setup(packagePath: string, action: string) {
  return powershell(
    `& ${quote(join(packagePath, "share/farstep/install.ps1"))} -PackagePath ${quote(packagePath)} -Action ${quote(action)}`,
  );
}
export async function install(
  action: "install" | "upgrade",
  packagePath: string,
  display?: string,
  token?: string,
) {
  if (display || token)
    throw new Error(
      "Wayland displays and maintenance tokens do not apply to Windows installation",
    );
  const recordPath = join(paths().state, "installer.json");
  const installed = await exists(recordPath);
  if (installed !== (action === "upgrade"))
    throw new Error(
      installed
        ? "Farstep is already installed, use upgrade"
        : "Farstep is not installed, use install",
    );
  const metadata = await installPackage(packagePath);
  const record = v.parse(installationSchema, await privateRead(recordPath));
  if (record.manager !== "winget" || record.packageVersion !== metadata.version)
    throw new Error("WinGet finished without activating the selected Farstep package");
  return status();
}
export async function uninstall(token?: string) {
  if (token) throw new Error("Windows uninstallation does not use maintenance tokens");
  const record = v.parse(
    installationSchema,
    await privateRead(join(paths().state, "installer.json")),
  );
  if (record.manager === "winget")
    throw new Error(
      "Use bin/farstep.cmd uninstall or winget uninstall --name Farstep --exact to release the packaged runtime before removal",
    );
  await setup(record.packagePath, "uninstall");
  return status();
}
export async function prepareUpgrade(): Promise<never> {
  throw new Error("Windows upgrades run through the elevated installer");
}
export async function cancelUpgrade(_: string): Promise<never> {
  throw new Error("Windows upgrades run through the elevated installer");
}
