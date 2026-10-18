import type { SkyClient } from "@oai/sky";
import type { DesktopAction } from "farstep/protocol/desktop/desktop";
import {
  DESKTOP_METHODS as SHARED_DESKTOP_METHODS,
  INPUT_METHODS as SHARED_INPUT_METHODS,
} from "farstep/protocol/sky/desktop";

export {
  screenshotOptionsSchema,
  textResultSchema,
} from "farstep/protocol/sky/desktop";

type UpstreamLinux = Extract<SkyClient, { target: "linux" }>;

export const INPUT_METHODS =
  SHARED_INPUT_METHODS satisfies readonly (keyof UpstreamLinux &
    DesktopAction["method"])[];
export const DESKTOP_METHODS = [
  ...SHARED_DESKTOP_METHODS,
] satisfies (keyof UpstreamLinux)[];
