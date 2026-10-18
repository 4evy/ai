import { readText } from "@ai/core/text/text";
export const TERMINAL_KEYS = readText(new URL("./keys.md", import.meta.url), "keys");
