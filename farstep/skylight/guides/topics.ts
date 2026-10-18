export const GUIDE_TOPICS = [
  "start",
  "actions",
  "screenshots",
  "recovery",
  "api",
] as const;
export type Guide = (typeof GUIDE_TOPICS)[number];
