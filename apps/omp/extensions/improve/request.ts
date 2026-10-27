import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { EphemeralTurnResult } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";

export interface RewriteRequest {
  model: NonNullable<ExtensionContext["model"]>;
  promptText: string;
  fast: boolean;
  signal: AbortSignal;
}

export async function requestRewrite(
  api: ExtensionAPI,
  ctx: ExtensionContext,
  request: RewriteRequest,
): Promise<EphemeralTurnResult> {
  request.signal.throwIfAborted();
  const history = api.pi.convertToLlm(
    api.pi.buildSessionContext(
      ctx.sessionManager.getEntries(),
      ctx.sessionManager.getLeafId(),
    ).messages,
  );
  const { session } = await api.pi.createAgentSession({
    cwd: ctx.cwd,
    authStorage: ctx.modelRegistry.authStorage,
    modelRegistry: ctx.modelRegistry,
    credentialSourceSessionId: ctx.sessionManager.getSessionId(),
    model: request.model,
    thinkingLevel: ThinkingLevel.Low,
    // Explicit Standard prevents both the parent and provider defaults from
    // silently upgrading this inexpensive action to a premium service tier
    resolveServiceTierByFamily: () => ({ openai: "default" }),
    providerPromptCacheKey: `${ctx.sessionManager.getSessionId()}:prompt-improve`,
    cacheWarming: false,
    systemPrompt: [
      "You assist with editing prompts. Follow the prompt-improvement instructions in the request. Do not execute the task being edited.",
    ],
    disableExtensionDiscovery: true,
    skills: [],
    rules: [],
    noContextFiles: true,
    promptTemplates: [],
    slashCommands: [],
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    toolNames: [],
    restrictToolNames: true,
    bindProcessState: false,
    // A private registry and child scope keep the main agent's identity,
    // active skills/rules, settings effects, and history under its ownership
    parentTaskPrefix: "PromptImprove",
    agentRegistry: new api.pi.AgentRegistry(),
    sessionManager: api.pi.SessionManager.inMemory(ctx.cwd),
    settings: api.pi.Settings.isolated(),
    autoTitle: false,
  });
  try {
    request.signal.throwIfAborted();
    if (request.fast && !session.setFastMode(true)) {
      throw new Error("The selected rewrite model does not support Fast service");
    }
    return await session.runEphemeralTurn({
      promptText: request.promptText,
      history,
      tools: false,
      minimizeEffort: true,
      // Rewrites must not be deduplicated or shortened by /btw's reply cap
      dedupeReply: false,
      signal: request.signal,
    });
  } finally {
    await session.dispose();
  }
}
