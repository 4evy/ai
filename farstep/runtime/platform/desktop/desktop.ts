// Desktop connections must not load installers that call back into the relay
const adapters: Partial<
  Record<NodeJS.Platform, () => Promise<{ desktopEndpoint(): Promise<string> }>>
> = {
  linux: () => import("../linux/desktop"),
  darwin: () => import("../macos/desktop/desktop"),
  win32: () => import("../windows/desktop"),
};

export async function desktopEndpoint(): Promise<string> {
  const load = adapters[process.platform];
  if (!load)
    throw new Error(`Farstep has no native desktop adapter for ${process.platform}`);
  return (await load()).desktopEndpoint();
}
