import { readGuide } from "@ai/core/guide/guide";
import { readText } from "@ai/core/text/text";
import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { localRunContext } from "farstep/remote/guide/examples";
import { TOPICS } from "farstep/remote/guide/topics";
import { remoteDefinitions } from "farstep/remote/remote";
import { REMOTE_TOOLS } from "farstep/remote/tools/names";
import { compileTool, registerCompiledTool } from "#apps/omp/lib/schema/tool";
import type { Connections } from "../connections/state";
import { connectionState } from "../connections/state";
import { configuredHosts } from "../connections/target";
import type { ConnectionState } from "../connections/types";
import { discoverTailscaleHosts } from "../tailscale";

export function registerGuide(api: ExtensionAPI, { connections }: Connections) {
  api.on("before_agent_start", (event) => ({
    systemPrompt: [
      ...event.systemPrompt,
      readGuide(
        new URL(import.meta.resolve("farstep/remote/guide/instructions.md")),
        {},
        REMOTE_TOOLS,
      ),
    ],
  }));
  registerCompiledTool(
    api,
    compileTool({
      ...remoteDefinitions.guide,
      async execute(
        input,
        { signal, context: ctx },
      ): Promise<AgentToolResult<unknown>> {
        const { topic = "start" } = input;
        const enabled = new Set(api.getActiveTools());
        function route(tool: string): string {
          return enabled.has(tool)
            ? readText(new URL("./guide.md", import.meta.url), "access", {
                TOOL: String(tool),
              })
            : `${tool} requires an explicit tool grant; it is not enabled for this agent.`;
        }
        const savedConnections = [...connections.values()];
        const profiles = savedConnections.map((connection) => ({
          id: connection.id,
          host: connection.target.host,
          username: connection.target.username,
          os: connection.info.os,
          arch: connection.arch,
          cwd: connection.cwd,
          shells: {
            bash: connection.bash,
            ...(connection.zsh ? { zsh: connection.zsh } : {}),
          },
          timeoutAvailable: Boolean(connection.timeout),
          ...(connection.helper ? { helper: connection.helper } : {}),
          ...(connection.fileRoot ? { files: connection.fileRoot } : {}),
        }));
        const guidance = [
          ...TOPICS[topic].tools.map(route),
          TOPICS[topic].text,
          ...(topic === "start"
            ? [`Local run context: ${localRunContext(ctx.cwd)}. Add your command.`]
            : []),
        ].join("\n");
        let hosts: unknown;
        const tailscale =
          topic === "connect" ? await discoverTailscaleHosts(signal) : undefined;
        let masters: (ConnectionState & { id: string })[] | undefined;
        if (topic === "connect") {
          const configured = await configuredHosts(ctx.cwd);
          masters = [];
          for (const connection of savedConnections) {
            masters.push({
              id: connection.id,
              ...(await connectionState(connection, signal)),
            });
          }
          hosts = {
            hosts: configured.hosts.map((host) => ({
              name: host.name,
              host: host.host,
              username: host.username,
              port: host.port,
              description: host.description,
            })),
            warnings: configured.warnings,
          };
        }
        return {
          content: [
            { type: "text", text: guidance },
            ...(
              [
                ["Saved connections", profiles.length ? profiles : undefined],
                ["Configured hosts", hosts],
                ["Tailscale discovery", tailscale],
                ["SSH masters", masters],
              ] as const
            ).flatMap(([label, value]) =>
              value
                ? [
                    {
                      type: "text" as const,
                      text: `${label}:\n${JSON.stringify(value, null, 2)}`,
                    },
                  ]
                : [],
            ),
          ],
          details: {
            topic,
            connections: profiles,
            ...(hosts ? { hosts } : {}),
            ...(tailscale ? { tailscale } : {}),
            ...(masters ? { masters } : {}),
          },
        };
      },
    }),
  );
}
