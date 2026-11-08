import { run } from "@ai/runtime/effect/effect";
import { Effect } from "effect";
import { ensureRuntimeEffect } from "./install";
import { CODEX, CUA_REPL, MACOS, MODULES, NODE, REPL, SERVICE, WAYLAND } from "./paths";

const launcher = MACOS
  ? {
      // macOS authenticates sender ancestry, keep its signed Codex parent
      command: CODEX,
      args: [
        "sandbox",
        "-c",
        'sandbox_mode="danger-full-access"',
        "--",
        NODE,
        CUA_REPL,
      ],
    }
  : { command: NODE, args: [CUA_REPL] };

export const runtimeServerEffect = Effect.fnUntraced(function* (cwd: string) {
  yield* ensureRuntimeEffect();
  const env: Record<string, string> = {
    // Farstep does not need the bundled Skylight library's app-use analytics
    NODE_REPL_DISABLE_ANALYTICS: "1",
    NODE_REPL_NODE_PATH: NODE,
    NODE_REPL_NODE_MODULE_DIRS: MODULES,
    NODE_REPL_TRUSTED_CODE_PATHS: MODULES,
    CUA_REPL_NODE_REPL_PATH: REPL,
    // Wayland keeps Farstep's monitor adapter, not upstream app/window wrappers
    CUA_REPL_ENABLED_SURFACES: WAYLAND ? "browser" : "browser,computer",
    ...(MACOS ? { CODEX_CLI_PATH: CODEX, SKY_CUA_SERVICE_PATH: SERVICE } : {}),
  };
  return {
    command: launcher.command,
    args: [...launcher.args],
    cwd,
    // Cell deadlines belong to js; only the handshake gets our 30s limit
    timeout: 0,
    env,
  };
});

export function runtimeServer(cwd: string, signal?: AbortSignal) {
  return run(runtimeServerEffect(cwd), signal);
}
