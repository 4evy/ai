import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { toolResult } from "@oh-my-pi/pi-coding-agent/tools/tool-result";
import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import {
  OutputSink,
  streamTailUpdates,
  TailBuffer,
} from "@oh-my-pi/pi-tui/tools/streaming-output";
import type { SudoInput } from "farstep/remote/sudo/script";
import { executeSudo, validateSudoInput } from "farstep/remote/sudo/sudo";
import type { Connection } from "../connections/types";
import type { JobSession } from "../jobs/session";

export async function runSudo(
  session: JobSession,
  connection: Connection,
  input: SudoInput,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback,
): Promise<AgentToolResult<BashToolDetails>> {
  const invalid = validateSudoInput(input, signal);
  if (invalid)
    return toolResult<BashToolDetails>({ timeoutSeconds: input.timeout ?? 60 })
      .text(invalid)
      .error()
      .done();
  const scope = session.current(ctx);
  const client = await session.client(scope, connection);
  const artifact = await ctx.sessionManager.allocateArtifactPath("remote_sudo");
  const sink = new OutputSink({
    ...(artifact.path === undefined ? {} : { artifactPath: artifact.path }),
    ...(artifact.id === undefined ? {} : { artifactId: artifact.id }),
    onChunk: streamTailUpdates(new TailBuffer(32_768), onUpdate),
    chunkThrottleMs: 100,
  });
  try {
    const { details, status, failed } = await executeSudo(
      connection,
      input,
      {
        owner: scope.owner,
        client,
        assertCurrent: () => session.assertCurrent(scope),
        reconnect: (installationId) =>
          session.client(scope, connection, installationId),
        requestPassword: ctx.hasUI
          ? (signal) =>
              ctx.ui.input(
                `Sudo password (${connection.id}; Esc cancels): `,
                undefined,
                {
                  signal,
                },
              )
          : undefined,
        output: (text) => sink.push(text),
      },
      signal,
    );
    const summary = await sink.dump();
    return toolResult<BashToolDetails>(details)
      .text(`${summary.output || "(no output)"}\n\n${status}`)
      .truncationFromSummary(summary, { direction: "tail" })
      .error(failed)
      .done();
  } finally {
    await sink.dispose();
  }
}
