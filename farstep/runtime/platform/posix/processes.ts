import { hasFsCode } from "@oh-my-pi/pi-utils/fs-error";

// Darwin's AF_UNIX limit includes the socket name, so keep the broker root short
export function brokerRoot(): string {
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error("Farstep jobs need a native broker transport for this platform");
  return `/tmp/farstep-jobs-${process.getuid?.()}`;
}

export function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (hasFsCode(error, "ESRCH")) return false;
    throw error;
  }
}
