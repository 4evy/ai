import { readGuide } from "@ai/core/guide/guide";
import { readText } from "@ai/core/text/text";
import type { SkyBackend } from "../../protocol/sky/execution";
import { SKYLIGHT_TOOLS } from "../names";
import { SKYLIGHT_EXAMPLES } from "./examples";
import { readLinuxApi } from "./linux/api";
import type { Guide } from "./topics";

export type { Guide } from "./topics";

const GUIDE_PLATFORMS: Readonly<Record<string, string>> = {
  linux: "linux",
  win32: "windows",
  darwin: "macos",
};

function guidePlatform(platform: string, skyBackend?: SkyBackend): string {
  if (platform === "linux" && skyBackend === "upstream") return "linux/x11";
  return Object.hasOwn(GUIDE_PLATFORMS, platform)
    ? (GUIDE_PLATFORMS[platform] ?? "macos")
    : "macos";
}

const platform = guidePlatform(process.platform);

export const INSTRUCTIONS =
  readText(new URL("./guides.md", import.meta.url), "target", {
    GUIDE_TOOL: SKYLIGHT_TOOLS.guide,
    SYNC_TOOL: SKYLIGHT_TOOLS.sync,
  }) +
  "\n\n" +
  readGuide(
    new URL(`./${platform}/instructions.md`, import.meta.url),
    SKYLIGHT_EXAMPLES,
    SKYLIGHT_TOOLS,
  );

export async function guideText(
  guide: Guide,
  targetPlatform: string,
  signal?: AbortSignal,
  referenceText?: () => Promise<string>,
  skyBackend?: SkyBackend,
) {
  signal?.throwIfAborted();
  const platform = guidePlatform(targetPlatform, skyBackend);
  const url = new URL(`./${platform}/${guide}.md`, import.meta.url);
  if (guide !== "api") return readGuide(url, SKYLIGHT_EXAMPLES, SKYLIGHT_TOOLS);
  if (platform === "linux") return readLinuxApi();
  if (!referenceText) throw new Error("Sky reference requires the selected target");
  const reference = await referenceText();
  return readGuide(
    url,
    {
      referencePath: "bundled CUA and Sky documentation on the selected target",
      reference,
    },
    SKYLIGHT_TOOLS,
  );
}
