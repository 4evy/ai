import { browserLaunchAdapter } from "@oh-my-pi/pi-coding-agent/tools/browser/launch-policy";
import type { Browser, LaunchOptions, PuppeteerNode } from "puppeteer-core";

export type BrowserLauncher = PuppeteerNode;
export type BrowserLaunchOptions = LaunchOptions;

export interface BrowserLaunchSpec {
  executablePath: string;
  args: string[];
}

/** Optional deployment policy, loaded before native browser and auth callers */
export interface BrowserLaunchAdapter {
  launch?(puppeteer: BrowserLauncher, options: BrowserLaunchOptions): Promise<Browser>;
  adapt?(
    spec: BrowserLaunchSpec,
    headless: boolean,
    rejectProfileReuse: boolean,
  ): Promise<BrowserLaunchSpec>;
  assertCanReuseApp?(): void;
  sharedDaemonName?(headless: boolean): string | undefined;
}

export function launchBrowser(
  puppeteer: BrowserLauncher,
  options: BrowserLaunchOptions,
): Promise<Browser> {
  return (
    browserLaunchAdapter?.launch?.(puppeteer, options) ?? puppeteer.launch(options)
  );
}

export async function adaptBrowserLaunch(
  executablePath: string,
  args: string[],
  headless: boolean,
  rejectProfileReuse = false,
): Promise<BrowserLaunchSpec> {
  const spec = { executablePath, args };
  return browserLaunchAdapter?.adapt?.(spec, headless, rejectProfileReuse) ?? spec;
}

export function assertBrowserAppReuseAllowed(): void {
  browserLaunchAdapter?.assertCanReuseApp?.();
}

export function browserDaemonName(headless: boolean): string {
  return (
    browserLaunchAdapter?.sharedDaemonName?.(headless) ??
    (headless ? "omp.browser.headless" : "omp.browser.headed")
  );
}
