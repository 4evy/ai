import { guideExample } from "@ai/core/guide/guide";
import { createSkylightParameters } from "../schemas";

const { guideParameters, parameters } = createSkylightParameters();

export const SKYLIGHT_EXAMPLES = {
  resetRuntime: guideExample(parameters, { reset: true }),
  startGuide: guideExample(guideParameters, { topic: "start" }),
  apiGuide: guideExample(guideParameters, { topic: "api" }),
};
