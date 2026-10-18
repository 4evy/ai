#!/usr/bin/env bun

import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempDisposableSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { attempt, run as runEffect } from "@ai/core/effect/effect";
import { errorMessage } from "@ai/core/error/error";
import { readText } from "@ai/core/text/text";
import { object, or } from "@optique/core/constructs";
import { formatMessage } from "@optique/core/message";
import { parseSync } from "@optique/core/parser";
import { argument, command, constant } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { Effect } from "effect";

type CacheImage = { cache: string; path: string };
class UsageError extends Error {}
const cacheDirectories = [
  "/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld",
  "/System/Library/dyld",
  "/private/var/db/dyld",
];

function file(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function caches(): string[] {
  return cacheDirectories.flatMap((directory) =>
    existsSync(directory)
      ? readdirSync(directory)
          .sort()
          .filter((name) => name.startsWith("dyld_shared_cache_") && !extname(name))
          .map((name) => join(directory, name))
          .filter((cache) => file(cache) && file(`${cache}.map`))
      : [],
  );
}

async function* images(cache: string): AsyncGenerator<CacheImage> {
  const stream = createReadStream(`${cache}.map`, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const path = line.trim();
      if (path.startsWith("/")) yield { cache, path };
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function matches(query: string): Promise<CacheImage[]> {
  const result: CacheImage[] = [];
  const needle = query.toLowerCase();
  for (const cache of caches())
    for await (const image of images(cache))
      if (image.path.toLowerCase().includes(needle)) result.push(image);
  return result;
}

function resolveMissing(path: string, visited = new Set<string>()): string {
  try {
    return realpathSync(path);
  } catch {
    if (visited.has(path)) throw new Error(`Symlink cycle while resolving ${path}`);
    visited.add(path);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      return resolveMissing(resolve(dirname(path), readlinkSync(path)), visited);
    const parent = dirname(path);
    return parent === path
      ? path
      : join(resolveMissing(parent, visited), basename(path));
  }
}

function expanded(query: string): string {
  const path =
    query === "~"
      ? homedir()
      : query.startsWith("~/")
        ? join(homedir(), query.slice(2))
        : query;
  // Framework binaries can be absent on disk while their symlinks still exist
  return resolveMissing(resolve(path));
}

async function findImages(query: string): Promise<CacheImage[]> {
  const result = await matches(query);
  if (result.length || !query.includes("/")) return result;
  const path = expanded(query);
  return path === query
    ? []
    : (await matches(path)).filter((image) => image.path === path);
}

function rank(query: string, image: CacheImage): number {
  return image.path === query ? 0 : basename(image.path) === query ? 1 : 2;
}

async function select(query: string): Promise<CacheImage> {
  let results = await findImages(query);
  const best = Math.min(...results.map((image) => rank(query, image)));
  results = results.filter((image) => rank(query, image) === best);
  const first = results[0];
  if (!first) throw new Error(`No shared-cache image matches ${JSON.stringify(query)}`);
  if (results.length !== 1)
    throw new Error(
      `Ambiguous image ${JSON.stringify(query)}; use a full path:\n${results
        .slice(0, 20)
        .map((image) => `  ${image.path} (${basename(image.cache)})`)
        .join("\n")}`,
    );
  return first;
}

function run(args: string[]): string {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0)
    throw new Error(`${args[0]} exited with status ${result.exitCode}`);
  return result.stdout.toString("utf8");
}

function extract(image: CacheImage): string {
  const state =
    process.env.GHIDRA_MCP_STATE ||
    join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
      "ghidra-mcp-headless",
    );
  const output = join(
    state,
    "macos",
    run(["/usr/sbin/sysctl", "-n", "kern.osversion"]).trim(),
    basename(image.cache),
  );
  const binary = join(output, image.path.replace(/^\/+/, ""));
  if (file(binary)) return binary;
  const ipsw = Bun.which("ipsw");
  if (!ipsw) throw new Error("ipsw is required: install it and add it to PATH");
  mkdirSync(dirname(binary), { recursive: true });
  using staging = mkdtempDisposableSync(join(dirname(binary), ".extract-"));
  run([
    ipsw,
    "dyld",
    "extract",
    image.cache,
    image.path,
    "--objc",
    "--output",
    staging.path,
  ]);
  const staged = join(staging.path, basename(binary));
  if (!file(staged)) throw new Error(`ipsw did not create ${staged}`);
  renameSync(staged, binary);
  return binary;
}

async function resolveImage(query: string): Promise<string> {
  let local =
    query === "~"
      ? homedir()
      : query.startsWith("~/")
        ? join(homedir(), query.slice(2))
        : query;
  if (
    existsSync(local) &&
    statSync(local).isDirectory() &&
    extname(local) === ".framework"
  )
    local = join(local, basename(local, ".framework"));
  return file(local) ? realpathSync(local) : extract(await select(query));
}

async function load(binary: string): Promise<void> {
  const host = process.env.GHIDRA_MCP_CONNECT_HOST ?? "127.0.0.1";
  const port = process.env.GHIDRA_MCP_PORT ?? "8089";
  // node:http bypasses proxy environment variables for this local MCP request
  const base = process.env.GHIDRA_MCP_URL || `http://${host}:${port}`;
  const url = new URL(`${base.replace(/\/$/, "")}/import_file`);
  const token = process.env.GHIDRA_MCP_AUTH_TOKEN;
  const body = Buffer.from(
    JSON.stringify({
      file_path: binary,
      project_folder: dirname(binary)
        .split("/")
        .map((component) => component.replace(/^\.+/, "_"))
        .join("/"),
      auto_analyze: true,
    }),
  );
  const result: unknown = await runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        const req = yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              request(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Content-Length": body.length,
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                signal,
              }),
            catch: (error) => error,
          }),
          (req) => Effect.sync(() => req.destroy()),
        );
        const response = yield* Effect.callback<IncomingMessage, Error>((resume) => {
          req.once("response", (response) => resume(Effect.succeed(response)));
          req.once("error", (error) =>
            resume(
              Effect.fail(
                new Error(
                  `Ghidra MCP is unavailable at ${base}: ${error.message}; start the ghidra-mcp user service or run ai ghidra mcp httpd`,
                ),
              ),
            ),
          );
          req.end(body);
        });
        return yield* attempt(async () => {
          const chunks: Buffer[] = [];
          const status = response.statusCode ?? 0;
          let errorBytes = 0;
          for await (const chunk of response) {
            if (status < 400) chunks.push(chunk);
            else if (errorBytes < 4096) {
              const part = chunk.subarray(0, 4096 - errorBytes);
              chunks.push(part);
              errorBytes += part.length;
            }
          }
          const text = Buffer.concat(chunks).toString("utf8");
          if (status >= 400) {
            throw new Error(`Ghidra rejected ${binary}: HTTP ${status}: ${text}`);
          }
          return JSON.parse(text);
        });
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: 1_800_000,
        orElse: () => Effect.fail(new Error("Ghidra MCP load timed out")),
      }),
    ),
  );
  if (
    !result ||
    typeof result !== "object" ||
    !("success" in result) ||
    result.success !== true
  )
    throw new Error(`Ghidra could not load ${binary}: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  try {
    if (
      process.argv
        .slice(2)
        .some((argument) => argument === "--help" || argument === "-h")
    )
      console.log(readText(new URL("./macos.md", import.meta.url), "usage"));
    else {
      if (process.platform !== "darwin")
        throw new UsageError("macOS shared caches require macOS");
      const parsed = parseSync(
        or(
          ...(["find", "extract", "load"] as const).map((action) =>
            command(
              action,
              object({ action: constant(action), query: argument(string()) }),
            ),
          ),
        ),
        process.argv.slice(2),
      );
      if (!parsed.success) throw new UsageError(formatMessage(parsed.error));
      const { action, query } = parsed.value;
      switch (action) {
        case "find":
          for (const image of await findImages(query))
            console.log(`${image.path}\t${image.cache}`);
          break;
        case "extract":
          console.log(await resolveImage(query));
          break;
        case "load":
          await load(await resolveImage(query));
          break;
      }
    }
  } catch (error) {
    console.error(`ai ghidra macos: ${errorMessage(error)}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
