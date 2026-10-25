import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const PROVIDER = "openai-codex";
const MODEL = "gpt-6-luna";

export default function quick(api: ExtensionAPI) {
  let previousModel: ExtensionContext["model"];

  api.on("session_switch", async (event, ctx) => {
    const previous = previousModel;
    previousModel = undefined;
    if (
      event.reason === "new" &&
      previous &&
      ctx.model?.provider === PROVIDER &&
      ctx.model.id === MODEL
    ) {
      await api.setModel(previous, { ephemeral: true });
    }
  });

  api.registerCommand("quick", {
    description: "Start a fresh GPT-6 Luna chat without changing the startup model",
    handler: async (_args, ctx) => {
      const model = ctx.models
        .list()
        .find((candidate) => candidate.provider === PROVIDER && candidate.id === MODEL);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
        ctx.ui.notify(`Quick model is unavailable: ${PROVIDER}/${MODEL}`, "error");
        return;
      }
      const previous = previousModel ?? ctx.model;

      await ctx.newSession({
        setup: async (sessionManager) => {
          // Command contexts snapshot the model before newSession runs hooks
          // Seed the normal resume model before recording the ephemeral switch
          if (previous) {
            sessionManager.appendModelChange(`${previous.provider}/${previous.id}`);
          }
          if (await api.setModel(model, { ephemeral: true })) {
            previousModel = previous;
          } else {
            ctx.ui.notify("Could not select GPT-6 Luna for the new chat", "error");
          }
        },
      });
    },
  });
}
