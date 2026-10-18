import { desktopEndpoint } from "./desktop/desktop";

export interface Management {
  status(): Promise<unknown>;
  prepareUpgrade(): Promise<unknown>;
  cancelUpgrade(token: string): Promise<unknown>;
  install(
    action: "install" | "upgrade",
    packagePath: string,
    display?: string,
    token?: string,
  ): Promise<unknown>;
  uninstall(token?: string): Promise<unknown>;
}

export interface Platform {
  management: Management;
  desktopEndpoint?: () => Promise<string>;
}

// Add native adapters here; shared command routing does not select OS APIs
const adapters: Partial<Record<NodeJS.Platform, () => Promise<Management>>> = {
  linux: () => import("./linux/installer/installer"),
  darwin: () => import("./macos/installer"),
  win32: () => import("./windows/installer"),
};

export async function platform(): Promise<Platform> {
  const load = adapters[process.platform];
  if (!load)
    throw new Error(`Farstep has no native gateway adapter for ${process.platform}`);
  return { management: await load(), desktopEndpoint };
}
