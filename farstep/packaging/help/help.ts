import { readFileSync } from "node:fs";

export const help = readFileSync(new URL("./help.txt", import.meta.url), "utf8");
