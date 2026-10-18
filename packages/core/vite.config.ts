import { defineConfig } from "vite";
import { runtimeConfig } from "../../tools/scripts/vite/vite.ts";

export default defineConfig(runtimeConfig("packages/core"));
