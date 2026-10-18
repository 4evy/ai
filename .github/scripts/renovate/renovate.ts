import { group, setFailed, setSecret } from "@actions/core";
import { exec } from "@actions/exec";
import { root } from "../run/run";
import { prepareSkyFeeds } from "./sky";

try {
  const token = process.env.RENOVATE_TOKEN;
  if (!token)
    throw new Error(
      "Set RENOVATE_TOKEN to a bot token with contents, pull requests, issues, and workflows write access",
    );
  if (process.env.GITHUB_ACTIONS === "true") setSecret(token);
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
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      },
    );
  });
} catch (error) {
  setFailed(error instanceof Error ? error.message : String(error));
}
