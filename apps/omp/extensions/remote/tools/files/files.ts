import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Connections } from "../../connections/state";
import { registerDeleteTool } from "./delete";
import { registerEditTool } from "./edit";
import { registerReadTool } from "./read";
import { registerWriteTool } from "./write";

export function registerFileTools(api: ExtensionAPI, connections: Connections) {
  registerReadTool(api, connections);
  registerWriteTool(api, connections);
  registerEditTool(api, connections);
  registerDeleteTool(api, connections);
}
