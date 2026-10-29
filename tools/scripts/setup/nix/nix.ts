import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "@ai/runtime/effect/effect";
import { executeCommand } from "@ai/runtime/effect/process/process";
import { objectSchema, recordSchema } from "@ai/values/schema/input";
import * as v from "valibot";

const profileSchema = v.pipe(
  v.string(),
  v.parseJson(),
  objectSchema(
    v.object({
      elements: v.optional(
        recordSchema(
          v.string(),
          objectSchema(
            v.object({
              attrPath: v.optional(v.string()),
              originalUrl: v.optional(v.string()),
            }),
          ),
        ),
        () => ({}),
      ),
    }),
  ),
);

async function command(args: string[], capture = false): Promise<string> {
  const result = await run(
    executeCommand(args, { stdout: capture ? "pipe" : "inherit", stderr: "inherit" }),
  );
  if (result.code !== 0) throw new Error(`Nix failed (${result.code})`);
  return result.stdout;
}

export async function installNixPackage(
  name: "ai-tools" | "ghidra-mcp",
  update: boolean,
  dryRun: boolean,
): Promise<void> {
  const checkout = fileURLToPath(new URL("../../../../", import.meta.url));
  const source = [process.env.AI_TOOLS_REPO, process.cwd(), checkout].find(
    (directory) =>
      directory &&
      existsSync(`${directory}/flake.nix`) &&
      existsSync(`${directory}/tools/nix/flake/flake.nix`),
  );
  const flake =
    process.env.AI_TOOLS_FLAKE ??
    (source ? `path:${resolve(source)}` : "github:4evy/ai");
  const installable = `${flake}#${name}`;
  const nix = process.env.AI_TOOLS_NIX ?? "nix";
  if (dryRun) {
    console.log(JSON.stringify({ manager: "nix", installable, update }));
    return;
  }
  const profile = v.parse(
    profileSchema,
    await command([nix, "profile", "list", "--json"], true),
  );
  const candidates = Object.entries(profile.elements).filter(([, entry]) =>
    entry.attrPath?.endsWith(`.${name}`),
  );
  const existing =
    candidates.find(([, entry]) => entry.originalUrl === flake) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!existing && candidates.length > 1)
    throw new Error(
      `Multiple ${name} profile entries exist. Set AI_TOOLS_FLAKE to select their source`,
    );
  if (existing) {
    if (update) await command([nix, "profile", "upgrade", existing[0], "--refresh"]);
    else console.log(`${name}: already installed in the Nix profile`);
  } else if (update) {
    throw new Error(
      `No ${name} entry exists in this Nix profile. Update your declarative Nix configuration, or run ai setup for a profile installation`,
    );
  } else await command([nix, "profile", "add", installable]);
}
