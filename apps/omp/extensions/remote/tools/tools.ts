import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Connections } from "../connections/state";
import type { DesktopOperations } from "../desktop";
import type { RemoteJobs } from "../jobs/jobs";
import { registerConnectionTool } from "./connection";
import { registerCoordinationTool } from "./coordination";
import { registerDesktopTools } from "./desktop";
import { registerFileTools } from "./files/files";
import { registerHelperTool } from "./helper";
import { registerJobTools } from "./jobs";
import { registerScratchTool } from "./scratch";
import { registerSudoTool } from "./sudo";
import { registerSystemTool } from "./system";

export function registerTools(
  api: ExtensionAPI,
  connections: Connections,
  jobs: RemoteJobs,
  desktop: DesktopOperations,
) {
  registerConnectionTool(api, connections, jobs);
  registerCoordinationTool(api, connections, jobs);
  registerJobTools(api, connections, jobs);
  registerFileTools(api, connections);
  registerScratchTool(api, connections);
  registerSudoTool(api, connections, jobs);
  registerSystemTool(api, connections);
  registerDesktopTools(api, connections, desktop);
  registerHelperTool(api, connections, jobs);
}
