type SkyRequest = {
  type: string;
  method?: string;
  args?: unknown[];
};
type SkyRpc = (input: SkyRequest) => Promise<unknown>;
type FullObservation = {
  kind: "full";
  snapshotId: string;
  baseline: null;
  surface: string;
  target: unknown;
};

// Runs in the trusted service host, never in the Node REPL's read-only membrane
function desktopHandler(upstream: SkyRpc, generation: string): SkyRpc {
  let sequence = 0;
  let announced = false;
  function metadata(surface: string, target: unknown): FullObservation {
    return {
      kind: "full",
      snapshotId: `${generation}:${++sequence}`,
      baseline: null,
      surface,
      target,
    };
  }
  function render(observation: FullObservation, text: string) {
    const note = announced
      ? ""
      : "Farstep app observations override bundled default-diff guidance: " +
        "each full snapshot replaces the previous tree. Discard earlier indices.\n";
    announced = true;
    return `${note}Observation: ${JSON.stringify(observation)}\n${text}`;
  }
  return async (request) => {
    if (request.type !== "execute" || !Array.isArray(request.args))
      return upstream(request);
    const input = request.args?.[0];
    const appState = request.method === "get_app_state";
    const windowState = request.method === "get_window_state";
    if (!appState && !windowState) return upstream(request);
    const options =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? input
        : undefined;
    const canonical =
      appState && options
        ? {
            ...request,
            args: [{ ...options, disableDiff: true }, ...request.args.slice(1)],
          }
        : request;
    let result: unknown;
    try {
      // Every original policy, consent and native guard still runs upstream
      result = await upstream(canonical);
    } catch (error) {
      if (
        !appState ||
        error === null ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== -10018
      )
        throw error;
      let inventory: unknown[] | undefined;
      try {
        const apps = await upstream({ type: "execute", method: "list_apps", args: [] });
        if (Array.isArray(apps)) inventory = apps;
      } catch {
        // Preserve the original ambiguity even if inventory is unavailable
      }
      const target = options && "app" in options ? options.app : undefined;
      const matches = inventory?.filter(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          (("id" in entry && entry.id === target) ||
            ("displayName" in entry && entry.displayName === target)),
      );
      const detail = matches?.length ? matches : inventory;
      throw new Error(
        `Ambiguous app ${JSON.stringify(target)}. No app was selected. ` +
          "Use cua.listApps() to inspect installed/running matches, then call " +
          "cua.getApp() with the intended .app's absolute full path. " +
          "For a development build, use that build's .app path, not its shared " +
          "bundle ID or executable. " +
          (detail
            ? `App inventory (upstream does not expose paths): ${JSON.stringify(detail)}`
            : "App inventory was unavailable."),
        { cause: error },
      );
    }
    if (result === null || typeof result !== "object") return result;
    if (appState && "text" in result && typeof result.text === "string") {
      const observation = metadata("mac", "app" in result ? result.app : undefined);
      return {
        ...result,
        observation,
        text: render(observation, result.text),
      };
    }
    if (!windowState) return result;
    const window = "window" in result ? result.window : undefined;
    if (
      "accessibility" in result &&
      result.accessibility !== null &&
      typeof result.accessibility === "object" &&
      "tree" in result.accessibility &&
      typeof result.accessibility.tree === "string"
    ) {
      const observation = metadata("windows", window);
      return {
        ...result,
        observation,
        accessibility: {
          ...result.accessibility,
          tree: render(observation, result.accessibility.tree),
        },
      };
    }
    if ("ax_tree" in result) {
      // Linux recreates its tree renderer inside the VM, so metadata stays on
      // the wire result rather than being injected into fictitious UI nodes
      const query = options && "query" in options ? options.query : undefined;
      return {
        ...result,
        observation: metadata("linux", { window, query }),
      };
    }
    return result;
  };
}

export function desktopServiceSource(upstreamModule: string): string {
  return [
    'import { randomUUID } from "node:crypto";',
    `import { handleRpc as upstream } from ${JSON.stringify(upstreamModule)};`,
    `export const handleRpc = (${desktopHandler.toString()})(upstream, randomUUID());`,
  ].join("\n");
}

type BrowserRequest = {
  method: string;
  params?: {
    type?: string;
    content?: string;
    browser_id?: string;
    tab_id?: string;
    disable_diffing?: boolean;
  };
};
type BrowserRpc = (request: BrowserRequest) => Promise<unknown>;

// The pinned browser AX wire contract has an explicit full-mode request flag
function browserHandler(upstream: BrowserRpc, generation: string): BrowserRpc {
  let sequence = 0;
  let announced = false;
  return async (request) => {
    const command = request.params;
    if (
      request.method !== "execute" ||
      command?.type !== "tab_ax_get_state" ||
      (command.content !== "axState" && command.content !== "axStateAndScreenshot")
    )
      return upstream(request);
    const result = await upstream({
      ...request,
      params: { ...command, disable_diffing: true },
    });
    if (
      result === null ||
      typeof result !== "object" ||
      !("state" in result) ||
      typeof result.state !== "string"
    )
      return result;
    const observation = {
      kind: "full",
      snapshotId:
        "snapshotId" in result && typeof result.snapshotId === "string"
          ? result.snapshotId
          : `${generation}:${++sequence}`,
      baseline: null,
      surface: "browser-ax",
      target: { browserId: command.browser_id, tabId: command.tab_id },
    };
    const note = announced
      ? ""
      : "Farstep browser AX observations override bundled default-diff guidance: " +
        "each full snapshot replaces the previous tree. Discard earlier indices.\n";
    announced = true;
    return {
      ...result,
      observation,
      state: `${note}Observation: ${JSON.stringify(observation)}\n${result.state}`,
    };
  };
}

export function browserServiceSource(upstreamModule: string): string {
  return [
    'import { randomUUID } from "node:crypto";',
    `import { handleRpc as upstream } from ${JSON.stringify(upstreamModule)};`,
    `export { classifyError } from ${JSON.stringify(upstreamModule)};`,
    `export const handleRpc = (${browserHandler.toString()})(upstream, randomUUID());`,
  ].join("\n");
}
