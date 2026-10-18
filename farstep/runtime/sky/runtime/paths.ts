import { homedir } from "node:os";
import { join } from "node:path";
import type { SkyBackend } from "../../../protocol/sky/execution";
import pins from "./pins.json";

export const LINUX = process.platform === "linux";
export const MACOS = process.platform === "darwin";
export const WINDOWS = process.platform === "win32";
// SSH often lacks display variables, so retain the user-service Wayland bridge
export const WAYLAND =
  LINUX &&
  process.env.XDG_SESSION_TYPE !== "x11" &&
  (process.env.XDG_SESSION_TYPE === "wayland" ||
    Boolean(process.env.WAYLAND_DISPLAY) ||
    !process.env.DISPLAY);
export const SKY_BACKEND: SkyBackend = WAYLAND ? "wayland" : "upstream";
const REFERENCE_APIS: Readonly<Record<string, string>> = {
  darwin: "window",
  win32: "window2",
};
export function referencePaths(platform: string) {
  const api = Object.hasOwn(REFERENCE_APIS, platform)
    ? REFERENCE_APIS[platform]
    : "full-desktop";
  return [
    "@oai/cua/docs/tinysky-alt-core-cua-repl.md",
    `@oai/sky/docs/sky-${api}-api.md`,
  ];
}
export const REFERENCE_PATHS = referencePaths(process.platform);
export type RuntimeArtifact = (typeof pins.artifacts)[number];

function servicePath(modules: string, platform: string, arch: string): string {
  switch (platform) {
    case "linux":
      return join(modules, "@oai/sky/bin/linux", `sky_linux_${arch}`);
    case "win32":
      return join(
        modules,
        "@oai/sky/bin/windows",
        arch === "arm64" ? "codex-computer-use-arm64.exe" : "codex-computer-use.exe",
      );
    default:
      return join(modules, "@oai/sky/Codex Computer Use.app");
  }
}

export function runtimePaths(resources: string, platform: string, arch: string) {
  const windows = platform === "win32";
  const modules = join(resources, "cua_node", windows ? "bin" : "lib", "node_modules");
  return {
    modules,
    codex: join(resources, "codex-cli/bin/codex"),
    repl: join(resources, `cua_node/bin/node_repl${windows ? ".exe" : ""}`),
    node: join(resources, `cua_node/bin/node${windows ? ".exe" : ""}`),
    cuaRepl: join(modules, "@oai/cua-repl/bin/cua-repl.mjs"),
    service: servicePath(modules, platform, arch),
  };
}
export const ARTIFACT = pins.artifacts.find(
  (artifact) =>
    artifact.platform === process.platform && artifact.arch === process.arch,
);
export const SKY_VERSION = ARTIFACT?.skyVersion ?? pins.skyVersion;
export const RUNTIME = ARTIFACT
  ? (process.env.FARSTEP_SKY_RUNTIME ??
    (process.platform !== "win32" && process.env.FARSTEP_PACKAGE_PATH
      ? join(process.env.FARSTEP_PACKAGE_PATH, "share/farstep/sky")
      : undefined) ??
    (WINDOWS
      ? join(
          process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
          "farstep/sky",
          `${pins.version}-${process.platform}-${process.arch}-${ARTIFACT.sha256}`,
        )
      : undefined))
  : undefined;
// Unsupported hosts can still load extensions; provisioning reports the error
const RESOURCES = join(RUNTIME ?? "", ARTIFACT?.resources ?? "");
const paths = runtimePaths(RESOURCES, process.platform, process.arch);
export const MODULES = paths.modules;
export const CODEX = paths.codex;
export const REPL = paths.repl;
export const NODE = paths.node;
export const CUA_REPL = paths.cuaRepl;
export const SERVICE = paths.service;
