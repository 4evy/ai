import { guideExample } from "@ai/core/guide/guide";
import { createSkylightParameters } from "../schemas";

const { parameters } = createSkylightParameters();

export const SKYLIGHT_EXAMPLES = {
  resetRuntime: guideExample(parameters, { reset: true }),
};
