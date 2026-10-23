import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import { createSkyFleet } from "farstep/client/sky/sky";
import { SKYLIGHT_TOOLS } from "farstep/skylight/names";
import { createSkylightParameters } from "farstep/skylight/schemas";
import { createSkylight } from "farstep/skylight/skylight";
import * as v from "valibot";
import { skylightPresentation } from "./presentation";
import { present } from "./runtime/result";

export default function skylight(api: ExtensionAPI) {
  const feature = createSkylight<ExtensionContext>(createSkyFleet());
  const { guideParameters } = createSkylightParameters();
  const targets: Record<string, (input: unknown) => string> = {
    [SKYLIGHT_TOOLS.guide]: (input) => {
      const parsed = v.safeParse(guideParameters, input);
      return parsed.success ? parsed.output.topic : "Loading guidance";
    },
    [SKYLIGHT_TOOLS.skylight]: (input) =>
      isRecord(input) && typeof input.title === "string"
        ? input.title
        : isRecord(input) && input.reset
          ? "Reset runtime"
          : "Run JavaScript",
  };
  for (const tool of feature.tools) {
    const target = targets[tool.name];
    api.registerTool({
      ...(target ? skylightPresentation(tool.label, target) : {}),
      ...tool,
      parameters: { ...tool.parameters },
      async execute(id, input, signal, update, context) {
        const result = await tool.execute(input, {
          id,
          signal,
          context,
          update: update ? (result) => update(present(result, tool.name)) : undefined,
        });
        return present(result, tool.name);
      },
    });
  }
  api.on("session_switch", feature.close);
  api.on("session_branch", feature.close);
  api.on("session_tree", feature.close);
  api.on("session_shutdown", feature.close);
}
