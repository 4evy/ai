import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { DesktopResult } from "farstep/client/desktop/desktop";
import { remoteDefinitions } from "farstep/remote/remote";
import { compileTool, registerCompiledTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../connections/state";
import type { DesktopOperations } from "../desktop";
import { farstepPresentation } from "./presentation";

export function registerDesktopTools(
  api: ExtensionAPI,
  { selected }: Connections,
  { desktop, screenshot, input: submitInput }: DesktopOperations,
) {
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.desktop,
      async execute(args, { signal, context: ctx }): Promise<DesktopResult> {
        return desktop(selected(args.connection), args, ctx, signal);
      },
    }),
    farstepPresentation("Desktop"),
  );
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.screenshot,
      async execute(args, { signal, context: ctx }): Promise<DesktopResult> {
        return screenshot(selected(args.connection), args, ctx, signal);
      },
    }),
    farstepPresentation("Screenshot"),
  );
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.input,
      async execute(input, { signal, context: ctx }): Promise<DesktopResult> {
        const { connection, ...args } = input;
        return submitInput(selected(connection), args, ctx, signal);
      },
    }),
    farstepPresentation("Desktop input"),
  );
}
