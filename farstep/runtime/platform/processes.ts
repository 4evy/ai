import { createLinuxSubreaperScript } from "@oh-my-pi/pi-utils/ptree";

export { brokerRoot, signalGroup } from "./posix/processes";

// Linux must reap adopted descendants; Darwin uses the native process group
export const subreaperScript =
  process.platform === "linux" ? createLinuxSubreaperScript() : undefined;
