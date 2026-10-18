import type { BuildOptions } from "vite";

export const modes = {
  unoptimized: {
    minify: false,
    rolldownOptions: { treeshake: false, output: { minify: false } },
  },
  shaken: {
    minify: false,
    rolldownOptions: { treeshake: true, output: { minify: false } },
  },
  production: {
    minify: "oxc",
    rolldownOptions: { treeshake: true, output: { minify: true } },
  },
} satisfies Record<string, BuildOptions>;

export type Mode = keyof typeof modes;
