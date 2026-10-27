export const GUIDE_TOPICS = [
  "start",
  "actions",
  "browser",
  "screenshots",
  "recovery",
  "api",
] as const;
export type Guide = (typeof GUIDE_TOPICS)[number];
