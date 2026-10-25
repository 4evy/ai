import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import type {
  RenderResultContextOptions,
  ToolRenderer,
  ToolRenderResult,
} from "@oh-my-pi/pi-tui/tools/renderer";
import { isRecord } from "@oh-my-pi/pi-utils";

export interface FileDetails {
  connectionId?: string;
  path?: string;
  resolvedPath?: string;
  displayTarget?: string;
  meta?: OutputMeta;
  sha256?: string | undefined;
  bytes?: number;
  fileSize?: number;
  isDirectory?: boolean;
  totalEntries?: number;
  offset?: number;
  truncated?: boolean;
}

function remoteArgs(input: unknown, details?: FileDetails) {
  const args = isRecord(input) ? input : {};
  const path = details?.path ?? args.path;
  const connection = details?.connectionId ?? args.connection;
  // Qualified paths identify the remote machine in native file views
  const display =
    typeof path === "string"
      ? `${typeof connection === "string" ? connection : "SSH"}:${path}`
      : undefined;
  return {
    ...args,
    path:
      display === undefined
        ? undefined
        : `${display}${typeof args.selector === "string" ? `:${args.selector}` : ""}`,
    oldText: args.old_string,
    newText: args.new_string,
    // Remote offsets count directory entries, not native file line numbers
    offset: undefined,
    limit: undefined,
  };
}

// Native file renderers generate local OSC links even for qualified paths
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 hyperlink wrappers
const hyperlink = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/gu;

function remoteComponent(component: Component | undefined): Component {
  const content = component ?? new Text("", 0, 0);
  let previous: readonly string[] | undefined;
  let rows: readonly string[] = [];
  return {
    render(width) {
      const rendered = content.render(width);
      if (rendered !== previous) {
        previous = rendered;
        rows = rendered.map((line) => line.replace(hyperlink, ""));
      }
      return rows;
    },
    invalidate: () => {
      previous = undefined;
      rows = [];
      content.invalidate?.();
    },
    releaseRenderCaches: () => {
      previous = undefined;
      rows = [];
      content.releaseRenderCaches?.();
    },
  };
}

export function remoteFilePresentation<D extends FileDetails>(
  renderer: ToolRenderer<Record<string, unknown>, D>,
): Pick<
  ToolDefinition<Record<string, unknown>, D>,
  "renderCall" | "renderResult" | "describeCall" | "describeResult"
> {
  const optionsFor = (options: RenderResultContextOptions) => ({
    ...options,
    renderContext: { ...options.renderContext, editMode: "replace" },
  });
  const viewResult = (result: ToolRenderResult<D>, args: unknown) => {
    const { details: original, ...rest } = result;
    if (!original) return rest;
    const path = remoteArgs(args, original).path;
    const details = { ...original };
    delete details.resolvedPath;
    if (path !== undefined) {
      details.path = path;
      details.displayTarget = path;
    }
    if (details.meta) {
      details.meta = { ...details.meta };
      delete details.meta.source;
    }
    return {
      ...rest,
      details,
    };
  };
  return {
    renderCall: (args, options, theme) =>
      remoteComponent(
        renderer.renderCall(remoteArgs(args), optionsFor(options), theme),
      ),
    renderResult: (result, options, theme, args) =>
      remoteComponent(
        renderer.renderResult(
          viewResult(result, args),
          optionsFor(options),
          theme,
          remoteArgs(args, result.details),
        ),
      ),
    describeCall: (args, options) =>
      renderer.describeCall?.(remoteArgs(args), optionsFor(options)),
    describeResult: (result, options, args) =>
      renderer.describeResult?.(
        viewResult(result, args),
        optionsFor(options),
        remoteArgs(args, result.details),
      ),
  };
}
