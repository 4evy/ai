import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { remoteDefinitions } from "farstep/remote/remote";
import { registerSchemaTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../connections/state";
import type { DesktopOperations } from "../desktop";

export function registerDesktopTools(
  api: ExtensionAPI,
  { selected }: Connections,
  { desktop, screenshot, input: submitInput }: DesktopOperations,
) {
  registerSchemaTool(api, {
    ...remoteDefinitions.desktop,
    async execute(_id, args, signal, _update, ctx) {
      return desktop(selected(args.connection), args, ctx, signal);
    },
  });
  registerSchemaTool(api, {
    ...remoteDefinitions.screenshot,
    async execute(_id, args, signal, _update, ctx) {
      return screenshot(selected(args.connection), args, ctx, signal);
    },
  });
  registerSchemaTool(api, {
    ...remoteDefinitions.input,
    async execute(_id, input, signal, _update, ctx) {
      const { connection, ...args } = input;
      return submitInput(selected(connection), args, ctx, signal);
    },
  });
}
