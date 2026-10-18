import { readText } from "@ai/core/text/text";
import { compileSchemaTool, type ToolContext } from "@ai/core/tool/tool";
import { guideText, INSTRUCTIONS } from "./guides/guides";
import { SKYLIGHT_TOOLS } from "./names";
import {
  MAX_SYNC_BYTES,
  PROVISION_TIMEOUT_MS,
  type SkylightRuntime,
} from "./runtime/runtime";
import { createSkylightParameters } from "./schemas";

function targetOptions(
  target: string | undefined,
  cwd: string | undefined,
  defaultCwd: string,
): { target?: string; cwd?: string } {
  const options: { target?: string; cwd?: string } = {};
  if (target) options.target = target;
  if (cwd) options.cwd = cwd;
  else if (!target || target === "local") options.cwd = defaultCwd;
  return options;
}

export function createSkylight<C extends ToolContext = ToolContext>(
  runtime: SkylightRuntime,
) {
  const { guideParameters, parameters, syncParameters } = createSkylightParameters();

  const close = () => runtime.close();
  // Call previews can still be partial; completed inputs use native validation
  const guide = compileSchemaTool({
    name: SKYLIGHT_TOOLS.guide,
    parameters: guideParameters,
    label: "Skylight guide",
    description:
      'Read Skylight setup and usage guidance without starting the runtime. Begin with "start"; load other topics as needed.',
    loadMode: "essential",
    approval: "read",
    async execute(
      { topic, target, cwd },
      { signal, context: ctx }: import("@ai/core/tool/tool").Invocation<C>,
    ) {
      const selected = targetOptions(target, cwd, ctx.cwd);
      const identity = await runtime.withChannel(
        selected,
        async (channel) => channel.identity,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: await guideText(
              topic,
              identity.platform,
              signal,
              () =>
                runtime.withChannel(
                  selected,
                  async (channel) => {
                    // Reference lookup may provision a fresh target's pinned runtime
                    const result = await channel.call(
                      "sky.reference",
                      {},
                      signal,
                      PROVISION_TIMEOUT_MS,
                    );
                    if (result.isError)
                      throw new Error(
                        result.content
                          .flatMap((item) => (item.type === "text" ? [item.text] : []))
                          .join("\n"),
                      );
                    return result.content
                      .flatMap((item) => (item.type === "text" ? [item.text] : []))
                      .join("\n");
                  },
                  signal,
                ),
              identity.skyBackend,
            ),
          },
        ],
        details: { serverName: "skylight", mcpToolName: "guide", topic },
      };
    },
  });
  const javascript = compileSchemaTool({
    name: SKYLIGHT_TOOLS.skylight,
    parameters,
    label: "Skylight",
    description: INSTRUCTIONS,
    loadMode: "essential",
    approval: "exec",
    strict: false,
    mcpServerName: "skylight",
    mcpToolName: "js",
    async execute(
      args,
      { signal, context: ctx }: import("@ai/core/tool/tool").Invocation<C>,
    ) {
      return runtime.execute(
        targetOptions(args.target, args.cwd, ctx.cwd),
        args.code,
        args.reset,
        {
          ...(args.title ? { title: args.title } : {}),
          ...(args.timeout_ms ? { timeout_ms: args.timeout_ms } : {}),
        },
        signal,
      );
    },
  });

  const synchronize = compileSchemaTool({
    name: SKYLIGHT_TOOLS.sync,
    parameters: syncParameters,
    description: readText(new URL("./skylight.md", import.meta.url), "sync", {
      LIMIT_MIB: String(MAX_SYNC_BYTES / 1024 / 1024),
    }),
    label: "Synchronize Sky file",
    loadMode: "essential",
    approval: "exec",
    async execute(
      args,
      { signal, context: ctx }: import("@ai/core/tool/tool").Invocation<C>,
    ) {
      const selected = (endpoint: typeof args.from) => ({
        ...endpoint,
        ...targetOptions(endpoint.target, endpoint.cwd, ctx.cwd),
      });
      return runtime.sync(
        selected(args.from),
        selected(args.to),
        args.expectedSha256,
        signal,
      );
    },
  });

  return { tools: [guide, javascript, synchronize], close };
}
