import { fileURLToPath } from "node:url";
import { readGuide } from "@ai/core/guide/guide";
import { waylandReference } from "../../../protocol/sky/desktop";
import { SKYLIGHT_TOOLS } from "../../names";

export function readLinuxApi() {
  return readGuide(
    new URL("./api.md", import.meta.url),
    {
      referencePath: fileURLToPath(
        new URL("../../../protocol/sky/desktop.ts", import.meta.url),
      ),
      adapterReference: JSON.stringify(waylandReference(), null, 2),
    },
    SKYLIGHT_TOOLS,
  );
}
