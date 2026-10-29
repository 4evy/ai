import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, readlink, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "@ai/runtime/effect/effect";
import { executeCommand } from "@ai/runtime/effect/process/process";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { replaceLink } from "#farstep/runtime/installer/shared";
import { atomicWrite, paths, privateDirectory } from "#farstep/runtime/state";
import { buildAgent, label, ownsAgent } from "./agent";

const agent = () => join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const app = () => join(homedir(), "Applications/Farstep.app");

export async function desktopEndpoint() {
  const socket = join(paths().runtime, "desktop.sock");
  await privateDirectory(paths().runtime);
  return socket;
}
async function launchctl(args: string[], allowNonZero = false) {
  const result = await run(executeCommand(["/bin/launchctl", ...args]));
  if (!allowNonZero && result.code !== 0) throw new Error(result.stderr);
}
export async function stopDesktop() {
  await launchctl(["bootout", `gui/${process.getuid?.()}/${label}`], true);
}
async function assertDesktopOwned(packagePaths: string[]) {
  for (const target of [app(), agent()]) {
    try {
      const info = await lstat(target);
      if (info.uid !== process.getuid?.())
        throw new Error(`Unrelated owner: ${target}`);
      if (target === app()) await assertAppOwned(target, info, packagePaths);
      else await assertAgentOwned(target, info, packagePaths);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}
async function assertAppOwned(
  target: string,
  info: Stats,
  packagePaths: string[],
): Promise<void> {
  const existing = info.isSymbolicLink() ? await readlink(target) : null;
  if (!packagePaths.some((path) => join(path, "share/Farstep.app") === existing))
    throw new Error("Refusing unrelated Applications/Farstep.app");
}

async function assertAgentOwned(
  target: string,
  info: Stats,
  packagePaths: string[],
): Promise<void> {
  const text = info.isFile() ? await readFile(target, "utf8") : "";
  if (
    !ownsAgent(
      text,
      packagePaths.map((path) =>
        join(path, "share/Farstep.app/Contents/MacOS/Farstep"),
      ),
    )
  )
    throw new Error("Refusing an unrelated Farstep launch agent");
}

export async function activateDesktop(
  packagePath: string,
  previousPackagePath = packagePath,
) {
  const executable = join(packagePath, "share/Farstep.app/Contents/MacOS/Farstep");
  if (!(await lstat(executable)).isFile()) throw new Error("Package lacks Farstep.app");
  await privateDirectory(paths().runtime);
  await mkdir(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  await mkdir(join(homedir(), "Applications"), { recursive: true });
  await assertDesktopOwned([packagePath, previousPackagePath]);
  await stopDesktop();
  await replaceLink(app(), join(packagePath, "share/Farstep.app"));
  await atomicWrite(
    agent(),
    buildAgent(executable, join(paths().state, "desktop.log"), process.env),
  );
  await launchctl(["bootstrap", `gui/${process.getuid?.()}`, agent()]);
}
export async function removeDesktop(packagePath: string) {
  await assertDesktopOwned([packagePath]);
  await stopDesktop();
  await rm(agent(), { force: true });
  await rm(app(), { force: true });
}
export async function requestPermissions(packagePath: string) {
  const result = await run(
    executeCommand([
      "/usr/bin/open",
      "-n",
      "-a",
      join(packagePath, "share/Farstep.app"),
      "--args",
      "permissions",
    ]),
  );
  if (result.code !== 0) throw new Error(result.stderr);
}
