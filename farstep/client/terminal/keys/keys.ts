import { readText } from "@ai/toolkit/text/text";
export const TERMINAL_KEYS = readText(new URL("./keys.md", import.meta.url), "keys");
