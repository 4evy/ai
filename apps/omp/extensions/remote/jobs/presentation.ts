import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { plainToolCard } from "@oh-my-pi/pi-tui/render";
import { createShellRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { isRecord } from "@oh-my-pi/pi-utils";
import type {
  JobReceipt,
  TerminationResult,
  TerminationStatus,
} from "farstep/protocol/jobs/gateway";
import type { JobTerminalSize } from "farstep/protocol/jobs/protocol";
import type { JobResultOptions } from "./output";
import { COMPLETION_TYPE } from "./records";
import type { RemoteJobDetails } from "./types";

export function jobPresentation(): Pick<
  ToolDefinition<Record<string, unknown>, RemoteJobDetails>,
  "renderCall" | "renderResult" | "describeCall" | "describeResult"
> {
  const renderer = createShellRenderer<unknown>({
    resolveTitle: () => "Job",
    resolveCommand: () => undefined,
  });
  const target = (args: unknown) =>
    isRecord(args)
      ? [args.action, args.job, args.step]
          .filter((value) => typeof value === "string")
          .join(" ")
      : "";
  return {
    ...renderer,
    renderCall: (args, options, theme) =>
      plainToolCard(theme, () => ({
        status: {
          ...(options.isPartial ? { icon: "pending" } : {}),
          title: "Job",
          description: target(args),
        },
      })),
    describeCall: (args: unknown) => ({
      tool: { title: "Job", target: target(args) },
    }),
  };
}

export function registerJobPresentation(api: ExtensionAPI): void {
  const renderer = createShellRenderer<Record<string, unknown>>({
    resolveTitle: () => "Job completed",
    resolveCommand: () => undefined,
  });
  api.registerMessageRenderer<RemoteJobDetails>(
    COMPLETION_TYPE,
    (message, options, theme) =>
      renderer.renderResult(
        {
          content:
            typeof message.content === "string"
              ? [{ type: "text", text: message.content }]
              : message.content,
          ...(message.details ? { details: message.details } : {}),
          isError:
            message.details?.remoteState === "unknown" ||
            (message.details?.exitCode !== undefined && message.details.exitCode !== 0),
        },
        { ...options, isPartial: false },
        theme,
      ),
  );
}

export function receiptStatus(receipt: Omit<JobReceipt, "snapshot" | "logs">): string {
  if (receipt.state !== "processed") return receipt.state;
  const evidence =
    receipt.screenChanged === undefined
      ? "screen change unavailable"
      : receipt.screenChanged
        ? "screen changed"
        : "screen unchanged";
  return `${receipt.state} (broker accepted; ${evidence}; not an application acknowledgement)`;
}

export function jobNotices(
  size: JobTerminalSize,
  showScreen: boolean | undefined,
  finishedAt: number | undefined,
  receipt: Omit<JobReceipt, "snapshot" | "logs"> | undefined,
  termination: TerminationResult["termination"] | undefined,
  deadline: TerminationStatus["deadline"],
  options: JobResultOptions,
): string[] {
  return [
    ...screenNotices(size, showScreen, options),
    ...observationNotices(options),
    ...receiptNotices(receipt),
    ...terminationNotices(termination, deadline),
    ...(finishedAt !== undefined && options.deliveredAt !== undefined
      ? [
          `Finished at ${new Date(finishedAt).toISOString()} · delivered at ${new Date(options.deliveredAt).toISOString()} · delay ${Math.max(0, options.deliveredAt - finishedAt)} ms`,
        ]
      : []),
    ...(options.notice ? [options.notice] : []),
  ];
}

function screenNotices(
  size: JobTerminalSize,
  showScreen: boolean | undefined,
  options: JobResultOptions,
): string[] {
  if (!showScreen) return [];
  const fields = [`Screen ${size.columns}x${size.rows}`];
  if (options.screenVersion !== undefined)
    fields.push(`screenVersion ${options.screenVersion}`);
  if (options.settled !== undefined)
    fields.push(options.settled ? "settled" : "unsettled");
  return [fields.join(" · ")];
}
function observationNotices(options: JobResultOptions): string[] {
  return [
    ...(options.readyTimedOut ? ["Readiness wait ended without a match"] : []),
    ...(options.waitTimedOut ? ["Observation wait ended without new output"] : []),
    ...(options.matched !== undefined
      ? [`Log pattern matched: ${options.matched}`]
      : []),
  ];
}
function receiptNotices(
  receipt: Omit<JobReceipt, "snapshot" | "logs"> | undefined,
): string[] {
  return [
    ...(receipt
      ? [
          `Action ${receipt.actionId}: ${receiptStatus(receipt)}`,
          `Receipt (may be historical): ${JSON.stringify(receipt)}`,
        ]
      : []),
    ...(receipt?.error ? [receipt.error] : []),
  ];
}
function terminationNotices(
  termination: TerminationResult["termination"] | undefined,
  deadline: TerminationStatus["deadline"],
): string[] {
  return [
    ...(termination
      ? [
          `Termination ${termination.kind}: leader ${termination.leaderExited ? "exited" : "not confirmed exited"}; children ${termination.childrenGone}`,
        ]
      : []),
    ...(deadline?.deadlineTriggeredAt !== undefined
      ? [
          `Deadline triggered at ${new Date(deadline.deadlineTriggeredAt).toISOString()}${deadline.forceSentAt === undefined ? "" : " · forced termination sent"} · children ${deadline.childrenGone}`,
        ]
      : []),
  ];
}
