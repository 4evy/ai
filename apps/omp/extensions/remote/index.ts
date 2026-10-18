import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createConnections } from "./connections/state";
import { createDesktop } from "./desktop";
import { registerGuide } from "./guide/guide";
import { RemoteJobs } from "./jobs/jobs";
import { registerJobPresentation } from "./jobs/presentation";
import { registerTools } from "./tools/tools";

export default function remote(api: ExtensionAPI) {
  const connections = createConnections(api);
  const jobs = new RemoteJobs(api, connections);
  const desktop = createDesktop();
  registerJobPresentation(api);
  const restore = async (_event: unknown, ctx: ExtensionContext) => {
    connections.restore(ctx);
    jobs.restore(ctx);
    await desktop.close();
  };
  api.on("session_start", restore);
  api.on("session_switch", restore);
  api.on("session_branch", restore);
  api.on("session_tree", restore);
  api.on("session_shutdown", async () => {
    await jobs.close();
    await desktop.close();
  });
  registerGuide(api, connections);
  registerTools(api, connections, jobs, desktop);
}
