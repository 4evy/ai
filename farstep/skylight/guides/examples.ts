import { guideExample } from "@ai/toolkit/guide/guide";
import { createSkylightParameters } from "../schemas";

const { guideParameters, parameters } = createSkylightParameters();

export const SKYLIGHT_EXAMPLES = {
  resetRuntime: guideExample(parameters, { reset: true }),
  startGuide: guideExample(guideParameters, { topic: "start" }),
  browserGuide: guideExample(guideParameters, { topic: "browser" }),
  browserInventory: guideExample(parameters, {
    code: "var browserInventory = await cua.listBrowsers();",
  }),
  browserTabs: guideExample(
    parameters,
    {
      code: [
        "var browser = await cua.getBrowser({ id: observedBrowserId });",
        "var tabs = await cua.listTabs({ browser: browser.browserId });",
      ].join("\n"),
    },
    { multiline: true },
  ),
  browserTab: guideExample(parameters, {
    code: "var tab = await cua.getTab(observedTabId, { browser: browser.browserId });",
  }),
  apiGuide: guideExample(guideParameters, { topic: "api" }),
};
