import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { loadPuppeteer } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";

type Puppeteer = Awaited<ReturnType<typeof loadPuppeteer>>;
type LaunchOptions = NonNullable<Parameters<Puppeteer["launch"]>[0]>;

/** Keep upstream launch options intact and adapt only headed Linux launches */
export async function launchWorkspaceBrowser(
  puppeteer: Puppeteer,
  options: LaunchOptions,
) {
  if (process.platform !== "linux" || options.headless !== false)
    return puppeteer.launch(options);
  const ignored = options.ignoreDefaultArgs;
  const args =
    ignored === true
      ? (options.args ?? [])
      : (await puppeteer.defaultArgs(options)).filter(
          (arg) => !Array.isArray(ignored) || !ignored.includes(arg),
        );
  const launch = await isolateBrowserLaunch(
    options.executablePath ?? (await puppeteer.executablePath()),
    args,
    false,
  );
  // The workspace helper does not forward Puppeteer's extra pipe descriptors
  return puppeteer.launch({
    ...options,
    ...launch,
    pipe: false,
    ignoreDefaultArgs: true,
  });
}

export interface WorkspaceBrowserLaunch {
  executablePath: string;
  args: string[];
}

export async function isolateBrowserLaunch(
  executablePath: string,
  args: string[],
  headless: boolean,
  rejectProfileReuse = false,
): Promise<WorkspaceBrowserLaunch> {
  if (process.platform !== "linux" || headless) return { executablePath, args };
  const helper = path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local/share"),
    "farstep/current/bin/farstep-desktop",
  );
  try {
    await fs.access(helper, fs.constants.X_OK);
  } catch {
    throw new ToolError(
      "Headed Linux browsers require an installed farstep with GNOME workspace isolation",
    );
  }
  if (
    args.some(
      (arg) =>
        arg.startsWith("--ozone-platform=") && arg !== "--ozone-platform=wayland",
    )
  ) {
    throw new ToolError("Isolated Linux browsers require native Wayland, not X11");
  }
  const profile = args
    .find((arg) => arg.startsWith("--user-data-dir="))
    ?.slice("--user-data-dir=".length);
  if (!profile || !path.isAbsolute(profile)) {
    throw new ToolError(
      "An isolated Linux browser requires a dedicated absolute --user-data-dir",
    );
  }
  if (rejectProfileReuse) await assertProfileUnused(profile);
  return {
    executablePath: helper,
    args: [
      "workspace",
      "run",
      "--",
      executablePath,
      ...args,
      "--ozone-platform=wayland",
    ],
  };
}

async function assertProfileUnused(profile: string): Promise<void> {
  try {
    await fs.lstat(path.join(profile, "SingletonLock"));
    throw new ToolError(
      "The requested browser profile is already in use; refusing to reuse a window outside the isolated workspace",
    );
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}
