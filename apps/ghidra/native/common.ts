import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { windows } from "./windows.ts";

const receiptSchema = v.strictObject({
  version: v.literal(1),
  fingerprint: v.string(),
  platform: v.string(),
  architecture: v.string(),
  directory: v.string(),
});
export type Installation = v.InferOutput<typeof receiptSchema>;

export function platform() {
  if (process.platform !== "win32") throw new Error("Use Nix for Ghidra on Unix");
  return windows;
}

export function installationHome(): string {
  return resolve(
    process.env.GHIDRA_NATIVE_HOME ?? platform().home(process.env, homedir()),
  );
}

export function stateHome(): string {
  return resolve(
    process.env.GHIDRA_MCP_STATE ?? platform().state(process.env, homedir()),
  );
}

export async function installed(): Promise<Installation | undefined> {
  if (process.platform !== "win32") return undefined;
  const file = Bun.file(join(installationHome(), "installation.json"));
  if (!(await file.exists())) return undefined;
  const receipt = v.parse(receiptSchema, await file.json());
  if (receipt.platform !== process.platform || receipt.architecture !== process.arch)
    throw new Error("The native Ghidra installation was made for another host");
  return receipt;
}

export function javaHome(receipt: Installation): string {
  return join(receipt.directory, platform().javaHome);
}

export function java(receipt: Installation): string {
  return join(javaHome(receipt), "bin", `java${platform().executableSuffix}`);
}
