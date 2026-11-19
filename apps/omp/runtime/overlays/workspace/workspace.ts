import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  BrowserLaunchAdapter,
  BrowserLauncher,
  BrowserLaunchOptions,
  BrowserLaunchSpec,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch-adapter";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";

/** Keep upstream launch options intact and adapt only headed Linux launches */
async function launchWorkspaceBrowser(
  puppeteer: BrowserLauncher,
  options: BrowserLaunchOptions,
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
  // workspace run owns the scope and releases it on parent exit or closed stdin
  // TCP avoids unsupported pipe descriptors without detaching lease ownership
  return puppeteer.launch({
    ...options,
    ...launch,
    pipe: false,
    ignoreDefaultArgs: true,
  });
}

export const browserLaunchAdapter: BrowserLaunchAdapter | undefined = {
  launch: launchWorkspaceBrowser,
  adapt: (spec, headless, rejectProfileReuse) =>
    isolateBrowserLaunch(spec.executablePath, spec.args, headless, rejectProfileReuse),
  assertCanReuseApp() {
    if (process.platform === "linux") {
      throw new ToolError(
        "An existing browser cannot be adopted into an isolated workspace; attach explicitly with app.cdp_url instead",
      );
    }
  },
  sharedDaemonName(headless) {
    if (!headless && process.platform === "linux") return "omp.browser.workspace";
    return undefined;
  },
};

async function isolateBrowserLaunch(
  executablePath: string,
  args: string[],
  headless: boolean,
  rejectProfileReuse = false,
): Promise<BrowserLaunchSpec> {
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
      ...args.filter(
        (arg) =>
          !/^--remote-debugging-pipe(?:=|$)/.test(arg) &&
          arg !== "--ozone-platform=wayland",
      ),
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
