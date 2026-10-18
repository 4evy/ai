import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { attempt, run as runEffect } from "@ai/core/effect/effect";
import { isEacces, isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { Effect, Schedule } from "effect";
import { systemStatus } from "./client";
import { systemLocations } from "./locations";
import { run } from "./process";

async function authenticate() {
  let password: string | undefined;
  try {
    password = (await readFile("/etc/bleh", "utf8")).replace(/[\r\n]+$/u, "");
  } catch (error) {
    if (!isEnoent(error) && !isEacces(error)) throw error;
  }
  const cached = await run(["/usr/bin/sudo", "-n", "-v"]);
  if (cached.exitCode === 0) return;
  if (password !== undefined && !/[\r\n\0]/u.test(password)) {
    const authenticated = await run(
      ["/usr/bin/sudo", "-S", "-p", "", "-v"],
      `${password}\n`,
    );
    password = undefined;
    if (authenticated.exitCode === 0) return;
  }
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const prompt = Bun.spawn(["/usr/bin/sudo", "-v"], {
      stdin: "inherit",
      stdout: "ignore",
      stderr: "inherit",
    });
    if ((await prompt.exited) === 0) return;
  }
  throw new Error(
    "Sudo authentication is required to change Farstep system access; the available credential did not authenticate",
  );
}

async function manage(action: "install" | "uninstall") {
  const p = await systemLocations();
  const packagePath = process.env.FARSTEP_PACKAGE_PATH;
  if (!packagePath)
    throw new Error(
      "Invoke the installed package's bin/farstep to manage the system service",
    );
  const binary = join(
    packagePath,
    "bin",
    process.platform === "win32" ? "farstep-service.exe" : "farstep-service",
  );
  if (process.platform !== "win32") await authenticate();
  const result = await run(
    process.platform === "win32"
      ? [binary, action, p.owner]
      : ["/usr/bin/sudo", "-n", "--", binary, action, p.owner],
  );
  if (result.exitCode !== 0)
    throw new Error(`System service ${action} failed: ${result.stderr}`);
  if (action === "install") {
    const pending = new Error(
      "Installed system service failed its root identity check",
    );
    const status = await runEffect(
      attempt(() => systemStatus()).pipe(
        Effect.flatMap((status) =>
          status.root ? Effect.succeed(status) : Effect.fail(pending),
        ),
        Effect.retry({
          times: 29,
          schedule: Schedule.spaced(100),
          while: (error) => error === pending,
        }),
      ),
    );
    return status;
  }
  return systemStatus();
}

export const enableSystem = () => manage("install");
export const disableSystem = () => manage("uninstall");
