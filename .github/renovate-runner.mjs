const skyFeedURL = process.env.RENOVATE_SKY_FEED_URL;
if (!skyFeedURL)
  throw new Error("The Actions runner must prepare the Windows Sky checksum feed");

export default {
  platform: "github",
  repositories: process.env.GITHUB_REPOSITORY ? [process.env.GITHUB_REPOSITORY] : [],
  onboarding: false,
  requireConfig: "required",
  binarySource: "global",
  allowedCommands: ["^bash tools/scripts/renovate/artifacts\\.sh$"],
  customEnvVariables: {
    GH_TOKEN: process.env.RENOVATE_TOKEN ?? "",
  },
  hostRules: [{ matchHost: skyFeedURL }],
  customDatasources: {
    "chatgpt-windows": {
      defaultRegistryUrlTemplate: `${skyFeedURL}{{{packageName}}}.json`,
    },
  },
};
