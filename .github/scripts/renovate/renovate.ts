import { group, setFailed, setSecret } from "@actions/core";
import { exec } from "@actions/exec";
import { root } from "../run/run";
import { prepareSkyFeeds } from "./sky";

try {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw new Error("Run Renovate in GitHub Actions to use github-actions[bot]");
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("The Renovate workflow must provide GITHUB_TOKEN");
  setSecret(token);
  using _skyFeeds = await group("Check mutable Windows Sky archives", prepareSkyFeeds);
  await group("Run Renovate with the repository toolchain", async () => {
    await exec(
      "nix",
      [
        "shell",
        "--inputs-from",
        ".",
        "nixpkgs#renovate",
        "nixpkgs#gh",
        "--command",
        "nix",
        "develop",
        "--command",
        "renovate",
      ],
      {
        cwd: root,
        env: Object.fromEntries(
          Object.entries({
            ...process.env,
            RENOVATE_TOKEN: token,
            GH_TOKEN: token,
          }).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      },
    );
  });
} catch (error) {
  setFailed(error instanceof Error ? error.message : String(error));
}
