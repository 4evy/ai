import { guideExample } from "@ai/toolkit/guide/guide";
import * as v from "valibot";
import {
  type DesktopAction,
  desktopActionSchema,
} from "../../protocol/desktop/desktop";
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

// Validate on the native Wayland surface before substituting observed points
function waylandInput(action: DesktopAction): string {
  const { input } = v.parse(desktopActionSchema, action);
  const entries = Object.entries(input).map(([key, value]) => {
    const source =
      key === "x" ? "observedX" : key === "y" ? "observedY" : JSON.stringify(value);
    return `${JSON.stringify(key)}: ${source}`;
  });
  return `{ ${entries.join(", ")} }`;
}

export const WAYLAND_EXAMPLES = {
  waylandClick: waylandInput({ method: "click", input: { x: 320, y: 240 } }),
  waylandScroll: waylandInput({
    method: "scroll",
    input: { direction: "down", pixels: 480, x: 320, y: 240 },
  }),
  waylandText: waylandInput({
    method: "type_text",
    input: { text: "replacement text", paste_key: "Control_L+v" },
  }),
  waylandSelectAll: waylandInput({
    method: "press_key",
    input: { key: "Control_L+a" },
  }),
  waylandBackspace: waylandInput({
    method: "press_key",
    input: { key: "BackSpace" },
  }),
};
